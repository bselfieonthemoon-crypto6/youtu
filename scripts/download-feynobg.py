from pathlib import Path

from huggingface_hub import snapshot_download


root = Path(__file__).resolve().parents[1]
path = snapshot_download(
    repo_id="feyninc/FeyNobg",
    local_dir=root / "models" / "feynobg",
    allow_patterns=["*.json", "*.safetensors", "README.md", "LICENSE*"],
)
print(path)

lama_path = snapshot_download(
    repo_id="sapienkit/LaMa-ONNX",
    local_dir=root / "models" / "lama",
    allow_patterns=["*.onnx", "README.md", "LICENSE*"],
)
print(lama_path)

sam_path = snapshot_download(
    repo_id="facebook/sam2.1-hiera-tiny",
    local_dir=root / "models" / "sam2.1-hiera-tiny",
    allow_patterns=["*.json", "*.safetensors", "LICENSE*"],
)
print(sam_path)
