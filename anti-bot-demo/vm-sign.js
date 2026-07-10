/**
 * anti-bot-demo/vm-sign.js
 *
 * 轻量级 VM 字节码签名模块 — 模拟小红书 mnsv2 的 VM 保护思路
 *
 * 核心思路：
 *   1. 签名密钥不直接出现在代码中，而是拆分编码后嵌入字符串池
 *   2. 字节码由自研 VM 解释执行，攻击者无法直接阅读算法逻辑
 *   3. VM 运行时动态重组密钥 + 计算 HMAC
 *
 * 对比小红书 mnsv2:
 *   小红书: 233081 hex 字节码 + 自研 VM + 26 项依赖 → 逆向需 2+ 天
 *   本 demo: ~100 hex 字节码 + 简化 VM → 逆向需 1-2 小时
 *   生产建议: 字节码 5000+ 字符 + 控制流混淆 → 逆向需 1+ 天
 *
 * 攻击难度对比:
 *   明文密钥:   F12 → 搜索 "secret" → 10 秒破解
 *   VM 字节码:  逆向 VM 指令集 → 理解字节码 → 提取密钥 → 1-2 小时
 *   小红书 VM:  逆向两层嵌套 VM + 233K 字节码 → 2+ 天
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
    return parts.join('');
  }

  run(args) {
    // 外部参数载入 R0-R3
    for (let i = 0; i < Math.min(args.length, 4); i++) {
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

function vmSign(path, body, timestamp, nonce) {
  const vm = new SimpleVM(BYTECODE_HEX, STR_POOL);
  return vm.run([path, body, timestamp, nonce]);
}

/**
 * 生成客户端 VM 引擎代码（混淆后的 JS）
 * 客户端拿到的不是密钥，而是字节码 + 字符串池 + VM 解释器
 */
function generateClientVM() {
  return `
(function(){
  var _s=${JSON.stringify(STR_POOL)};
  var _b=Buffer.from("${BYTECODE_HEX}","hex");
  function _V(){
    this.pc=0;this.st=[];this.r=new Array(8).fill(null);
  }
  _V.prototype._dk=function(){
    var o=Buffer.from(_s[3]),p=[];
    for(var i=0;i<o.length;i++){
      var v=_s[o[i]];
      p.push(Buffer.from(v.split("").reverse().join(""),"base64").toString());
    }
    return p.join("");
  };
  _V.prototype.run=function(a){
    for(var i=0;i<a.length&&i<4;i++)this.r[i]=String(a[i]);
    while(this.pc<_b.length){
      var op=_b[this.pc++];
      switch(op){
        case 4:var idx=_b[this.pc++];this.st.push(this.r[idx]);break;
        case 8:this.r[7]=this._dk();break;
        case 16:var d=this.st.pop(),c=this.st.pop(),b=this.st.pop(),a2=this.st.pop();this.st.push(a2+b+c+d);break;
        case 32:var k=this.st.pop(),dt=this.st.pop();this.st.push(require("crypto").createHmac("sha256",k).update(dt,"utf8").digest("hex"));break;
        case 7:return this.st.pop();
        default:throw new Error("e:"+op);
      }
    }
    return this.st.pop();
  };
  return function(p,b,t,n){return new _V().run([p,b,t,n])};
})()
`;
}

module.exports = { vmSign, generateClientVM, SimpleVM, BYTECODE_HEX, STR_POOL };
