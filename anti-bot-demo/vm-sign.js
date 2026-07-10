/**
 * anti-bot-demo/vm-sign.js
 *
 * v3: 真正的二进制字节码 VM — 算法不再以 JS 源码形式存在
 *
 * 核心变化 (v2 → v3):
 *   v2 问题: generateObfuscatedClientVM() 返回的是直接实现算法的 JS 代码
 *            AI 读取 _0x 变量名后能理解 atob + HMAC 流程，10 秒破解
 *   v3 修复: generateObfuscatedClientVM() 返回通用 VM 解释器 + 二进制字节码
 *            解释器是通用的 while+switch，不包含任何算法逻辑
 *            算法完全编码在 61 字节字节码中，AI 必须反汇编才能理解
 *
 * v3 防护层次:
 *   1. 通用 VM 解释器: AI 可读，但只学到 opcode 定义，不知道算法
 *   2. 二进制字节码: 61 字节，含垃圾指令/跳转/环境检测/反调试
 *   3. 控制流混淆: JMP 跳过垃圾块，PUSH/POP 干扰，诱饵代码路径
 *   4. 环境检测: ENV_CHECK 验证 window/document/navigator/screen
 *   5. 反调试: DBG_CHECK 通过时间差检测 debugger 暂停
 *   6. 动态挑战盐: per-session 随机盐，5 分钟过期 (v2 保留)
 *
 * AI 破解 v3 需要:
 *   1. 阅读 VM 解释器 → 学习 18 种 opcode 的语义
 *   2. 编写反汇编器 → 将 61 字节十六进制转为可读指令
 *   3. 分析字节码 → 区分真实指令与垃圾指令 (NOP/POP/PUSH_INT)
 *   4. 追踪跳转 → 理解 JMP 跳过的垃圾块
 *   5. 提取算法 → DECODE_KEY → LOAD → CONCAT4 → HMAC → RETURN
 *   6. 提取密钥 → 从 STR_POOL 反向 base64 解码
 *   对比 v2 (AI 直接读 JS): v3 至少需要人工分析 + 反汇编
 */

'use strict';

const crypto = require('crypto');

// ======================= v3 指令集 (18 opcodes) =======================
//
// opcode  助记符       操作数      说明
// 0x01    PUSH_STR    <hi><lo>    压入 STR_POOL[(hi<<8)|lo]
// 0x02    PUSH_INT    <val>       压入整数
// 0x03    POP                     弹出并丢弃栈顶
// 0x04    LOAD        <idx>       压入 registers[idx]
// 0x05    STORE       <idx>       弹出存入 registers[idx]
// 0x06    JMP         <off>       pc += off (前向跳转)
// 0x07    JMP_IF      <off>       弹出条件，为真则 pc += off
// 0x08    DECODE_KEY              重组密钥 → R7 (baseKey + salt)
// 0x09    CONCAT2                 弹出 a,b → 压入 a+b
// 0x0A    CONCAT4                 弹出 a,b,c,d → 压入 a+b+c+d
// 0x0B    HMAC                    弹出 key,data → 压入 HMAC-SHA256(key,data)
// 0x0C    ENV_CHECK   <idx>       检查环境对象 [window,document,navigator,screen]
// 0x0D    XOR_DECODE  <idx>       XOR 解码 STR_POOL[idx] (key=0x5A)
// 0x0E    RETURN                  返回栈顶
// 0x0F    NOP                     空操作 (垃圾指令)
// 0x10    DBG_CHECK               反调试: 检测执行时间差
// 0x11    CMP_EQ                  弹出 a,b → 压入 (a===b)
// 0x12    HASH                    弹出 data → 压入 SHA256(data)

// ======================= 密钥编码 (同 v2) =======================

const KEY_RAW_PARTS = ['anti-bot-', 'demo-secr', 'et-2026'];
const KEY_ENCODED = KEY_RAW_PARTS.map(p =>
  Buffer.from(p, 'utf8').toString('base64').split('').reverse().join('')
);

