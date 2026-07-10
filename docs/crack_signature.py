#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
anti-bot-demo 签名破解脚本

签名算法：
  signature = HMAC-SHA256(key, path + body + timestamp + nonce)
  key = baseKey + salt
  baseKey = "anti-bot-demo-secret-2026"
  salt = 从 /api/challenge 获取

参数说明：
  - path: "/api/data"
  - body: JSON字符串，如 {"action":"query","index":5,"timestamp":xxx}
  - timestamp: 毫秒时间戳字符串
  - nonce: 随机字符串
"""

import requests
import json
import time
import hmac
import hashlib
import random
import string


class AntiBotCracker:
    def __init__(self, base_url="http://localhost:3210"):
        self.base_url = base_url
        self.session = requests.Session()
        self.base_key = "anti-bot-demo-secret-2026"
        self.session_id = None
        self.salt = None

        # 设置浏览器请求头
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
        })

    def fetch_challenge(self):
        """获取动态挑战盐"""
        resp = self.session.get(f"{self.base_url}/api/challenge")
        data = resp.json()
        self.session_id = data['sessionId']
        self.salt = data['salt']
        print(f"✓ 获取 challenge 成功:")
        print(f"  sessionId: {self.session_id}")
        print(f"  salt: {self.salt}")
        return data

    def generate_nonce(self):
        """生成随机 nonce"""
        # 模拟 JS: Date.now().toString(36) + Math.random().toString(36).substring(2, 10)
        ts_part = str(int(time.time() * 1000))
        ts_36 = ''
        for char in ts_part:
            ts_36 += format(int(char), 'x')
        
        rand_part = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        return ts_36 + rand_part

    def generate_device_id(self):
        """生成设备ID"""
        # 格式: dev-{随机字符串}
        return 'dev-' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))

    def generate_fingerprint(self):
        """生成浏览器指纹"""
        # 模拟 btoa(ua + screen + random)
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        screen = "1920x1080"
        rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        data = ua[:20] + screen + rand
        import base64
        return base64.b64encode(data.encode()).decode()

    def sign(self, path, body, timestamp, nonce):
        """计算签名"""
        # 完整密钥 = 基础密钥 + 动态盐
        key = self.base_key + self.salt
        
        # 拼接数据: path + body + timestamp + nonce
        data = path + body + str(timestamp) + nonce
        
        # 计算 HMAC-SHA256
        signature = hmac.new(
            key.encode('utf-8'),
            data.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        return signature

    def query(self, action="query", index=5):
        """发送查询请求"""
        # 确保已获取 challenge
        if not self.salt:
            self.fetch_challenge()

        # 构建请求体
        timestamp = int(time.time() * 1000)
        body = json.dumps({
            "action": action,
            "index": index,
            "timestamp": timestamp
        }, separators=(',', ':'))
        
        # 生成参数
        nonce = self.generate_nonce()
        path = "/api/data"
        
        # 计算签名
        signature = self.sign(path, body, timestamp, nonce)
        
        # 随机 sigCount (模拟人类行为：波动)
        sig_count = random.randint(5, 20)
        
        # 生成设备和指纹（首次）
        if not hasattr(self, 'device_id'):
            self.device_id = self.generate_device_id()
            self.fingerprint = self.generate_fingerprint()
            self.sig_count_base = random.randint(1, 5)
        
        # 构建请求头
        headers = {
            'x-signature': signature,
            'x-timestamp': str(timestamp),
            'x-nonce': nonce,
            'x-session-id': self.session_id,
            'x-device-id': self.device_id,
            'x-fingerprint': self.fingerprint,
            'x-sig-count': str(self.sig_count_base + sig_count),
            'Content-Type': 'application/json',
            'Origin': self.base_url,
            'Referer': f"{self.base_url}/",
        }
        
        print(f"\n{'='*60}")
        print(f"发送请求:")
        print(f"  path: {path}")
        print(f"  body: {body}")
        print(f"  timestamp: {timestamp}")
        print(f"  nonce: {nonce}")
        print(f"  signature: {signature}")
        print(f"  key: {self.base_key + self.salt}")
        print(f"{'='*60}")
        
        # 发送请求
        resp = self.session.post(
            f"{self.base_url}{path}",
            headers=headers,
            data=body
        )
        
        result = resp.json()
        print(f"\n响应状态码: {resp.status_code}")
        print(f"响应内容: {json.dumps(result, ensure_ascii=False, indent=2)}")
        
        return result

    def continuous_query(self, count=10, interval=3000):
        """连续查询（模拟人类行为）"""
        print(f"\n开始连续查询 {count} 次，间隔 {interval}ms...")
        
        for i in range(count):
            print(f"\n[{i+1}/{count}] 第 {i+1} 次查询")
            result = self.query()
            
            # 如果返回 1011（盐过期），重新获取
            if result.get('code') == 1011:
                print("⚠ 盐已过期，重新获取...")
                self.fetch_challenge()
                result = self.query()
            
            # 模拟人类行为：随机间隔（2-8秒）
            if i < count - 1:
                delay = interval + random.randint(-1000, 2000)
                time.sleep(delay / 1000)


if __name__ == "__main__":
    cracker = AntiBotCracker()
    
    # 测试单次查询
    print("测试单次查询...")
    cracker.query()
    
    # 测试连续查询（可选）
    # cracker.continuous_query(count=10, interval=3000)