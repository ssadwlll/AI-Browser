"""
将 Qwen3-Embedding-0.6B 转换为 ONNX 格式
输出: models/Qwen3-Embedding-0.6B-ONNX/model.onnx

策略: 强制 eager attention（非 SDPA），避免 vmap 导致的追踪失败
""" 
import os
import sys
sys.path.insert(0, r'C:\short_pkgs')
import json
import torch
from sentence_transformers import SentenceTransformer

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "Qwen3-Embedding-0.6B")
OUT_DIR = MODEL_DIR + "-ONNX"
os.makedirs(OUT_DIR, exist_ok=True)

print(f"加载模型: {MODEL_DIR}")
model = SentenceTransformer(MODEL_DIR, device='cpu', trust_remote_code=True)
dim = model.get_sentence_embedding_dimension()
print(f"Embedding 维度: {dim}")

transformer = model._first_module()
auto_model = transformer.auto_model  # Qwen3Model

# 强制 eager attention，避免 SDPA + vmap 导致的追踪失败
auto_model.config._attn_implementation = "eager"
# 也清掉 torch 的 SDPA 后端，双重保证
if hasattr(torch.backends.cuda, 'enable_flash_sdp'):
    torch.backends.cuda.enable_flash_sdp(False)

print(f"模型类型: {type(auto_model).__name__} (attention={auto_model.config._attn_implementation})")

# 短序列导出
dummy_input_ids = torch.randint(0, 1000, (1, 16), dtype=torch.long)
dummy_attention_mask = torch.ones((1, 16), dtype=torch.long)
onnx_path = os.path.join(OUT_DIR, "model.onnx")

class EmbeddingWrapper(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        return self.model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            use_cache=False,
        ).last_hidden_state

wrapper = EmbeddingWrapper(auto_model)
wrapper.eval()

# 先跑一次预热确认能通过
with torch.no_grad():
    test_out = wrapper(dummy_input_ids, dummy_attention_mask)
    print(f"预热输出 shape: {test_out.shape}")

print(f"导出 ONNX: {onnx_path}")
torch.onnx.export(
    wrapper,
    (dummy_input_ids, dummy_attention_mask),
    onnx_path,
    input_names=['input_ids', 'attention_mask'],
    output_names=['last_hidden_state'],
    dynamic_axes={
        'input_ids': {0: 'batch', 1: 'sequence'},
        'attention_mask': {0: 'batch', 1: 'sequence'},
        'last_hidden_state': {0: 'batch', 1: 'sequence'},
    },
    opset_version=17,
    do_constant_folding=True,
    dynamo=False,
)

print(f"ONNX 模型已导出: {onnx_path}")
print(f"文件大小: {os.path.getsize(onnx_path) / 1024 / 1024:.1f} MB")

# 复制 tokenizer 文件
import shutil
for f in ['tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'config.json']:
    src = os.path.join(MODEL_DIR, f)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(OUT_DIR, f))
        print(f"复制: {f}")

config = {
    'model_type': 'qwen3',
    'embedding_dim': dim,
    'max_seq_length': 8192,
    'pooling': 'lasttoken',
    'normalize': True,
}
with open(os.path.join(OUT_DIR, 'onnx_config.json'), 'w') as f:
    json.dump(config, f, indent=2)

print(f"\n完成! ONNX 模型位于: {OUT_DIR}")
