"""下载 all-MiniLM-L6-v2 到 models 目录 (通过 hf-mirror)"""
import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from huggingface_hub import snapshot_download

MODEL_ID = "Xenova/all-MiniLM-L6-v2"
TARGET_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "all-MiniLM-L6-v2")
os.makedirs(TARGET_DIR, exist_ok=True)

print(f"下载 {MODEL_ID} → {TARGET_DIR}")
snapshot_download(
    repo_id=MODEL_ID,
    local_dir=TARGET_DIR,
    local_dir_use_symlinks=False,
)
total = sum(os.path.getsize(os.path.join(r,f)) for r,d,fs in os.walk(TARGET_DIR) for f in fs)
print(f"完成! 总大小: {total / 1024 / 1024:.1f} MB")