// ======================= 字符串池 (v3: 7 条目) =======================
//
// 索引 0-2: 密钥片段（打乱顺序，base64 逆转编码）
// 索引 3:   重组顺序 [1, 2, 0]
// 索引 4-6: 垃圾诱饵字符串（干扰分析）

const STR_POOL = [
  KEY_ENCODED[2],   // 0: "et-2026" 编码
  KEY_ENCODED[0],   // 1: "anti-bot-" 编码
  KEY_ENCODED[1],   // 2: "demo-secr" 编码
  '\x01\x02\x00',   // 3: 重组顺序 [1, 2, 0]
  'k7Px2mQ9rT3v',   // 4: 垃圾诱饵
  'jB5cF1yD8wL2',   // 5: 垃圾诱饵
  'nH6gV4xK9pM7',   // 6: 垃圾诱饵
];

// ======================= 字节码 (v3: 61 字节) =======================
//
// 反汇编:
//   pc  hex         指令               说明
//   0   0C 00       ENV_CHECK window    环境检测
//   2   06 04       JMP +4             → 跳到 pc=8
//   4   0F          NOP                 ┐ 垃圾
//   5   02 39       PUSH_INT 57         │
//   7   03          POP                 ┘
//   8   0C 01       ENV_CHECK document  环境检测
//  10   06 02       JMP +2             → 跳到 pc=14
//  12   0F          NOP                 ┐ 垃圾
//  13   0F          NOP                 ┘
//  14   0C 02       ENV_CHECK navigator 环境检测
//  16   0C 03       ENV_CHECK screen    环境检测
//  18   10          DBG_CHECK           反调试检测
//  19   06 08       JMP +8             → 跳到 pc=29
//  21   01 00 04    PUSH_STR 4          ┐ 诱饵块
//  24   04 05       LOAD R5             │ (全部跳过)
//  26   09          CONCAT2             │
//  27   05 06       STORE R6            │
//  29   02 48       PUSH_INT 72         ┐ 垃圾 (执行但无效果)
//  31   03          POP                 ┘
//  32   0F          NOP
//  33   08          DECODE_KEY          R7 = baseKey + salt
//  34   04 00       LOAD R0             栈: [path]
//  36   04 01       LOAD R1             栈: [path, body]
//  38   06 01       JMP +1             → 跳到 pc=41
//  40   0F          NOP                 ┐ 垃圾
//  41   04 02       LOAD R2             栈: [path, body, ts]
//  43   04 03       LOAD R3             栈: [path, body, ts, nonce]
//  45   0A          CONCAT4             栈: [path+body+ts+nonce]
//  46   01 00 05    PUSH_STR 5          ┐ 垃圾
//  49   03          POP                 ┘
//  50   02 63       PUSH_INT 99         ┐ 垃圾
//  52   03          POP                 ┘
//  53   01 00 06    PUSH_STR 6          ┐ 垃圾
//  56   03          POP                 ┘
//  57   04 07       LOAD R7             栈: [data, key]
//  59   0B          HMAC                栈: [signature]
//  60   0E          RETURN              返回 signature

const BYTECODE_HEX = '0c0006040f0239030c0106020f0f0c020c0310060801000404050905060248030f080400040106010f040204030a010005030263030100060304070b0e';

// ======================= VM 解释器 (服务端) =======================

class SimpleVM {
  constructor(bytecodeHex, strPool) {
    this.bytecode = Buffer.from(bytecodeHex, 'hex');
    this.strPool = strPool;
    this.pc = 0;
    this.stack = [];
    this.registers = new Array(8).fill(null);
    this.startTime = Date.now();
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
    const salt = this.registers[4] || '';
    return baseKey + salt;
  }

