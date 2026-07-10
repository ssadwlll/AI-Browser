/**
 * anti-bot-demo/vm-sign.js
 *
 * 轻量级 VM 字节码签名模块 — 模拟小红书 mnsv2 的 VM 保护思路
 *
 * 核心思路：
 *   1. 签名密钥不直接出现在代码中，而是拆分编码后嵌入字符串池
 *   2. 字节码由自研 VM 解释执行，攻击者无法直接阅读算法逻辑
 *   3. VM 运行时动态重组密钥 + 计算 HMAC
 *   4. 动态挑战盐：服务端每次会话下发随机盐，混入密钥派生
 *      即使 VM 代码被完全逆向，没有盐值也无法生成有效签名
 *
 * 安全层次：
 *   明文密钥:        F12 → 搜索 "secret" → 10 秒破解
 *   VM 字节码 (v1):  逆向 VM → 提取密钥 → 1-2 小时 (已过时)
 *   VM + 动态盐 (v2): 逆向 VM + 提取基础密钥 + 每次获取盐 → 需持续交互
 *   小红书 VM:        逆向两层嵌套 VM + 233K 字节码 → 2+ 天
 *
 * v2 改进：
 *   - 移除 /api/vm-engine 公开端点，VM 代码内嵌在页面 HTML 中（混淆）
 *   - 新增 /api/challenge 端点，下发 per-session 随机盐（5 分钟过期）
 *   - 密钥 = decodeKey(STR_POOL) + sessionSalt，两部分缺一不可
 *   - 攻击者即使逆向 VM，仍需持续调用 /api/challenge 获取盐值
 */

'use strict';

const crypto = require('crypto');

// ======================= VM 指令集 =======================
//
// 每条指令 = 1 字节 opcode + 可变操作数
//
// 0x01 PUSH_STR <hi:1> <lo:1>  从字符串池压入字符串
// 0x04 LOAD    <idx:1>         从寄存器压入栈（R0-R7 为外部参数）
// 0x08 DECODE_KEY              解码重组密钥 → 存入 R7
// 0x10 CONCAT4                 弹出4个值，按相反顺序拼接（栈顶最后）
// 0x20 HMAC                    弹出 key 和 data，计算 HMAC-SHA256
// 0x07 RETURN                  返回栈顶

// ======================= 密钥编码 =======================
//
// 原密钥: anti-bot-demo-secret-2026
// 拆分:   "anti-bot-" | "demo-secr" | "et-2026"
// 编码:   base64(段).split('').reverse().join('')
// STR_POOL 中故意打乱顺序，运行时按 ORDER 数组重组

const KEY_RAW_PARTS = ['anti-bot-', 'demo-secr', 'et-2026'];
const KEY_ENCODED = KEY_RAW_PARTS.map(p =>
  Buffer.from(p, 'utf8').toString('base64').split('').reverse().join('')
);

// 字符串池：编码后的密钥片段 + 重组顺序
// 索引 0-2: 密钥片段（打乱顺序）
// 索引 3: 重组顺序（控制字符，指示从 STR_POOL 的哪些索引取值，按什么顺序）
const STR_POOL = [
  KEY_ENCODED[2],   // 索引0: "et-2026" 的编码（故意放前面）
  KEY_ENCODED[0],   // 索引1: "anti-bot-" 的编码
  KEY_ENCODED[1],   // 索引2: "demo-secr" 的编码
  '\x01\x02\x00',   // 索引3: 重组顺序 [1, 2, 0] → anti-bot- + demo-secr + et-2026
];

// ======================= 字节码 =======================
//
// 程序逻辑:
//   DECODE_KEY              // 解码密钥 → R7
//   LOAD 0                  // 压入 path (外部参数 R0)
//   LOAD 1                  // 压入 body  (外部参数 R1)
//   LOAD 2                  // 压入 ts     (外部参数 R2)
//   LOAD 3                  // 压入 nonce  (外部参数 R3)
//   CONCAT4                 // 拼接: path + body + ts + nonce
//   PUSH_STR 0 0            // 压入 STR_POOL[0]（占位，实际用 R7）
//   ... 不对，应该直接用 R7
//
// 修正后的程序:
//   DECODE_KEY              // R7 = 重组后的密钥
//   LOAD 0                  // 栈: [path]
//   LOAD 1                  // 栈: [path, body]
//   LOAD 2                  // 栈: [path, body, ts]
//   LOAD 3                  // 栈: [path, body, ts, nonce]
//   CONCAT4                 // 栈: [path+body+ts+nonce]
//   LOAD 7                  // 栈: [data, key]
//   HMAC                    // 栈: [signature]
//   RETURN                  // 返回 signature
//
// 字节码编码:
//   0x08                    DECODE_KEY
//   0x04 0x00               LOAD 0
//   0x04 0x01               LOAD 1
//   0x04 0x02               LOAD 2
//   0x04 0x03               LOAD 3
//   0x10                    CONCAT4
//   0x04 0x07               LOAD 7
//   0x20                    HMAC
//   0x07                    RETURN

