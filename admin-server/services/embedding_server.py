"""
Qwen3-Embedding-0.6B 本地 embedding 服务
启动: python embedding_server.py --port 9091
"""
import sys
import json
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
from sentence_transformers import SentenceTransformer

MODEL_PATH = None
MODEL = None


class EmbeddingHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 安静模式

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'model': str(MODEL_PATH)})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/embed':
            self._json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            texts = body.get('texts', [])
            if isinstance(texts, str):
                texts = [texts]
            if not texts:
                self._json(400, {'error': 'texts is required'})
                return

            with torch.no_grad():
                embeddings = MODEL.encode(texts, normalize_embeddings=True)

            # sentence-transformers 默认返回 float32，这里转 float32 list
            result = []
            for emb in embeddings:
                result.append(emb.tolist() if hasattr(emb, 'tolist') else list(emb))

            self._json(200, {'embeddings': result})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=9091)
    parser.add_argument('--model', type=str,
                        default='models/Qwen3-Embedding-0.6B')
    args = parser.parse_args()

    import os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    MODEL_PATH = os.path.join(base, args.model)

    print(f'[Embedding] 加载模型: {MODEL_PATH}')
    MODEL = SentenceTransformer(
        MODEL_PATH,
        device='cpu',
        trust_remote_code=True,
    )
    dim = MODEL.get_sentence_embedding_dimension()
    print(f'[Embedding] 模型加载完成, 维度: {dim}')

    server = HTTPServer(('127.0.0.1', args.port), EmbeddingHandler)
    print(f'[Embedding] 服务启动: http://127.0.0.1:{args.port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[Embedding] 服务已停止')
        server.server_close()
