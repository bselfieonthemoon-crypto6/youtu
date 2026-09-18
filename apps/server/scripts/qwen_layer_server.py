"""Loomic Qwen-Image-Layered sidecar. Uses explicitly supplied LOCAL weights only.

No automatic model download, no URL image fetch, no paid provider fallback.
Launch only on an operator-selected CUDA host. See docs/qwen-layer-backend.md.
"""
import argparse
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "Qwen/Qwen-Image-Layered"
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
MAX_REQUEST = 42 * 1024 * 1024
MAX_RESPONSE = 64 * 1024 * 1024


class LayerError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def load_local_pipeline(model_dir):
    folder = Path(model_dir).resolve(strict=True)
    index = json.loads((folder / "model_index.json").read_text(encoding="utf8"))
    if index.get("_class_name") != "QwenImageLayeredPipeline":
        raise RuntimeError("The local folder is not a QwenImageLayeredPipeline package.")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    from diffusers import QwenImageLayeredPipeline
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("This sidecar requires an operator-selected BF16 CUDA GPU; CPU fallback is disabled.")
    pipeline = QwenImageLayeredPipeline.from_pretrained(str(folder), torch_dtype=torch.bfloat16, local_files_only=True)
    pipeline = pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)

    def infer(image, count, seed):
        with torch.inference_mode():
            # Diffusers already removes the conditioning frame; do not drop layer 0 again.
            return pipeline(image=image, generator=torch.Generator(device="cuda").manual_seed(seed),
                            layers=count, resolution=640, num_inference_steps=50,
                            true_cfg_scale=4.0, negative_prompt=" ", cfg_normalize=True,
                            use_en_prompt=True, num_images_per_prompt=1).images[0]
    return infer


class LayerProcessor:
    def __init__(self, inference, cache_dir):
        self.inference = inference
        self.cache = Path(cache_dir).resolve()
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.Lock()

    def process(self, body, idempotency_key):
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 25_000_000
        expected = {"protocol_version", "request_id", "model_id", "source_sha256", "image_base64", "layers", "resolution", "seed"}
        if not isinstance(body, dict) or set(body) != expected:
            raise LayerError("Invalid layer request fields.")
        request_id = body.get("request_id")
        count, seed = body.get("layers"), body.get("seed")
        if not isinstance(request_id, str) or not UUID.fullmatch(request_id) or idempotency_key != request_id:
            raise LayerError("Invalid idempotency key.")
        if body.get("protocol_version") != 1 or body.get("model_id") != MODEL or body.get("resolution") != 640:
            raise LayerError("Unsupported model/protocol/resolution.")
        if type(count) is not int or not 2 <= count <= 8 or type(seed) is not int or not 0 <= seed < 2**31:
            raise LayerError("Invalid layer count or seed.")
        try:
            raw = base64.b64decode(body["image_base64"], validate=True)
        except Exception:
            raise LayerError("Invalid source image encoding.") from None
        if not raw or len(raw) > 30 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != body.get("source_sha256"):
            raise LayerError("Invalid source image hash or size.")
        try:
            original = Image.open(io.BytesIO(raw))
            if original.format != "PNG" or original.width * original.height > 25_000_000:
                raise ValueError("source budget")
            image = original.convert("RGBA")
        except Exception:
            raise LayerError("Invalid source PNG or dimensions.") from None
        fingerprint = hashlib.sha256(json.dumps({k: v for k, v in body.items() if k != "image_base64"}, sort_keys=True).encode()).hexdigest()
        output = self.cache / f"{request_id}.json"
        marker = self.cache / f"{request_id}.pending"
        if not self.lock.acquire(blocking=False):
            raise LayerError("The model is busy; no additional inference was started.", 429)
        try:
            if marker.exists():
                if marker.read_text(encoding="ascii") != fingerprint:
                    raise LayerError("This task ID belongs to different input.", 409)
                if output.exists():
                    data = output.read_bytes()
                    if len(data) > MAX_RESPONSE:
                        raise LayerError("Stored output exceeds the response limit.")
                    return json.loads(data)
                # A prior process may have generated data before dying. Never automatically
                # repeat an uncertain expensive inference, even after a server restart.
                raise LayerError("Previous inference is incomplete; operator recovery is required without automatic retry.", 409)
            with marker.open("x", encoding="ascii") as saved:
                saved.write(fingerprint)
                saved.flush()
                os.fsync(saved.fileno())
            layers = self.inference(image, count, seed)
            if len(layers) != count:
                raise LayerError("The model did not return the requested number of layers.")
            encoded, width, height, transparent = [], None, None, False
            for index, layer in enumerate(layers):
                if layer.mode != "RGBA" or layer.width * layer.height > 25_000_000:
                    raise LayerError("The model did not return RGBA layers.")
                if width is None:
                    width, height = layer.size
                if layer.size != (width, height):
                    raise LayerError("Layer dimensions differ.")
                minimum, maximum = layer.getchannel("A").getextrema()
                if maximum == 0:
                    raise LayerError("The model returned an empty layer.")
                transparent |= minimum < 255
                buffer = io.BytesIO()
                layer.save(buffer, format="PNG")
                encoded.append({"index": index, "png_base64": base64.b64encode(buffer.getvalue()).decode("ascii")})
            if not transparent:
                raise LayerError("The output has no transparent layers.")
            packet = {"protocol_version": 1, "request_id": request_id, "model_id": MODEL,
                      "source_sha256": body["source_sha256"], "order": "back-to-front",
                      "width": width, "height": height, "layers": encoded}
            result = json.dumps(packet, separators=(",", ":")).encode()
            if len(result) > MAX_RESPONSE:
                raise LayerError("Layer output exceeds the response limit.")
            with tempfile.NamedTemporaryFile(dir=self.cache, prefix=f"{request_id}-", suffix=".tmp", delete=False) as temp:
                temp.write(result)
                temp.flush()
                os.fsync(temp.fileno())
                temp_path = Path(temp.name)
            temp_path.replace(output)
            return packet
        finally:
            self.lock.release()