  run(args) {
    for (let i = 0; i < Math.min(args.length, 5); i++) {
      this.registers[i] = String(args[i]);
    }

    while (this.pc < this.bytecode.length) {
      const op = this.bytecode[this.pc++];

      switch (op) {
        case 0x01: { // PUSH_STR <hi> <lo>
          const hi = this.bytecode[this.pc++];
          const lo = this.bytecode[this.pc++];
          this.stack.push(this.strPool[(hi << 8) | lo]);
          break;
        }
        case 0x02: { // PUSH_INT <val>
          this.stack.push(this.bytecode[this.pc++]);
          break;
        }
        case 0x03: { // POP
          this.stack.pop();
          break;
        }
        case 0x04: { // LOAD <idx>
          this.stack.push(this.registers[this.bytecode[this.pc++]]);
          break;
        }
        case 0x05: { // STORE <idx>
          this.registers[this.bytecode[this.pc++]] = this.stack.pop();
          break;
        }
        case 0x06: { // JMP <off>
          this.pc += this.bytecode[this.pc++];
          break;
        }
        case 0x07: { // JMP_IF <off>
          const off = this.bytecode[this.pc++];
          if (this.stack.pop()) this.pc += off;
          break;
        }
        case 0x08: { // DECODE_KEY
          this.registers[7] = this.decodeKey();
          break;
        }
        case 0x09: { // CONCAT2
          const b = this.stack.pop();
          const a = this.stack.pop();
          this.stack.push(a + b);
          break;
        }
        case 0x0A: { // CONCAT4
          const d = this.stack.pop();
          const c = this.stack.pop();
          const b = this.stack.pop();
          const a = this.stack.pop();
          this.stack.push(a + b + c + d);
          break;
        }
        case 0x0B: { // HMAC
          const key = this.stack.pop();
          const data = this.stack.pop();
          const sig = crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
          this.stack.push(sig);
          break;
        }
        case 0x0C: { // ENV_CHECK <idx> — 服务端跳过
          this.pc++; // 跳过操作数
          break;
        }
        case 0x0D: { // XOR_DECODE <idx>
          const idx = this.bytecode[this.pc++];
          const encoded = this.strPool[idx];
          let decoded = '';
          for (let i = 0; i < encoded.length; i++) {
            decoded += String.fromCharCode(encoded.charCodeAt(i) ^ 0x5A);
          }
          this.stack.push(decoded);
          break;
        }
        case 0x0E: { // RETURN
          return this.stack.pop();
        }
        case 0x0F: { // NOP
          break;
        }
        case 0x10: { // DBG_CHECK — 服务端跳过
          break;
        }
        case 0x11: { // CMP_EQ
          const b = this.stack.pop();
          const a = this.stack.pop();
          this.stack.push(a === b);
          break;
        }
        case 0x12: { // HASH
          const data = this.stack.pop();
          const hash = crypto.createHash('sha256').update(data, 'utf8').digest('hex');
          this.stack.push(hash);
          break;
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
 * 生成浏览器端 VM 引擎代码 (v3 核心)
 *
 * v3 关键变化: 返回通用 VM 解释器 + 二进制字节码，而非直接算法 JS
 *
 * AI 能看到: while+switch 解释器 (通用，不含算法)
 * AI 看不到: 算法逻辑 (编码在 61 字节字节码中)
 *
 * 结构:
 *   (function(){
 *     var POOL = [hex-escaped strings];
 *     var BC = "bytecode hex";
 *     var VM = parse(BC);
 *     function decodeKey(r) { ... }
 *     var ENV = [window, document, navigator, screen];
 *     return async function(path, body, ts, nonce, salt) {
 *       // 通用 VM 解释器: while + switch(18 opcodes)
 *     }
 *   })()
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

  // 通用 VM 解释器 — 不含算法逻辑，算法在字节码中
  return `(function(){var _0xP=[${poolStr}];var _0xB="${BYTECODE_HEX}";var _0xV=new Uint8Array(_0xB.length/2);for(var _0xi=0;_0xi<_0xB.length;_0xi+=2){_0xV[_0xi/2]=parseInt(_0xB.substr(_0xi,2),16);}function _0xDK(_0xr){var _0xo=[];for(var _0xi=0;_0xi<_0xP[3].length;_0xi++){_0xo.push(_0xP[3].charCodeAt(_0xi));}var _0xp=[];for(var _0xj=0;_0xj<_0xo.length;_0xj++){_0xp.push(atob(_0xP[_0xo[_0xj]].split("").reverse().join("")));}return _0xp.join("")+(_0xr[4]||"");}var _0xE=[window,document,navigator,screen];return async function(_0xa0,_0xa1,_0xa2,_0xa3,_0xa4){var _0xR=[_0xa0,_0xa1,_0xa2,_0xa3,_0xa4,null,null,null];var _0xS=[];var _0xpc=0;var _0xT=performance.now();while(_0xpc<_0xV.length){var _0xop=_0xV[_0xpc++];switch(_0xop){case 1:{var _0xh=_0xV[_0xpc++];var _0xl=_0xV[_0xpc++];_0xS.push(_0xP[(_0xh<<8)|_0xl]);break;}case 2:{_0xS.push(_0xV[_0xpc++]);break;}case 3:{_0xS.pop();break;}case 4:{_0xS.push(_0xR[_0xV[_0xpc++]]);break;}case 5:{_0xR[_0xV[_0xpc++]]=_0xS.pop();break;}case 6:{_0xpc+=_0xV[_0xpc++];break;}case 7:{var _0xf=_0xV[_0xpc++];if(_0xS.pop()){_0xpc+=_0xf;}break;}case 8:{_0xR[7]=_0xDK(_0xR);break;}case 9:{var _0xb=_0xS.pop();var _0xa=_0xS.pop();_0xS.push(_0xa+_0xb);break;}case 10:{var _0xd=_0xS.pop();var _0xc=_0xS.pop();var _0xb2=_0xS.pop();var _0xa2=_0xS.pop();_0xS.push(_0xa2+_0xb2+_0xc+_0xd);break;}case 11:{var _0xk=_0xS.pop();var _0xda=_0xS.pop();var _0xe=new TextEncoder();var _0xck=await crypto.subtle.importKey("raw",_0xe.encode(_0xk),{name:"HMAC",hash:"SHA-256"},false,["sign"]);var _0xsg=await crypto.subtle.sign("HMAC",_0xck,_0xe.encode(_0xda));var _0xh2=[];var _0xbt=new Uint8Array(_0xsg);for(var _0xj2=0;_0xj2<_0xbt.length;_0xj2++){_0xh2.push(_0xbt[_0xj2].toString(16).padStart(2,"0"));}_0xS.push(_0xh2.join(""));break;}case 12:{var _0xei=_0xV[_0xpc++];if(!_0xE[_0xei]){throw new Error("env check failed");}break;}case 13:{var _0xdi=_0xV[_0xpc++];var _0xds=_0xP[_0xdi];var _0xdr="";for(var _0xdk=0;_0xdk<_0xds.length;_0xdk++){_0xdr+=String.fromCharCode(_0xds.charCodeAt(_0xdk)^90);}_0xS.push(_0xdr);break;}case 14:{return _0xS.pop();}case 15:{break;}case 16:{if(performance.now()-_0xT>5000){throw new Error("debug detected");}break;}case 17:{var _0xbb=_0xS.pop();var _0xaa=_0xS.pop();_0xS.push(_0xaa===_0xbb);break;}case 18:{var _0xhd=_0xS.pop();var _0xhe=new TextEncoder();var _0xhh=await crypto.subtle.digest("SHA-256",_0xhe.encode(_0xhd));var _0xhr=[];var _0xhb=new Uint8Array(_0xhh);for(var _0xhi=0;_0xhi<_0xhb.length;_0xhi++){_0xhr.push(_0xhb[_0xhi].toString(16).padStart(2,"0"));}_0xS.push(_0xhr.join(""));break;}default:throw new Error("invalid opcode");}}}return _0xS.pop();};})()`;
}

module.exports = { vmSign, generateObfuscatedClientVM, SimpleVM, BYTECODE_HEX, STR_POOL };