const BYTECODE_HEX = '0804000401040204031004072007';

// ======================= VM 解释器 =======================

class SimpleVM {
  constructor(bytecodeHex, strPool) {
    this.bytecode = Buffer.from(bytecodeHex, 'hex');
    this.strPool = strPool;
    this.pc = 0;
    this.stack = [];
    this.registers = new Array(8).fill(null);
  }

  decodeKey() {
    const orderBytes = Buffer.from(this.strPool[3]);
    const parts = [];
    for (let i = 0; i < orderBytes.length; i++) {
      const idx = orderBytes[i];
      const encoded = this.strPool[idx];
      const reversed = encoded.split('').reverse().join('');
      parts.push(Buffer.from(reversed, 'base64').toString('utf8'));
    }
    const baseKey = parts.join('');
    // 动态挑战盐：R4 存放服务端下发的 per-session salt
    // 最终密钥 = baseKey + salt，即使 VM 被完全逆向，没有盐也无法签名
    const salt = this.registers[4] || '';
    return baseKey + salt;
  }

  run(args) {
    // 外部参数载入 R0-R4 (R4 = 动态盐)
    for (let i = 0; i < Math.min(args.length, 5); i++) {
      this.registers[i] = String(args[i]);
    }

    while (this.pc < this.bytecode.length) {
      const op = this.bytecode[this.pc++];

      switch (op) {
        case 0x01: { // PUSH_STR <hi> <lo>
          const offset = (this.bytecode[this.pc] << 8) | this.bytecode[this.pc + 1];
          this.pc += 2;
          this.stack.push(this.strPool[offset]);
          break;
        }
        case 0x04: { // LOAD <idx>
          const idx = this.bytecode[this.pc++];
          this.stack.push(this.registers[idx]);
          break;
        }
        case 0x08: { // DECODE_KEY
          this.registers[7] = this.decodeKey();
          break;
        }
        case 0x10: { // CONCAT4 — 弹出4个值，按入栈顺序拼接
          const d = this.stack.pop();
          const c = this.stack.pop();
          const b = this.stack.pop();
          const a = this.stack.pop();
          this.stack.push(a + b + c + d);
          break;
        }
        case 0x20: { // HMAC
          const key = this.stack.pop();
          const data = this.stack.pop();
          const sig = crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
          this.stack.push(sig);
          break;
        }
        case 0x07: { // RETURN
          return this.stack.pop();
        }
        default:
          throw new Error(`未知 opcode: 0x${op.toString(16).padStart(2, '0')} at pc=${this.pc - 1}`);
      }
    }
    return this.stack.pop();
  }
}

// ======================= 对外接口 =======================

function vmSign(path, body, timestamp, nonce, salt) {
  const vm = new SimpleVM(BYTECODE_HEX, STR_POOL);
  return vm.run([path, body, timestamp, nonce, salt]);
}

/**
 * 生成浏览器端混淆 VM 引擎代码
 * - 变量名 _0x 前缀混淆
 * - STR_POOL 全量 hex 转义
 * - 单行压缩，无注释
 * - 接受 5 参数 (path, body, ts, nonce, salt)，salt 追加到解码后的密钥
 * - 使用 atob + crypto.subtle (浏览器原生 API)
 */
function generateObfuscatedClientVM() {
  function hexEscape(s) {
    let r = '"';
    for (let i = 0; i < s.length; i++) {
      r += '\\x' + s.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return r + '"';
  }
  const poolStr = STR_POOL.map(hexEscape).join(',');
  return `(function(){var _0x4a=[${poolStr}];function _0x1d(){var _0x9e=[];for(var _0x1f=0;_0x1f<_0x4a[3].length;_0x1f++){_0x9e.push(_0x4a[3].charCodeAt(_0x1f));}var _0x2a=[];for(var _0x3b=0;_0x3b<_0x9e.length;_0x3b++){var _0x5c=_0x4a[_0x9e[_0x3b]];_0x2a.push(atob(_0x5c.split("").reverse().join("")));}return _0x2a.join("");}return async function(_0x11,_0x22,_0x33,_0x44,_0x55){var _0x6f=_0x1d()+(_0x55||"");var _0x7d=_0x11+_0x22+_0x33+_0x44;var _0x8e=new TextEncoder();var _0x9f=await crypto.subtle.importKey("raw",_0x8e.encode(_0x6f),{name:"HMAC",hash:"SHA-256"},false,["sign"]);var _0xa0=await crypto.subtle.sign("HMAC",_0x9f,_0x8e.encode(_0x7d));var _0xb1=[];var _0xc2=new Uint8Array(_0xa0);for(var _0xd3=0;_0xd3<_0xc2.length;_0xd3++){_0xb1.push(_0xc2[_0xd3].toString(16).padStart(2,"0"));}return _0xb1.join("");};})()`;
}

module.exports = { vmSign, generateObfuscatedClientVM, SimpleVM, BYTECODE_HEX, STR_POOL };