def make_handler(processor, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Do not log image data, source addresses, auth or user content.

        def authorized(self):
            actual = self.headers.get("Authorization", "")
            return not token or hmac.compare_digest(actual, "Bearer " + token)

        def reply(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The durable packet remains available for the same task ID.

        def do_GET(self):
            if not self.authorized():
                return self.reply(401, {"error": "Unauthorized"})
            if self.path != "/health":
                return self.reply(404, {"error": "Not found"})
            self.reply(200, {"protocol_version": 1, "model_id": MODEL, "model_loaded": True, "idempotency": True})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {"error": "Unauthorized"})
            if self.path != "/v1/layers":
                return self.reply(404, {"error": "Not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_REQUEST:
                    raise LayerError("Request exceeds the limit.", 413)
                self.connection.settimeout(30)
                body = json.loads(self.rfile.read(length))
                self.reply(200, processor.process(body, self.headers.get("Idempotency-Key")))
            except LayerError as error:
                self.reply(error.status, {"error": str(error)})
            except (ValueError, TimeoutError):
                self.reply(400, {"error": "Invalid request"})
            except Exception:
                self.reply(503, {"error": "Layer inference failed; no automatic fallback or retry."})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, help="Existing complete local Qwen-Image-Layered weights; never downloaded")
    parser.add_argument("--cache-dir", required=True, help="Private persistent result cache, outside web-served directories")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8875)
    args = parser.parse_args()
    token = os.environ.get("LOOMIC_QWEN_LAYER_TOKEN", "").strip()
    if args.host != "127.0.0.1" and len(token) < 24:
        parser.error("Non-loopback binding requires LOOMIC_QWEN_LAYER_TOKEN with at least 24 characters.")
    inference = load_local_pipeline(args.model_dir)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(LayerProcessor(inference, args.cache_dir), token))
    print("Qwen-Image-Layered sidecar ready; local weights loaded, no automatic downloads.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
