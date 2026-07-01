"""下载 Qwen3-Embedding-0.6B 模型 - 使用 hf-mirror.com 镜像"""
import os
from huggingface_hub import snapshot_download

MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
TARGET_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "Qwen3-Embedding-0.6B")

os.makedirs(TARGET_DIR, exist_ok=True)

print(f"下载模型: {MODEL_ID}")
print(f"目标目录: {TARGET_DIR}")
print("通过 hf-mirror.com 镜像下载...")

snapshot_download(
    repo_id=MODEL_ID,
    local_dir=TARGET_DIR,
    endpoint="https://hf-mirror.com",
    resume_download=True,
    max_workers=4,
)

print(f"\n下载完成: {TARGET_DIR}")
