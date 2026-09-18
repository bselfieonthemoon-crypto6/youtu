"""Sidecar protocol tests using synthetic RGBA layers; never imports/loads Torch weights."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from PIL import Image
from qwen_layer_server import LayerProcessor, LayerError, MODEL, load_local_pipeline


class QwenSidecarTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="loomic-qwen-protocol-")
        self.addCleanup(self.folder.cleanup)
        self.layers = [Image.new("RGBA", (8, 6), (index, 50, 70, 255 if index == 0 else 128)) for index in range(4)]
        self.inference = Mock(return_value=self.layers)
        self.processor = LayerProcessor(self.inference, self.folder.name)
        raw = io.BytesIO()
        Image.new("RGBA", (8, 6), (1, 2, 3, 255)).save(raw, "PNG")
        self.request = {"protocol_version": 1, "request_id": "11111111-2222-4333-8444-555555555555",
                        "model_id": MODEL, "source_sha256": hashlib.sha256(raw.getvalue()).hexdigest(),
                        "image_base64": base64.b64encode(raw.getvalue()).decode(), "layers": 4, "resolution": 640, "seed": 777}

    def test_rgba_layers_are_saved_in_order_and_replayed_after_restart(self):
        result = self.processor.process(self.request, self.request["request_id"])
        self.assertEqual(result["model_id"], MODEL)
        self.assertEqual(result["order"], "back-to-front")
        self.assertEqual([layer["index"] for layer in result["layers"]], [0, 1, 2, 3])
        reconstructed = LayerProcessor(self.inference, self.folder.name)
        self.assertEqual(reconstructed.process(self.request, self.request["request_id"]), result)
        self.inference.assert_called_once()

    def test_same_task_id_cannot_change_inference_options(self):
        self.processor.process(self.request, self.request["request_id"])
        self.request["layers"] = 3
        with self.assertRaises(LayerError):
            self.processor.process(self.request, self.request["request_id"])
        self.inference.assert_called_once()

    def test_interrupted_inference_is_not_automatically_repeated(self):
        self.inference.side_effect = RuntimeError("simulated worker crash")
        with self.assertRaises(RuntimeError):
            self.processor.process(self.request, self.request["request_id"])
        self.inference.side_effect = None
        restarted = LayerProcessor(self.inference, self.folder.name)
        with self.assertRaisesRegex(LayerError, "operator recovery"):
            restarted.process(self.request, self.request["request_id"])
        self.inference.assert_called_once()

    def test_mismatched_source_hash_and_wrong_model_are_rejected_before_inference(self):
        for key, value in [("source_sha256", "bad"), ("model_id", "BiRefNet"), ("layers", 100), ("request_id", "../../outside")]:
            request = {**self.request, key: value}
            with self.assertRaises(LayerError):
                self.processor.process(request, request["request_id"])
        self.inference.assert_not_called()

    def test_opaque_empty_or_wrong_count_output_is_not_saved_as_success(self):
        for bad in [self.layers[:2], [Image.new("RGBA", (8, 6), (1, 2, 3, 255))] * 4, [Image.new("RGBA", (8, 6), (0, 0, 0, 0))] * 4]:
            with tempfile.TemporaryDirectory(prefix="loomic-qwen-invalid-") as folder:
                processor = LayerProcessor(Mock(return_value=bad), folder)
                with self.assertRaises(LayerError):
                    processor.process(self.request, self.request["request_id"])
                self.assertEqual(list(Path(folder).glob("*.json")), [])

    def test_wrong_local_model_folder_fails_before_importing_or_downloading(self):
        (Path(self.folder.name) / "model_index.json").write_text(json.dumps({"_class_name": "BiRefNet"}), encoding="utf8")
        with self.assertRaisesRegex(RuntimeError, "not a Qwen"):
            load_local_pipeline(self.folder.name)


if __name__ == "__main__":
    unittest.main()
