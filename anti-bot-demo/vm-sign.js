/**
 * anti-bot-demo/vm-sign.js
 *
 * v4: 深度防护 VM 签名引擎
 *
 * 改进点:
 *   P0: 消除 crypto.subtle → 自定义 SBOX 哈希（无标准加密 API）
 *   P0: 字节码 61 → 2000+ 字节（垃圾块 + 假分支）
 *   P0: 密钥由字节码 XOR 链 + SBOX 查表生成 → 不在 STR_POOL 中
 *   P1: 变长 varint 操作数编码
 *   P1: 双层 VM 嵌套（外层解密+调度，内层执行）
 *   P1: 浏览器依赖数组（26 项）+ 自定义 Base64
 *   P2: 环境特征参与签名 + 静默反调试 + 签名动态性
 */

'use strict';

const { compile } = require('./vm-compiler');

// ======================= S-Box =======================

const SBOX = new Uint8Array(256);
(function initSBox() {
  for (let i = 0; i < 256; i++) SBOX[i] = i;
  let seed = 0xDEADBEEF;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    const j = seed % (i + 1);
    [SBOX[i], SBOX[j]] = [SBOX[j], SBOX[i]];
  }
})();
const SBOX_HEX = Buffer.from(SBOX).toString('hex');

// ======================= 自定义 Base64 =======================

const B64_ALPHABET = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';

function customB64Encode(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    result += B64_ALPHABET[a >> 2];
    result += B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '=';
    result += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : '=';
  }
  return result;
}

// ======================= Varint 编码 =======================

function encodeVarint(n) {
  if (n < 0) throw new Error('varint negative: ' + n);
  const bytes = [];
  do {
    let b = n & 0x7F;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return bytes;
}

function varintSize(n) {
  if (n < 0) throw new Error('varint negative: ' + n);
  if (n === 0) return 1;
  let size = 0, v = n;
  while (v > 0) { size++; v = Math.floor(v / 128); }
  return size;
}

// ======================= 辅助函数 =======================

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] & 0xFF).toString(16).padStart(2, '0');
  }
  return hex;
}

// ======================= Opcode 定义 (35 个) =======================

const OP = {
  PUSH_STR: 0x01, PUSH_INT: 0x02, POP: 0x03, LOAD_REG: 0x04, STORE_REG: 0x05,
  JMP: 0x06, JMP_IF: 0x07, XOR: 0x08, ADD: 0x09, SHL: 0x0A, SHR: 0x0B,
  ROTL: 0x0C, ROTR: 0x0D, SBOX_L: 0x0E, CONCAT: 0x0F, STR_AT: 0x10,
  STR_LEN: 0x11, B64_ENC: 0x12, B64_DEC: 0x13, LOAD_DEP: 0x14,
  ENV_FEAT: 0x15, RAND: 0x16, CMP_EQ: 0x17, MUL: 0x18,
  HASH_INIT: 0x19, HASH_UPDATE: 0x1A, HASH_FINAL: 0x1B,
  NOP: 0x1C, DBG_CHECK: 0x1D, RETURN: 0x1E, DUP: 0x1F, SWAP: 0x20,
  TO_STR: 0x21, MOD: 0x22, DECRYPT_INNER: 0x23, EXEC_INNER: 0x24,
};

// ======================= 浏览器依赖数组 (26 项) =======================

function createDeps(isBrowser) {
  var mockNav = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    platform: 'Win32',
  };
  var mockDoc = {
    createElement: function() { return { getContext: function() { return null; }, style: {} }; },
    cookie: '', referrer: '',
  };
  // typeof 检查避免 ReferenceError，在非浏览器环境自动降级到 mock
  var _doc = (typeof document !== 'undefined') ? document : mockDoc;
  var _nav = (typeof navigator !== 'undefined') ? navigator : mockNav;
  var _perf = (typeof performance !== 'undefined') ? performance : require('perf_hooks').performance;
  var _te = (typeof TextEncoder !== 'undefined') ? TextEncoder : require('util').TextEncoder;
  var _evt = (typeof Event !== 'undefined') ? Event : function Event(t) { this.type = t; };
  return [
    undefined, {}, globalThis, undefined,
    _perf,
    encodeURIComponent, Array,
    _te,
    Date, Math, Uint8Array,
    _doc,
    setTimeout, RegExp, unescape, parseInt,
    Object,
    _nav,
    undefined, Set, Function, String, Error,
    undefined,
    _evt,
    Reflect,
  ];
}

// ======================= 字节码汇编器 =======================

function assemble(insts) {
  const positions = new Array(insts.length).fill(0);
  let offset = 0;
  for (let i = 0; i < insts.length; i++) {
    positions[i] = offset;
    const inst = insts[i];
    if (inst.label) continue;
    let size = 1;
    if (inst.op === OP.JMP || inst.op === OP.JMP_IF) {
      size += 2;
    } else if (inst.args) {
      for (const a of inst.args) size += varintSize(a);
    }
    offset += size;
  }
  const labels = {};
  for (let i = 0; i < insts.length; i++) {
    if (insts[i].label) labels[insts[i].label] = positions[i];
  }
  const bytes = [];
  for (let i = 0; i < insts.length; i++) {
    const inst = insts[i];
    if (inst.label) continue;
    bytes.push(inst.op);
    if (inst.op === OP.JMP || inst.op === OP.JMP_IF) {
      const target = labels[inst.jump];
      if (target === undefined) throw new Error('Unknown label: ' + inst.jump);
      const rel = target - (positions[i] + 3);
      bytes.push((rel >> 8) & 0xFF, rel & 0xFF);
    } else if (inst.args) {
      for (const a of inst.args) bytes.push(...encodeVarint(a));
    }
  }
  return bytesToHex(new Uint8Array(bytes));
}

// ======================= 签名算法 DSL 源码 =======================
// 开发者只需修改这段 DSL 即可改变签名算法，编译器自动处理:
//   - 常量分裂 (字面常量不出现在字节码中)
//   - 垃圾指令插入 (语句间随机混淆)
//   - 假分支 (永真跳转跳过垃圾块)
//   - 死代码 (RETURN 后追加不可达块)
//   - 每次编译产生不同字节码

const ALGORITHM_DSL = `
func sign(path, body, ts, nonce, salt):
    dbg_check()
    env = env_feat()
    rnd = rand()
    seed1 = 0xA3 ^ 0x5C ^ 0x7E ^ 0x21
    seed2 = 0x1F ^ 0x8B ^ 0xD4 ^ 0x06
    key = ""
    for i = 0 to 14:
        k = sbox[sbox[seed1 ^ i] ^ seed2]
        k = sbox[k ^ i]
        key = key + char(k)
    endfor
    key = salt + key
    keylen = len(key)
    data = path + body + ts + nonce
    data = data + char(env)
    data = data + char(rnd)
    datalen = len(data)
    hash_init()
    for counter = 0 to datalen:
        kb = key[counter % keylen]
        db = data[counter]
        t1 = sbox[db ^ kb]
        t2 = sbox[t1 ^ kb ^ counter]
        hash_update(t2)
    endfor
    hash_update(sbox[env ^ rnd])
    hash_update(sbox[seed1 ^ seed2])
    dbg_check()
    return hash_final()
endfunc
`;

// ======================= 内层字节码加密 =======================

function encryptBytecode(innerHex) {
  const bytes = hexToBytes(innerHex);
  const encrypted = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    encrypted[i] = bytes[i] ^ SBOX[i % 256];
  }
  return bytesToHex(encrypted);
}

// ======================= 预计算 (编译器只执行一次) =======================
//
// 流程: DSL源码 → compile() → 指令序列 + 字符串池
//      → assemble() → 内层字节码
//      → encryptBytecode() → 加密内层
//      → 追加到字符串池末尾
//      → 外层字节码引用字符串池最后一个元素 (加密内层)

const COMPILED = compile(ALGORITHM_DSL);
const INNER_BC = assemble(COMPILED.instructions);
const ENCRYPTED_INNER = encryptBytecode(INNER_BC);
// 完整字符串池 = 编译器输出的字符串 + 加密内层字节码
const STR_POOL = [...COMPILED.strPoolStrings, ENCRYPTED_INNER];
// 加密内层在字符串池中的索引 (最后一个)
const INNER_POOL_IDX = STR_POOL.length - 1;
// 外层字节码: 解密内层 → 执行内层 → 返回
const OUTER_BC = assemble([
  { op: OP.DECRYPT_INNER, args: [INNER_POOL_IDX] },
  { op: OP.EXEC_INNER },
  { op: OP.RETURN },
]);

// ======================= VM 类 =======================

class VM {
  constructor(sboxHex, b64Alphabet, bytecodeHex, strPool, isBrowser) {
    this.sbox = hexToBytes(sboxHex);
    this.b64 = b64Alphabet;
    this.bytecode = hexToBytes(bytecodeHex);
    this.strPool = strPool;
    this.deps = createDeps(isBrowser);
    this.stack = [];
    this.registers = new Array(16).fill(0);
    this.hashState = null;
    this.hashIdx = 0;
    this.dbgStartTime = 0;
    this.dbgTriggered = false;
  }

  readVarint(code, pc) {
    let result = 0, shift = 0;
    while (true) {
      const byte = code[pc++];
      result |= (byte & 0x7F) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return { value: result, nextPc: pc };
  }

  b64Encode(data) {
    const str = typeof data === 'string' ? data : String(data);
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xFF);
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      result += this.b64[a >> 2];
      result += this.b64[((a & 3) << 4) | (b >> 4)];
      result += i + 1 < bytes.length ? this.b64[((b & 15) << 2) | (c >> 6)] : '=';
      result += i + 2 < bytes.length ? this.b64[c & 63] : '=';
    }
    return result;
  }

  run(path, body, ts, nonce, salt) {
    this.stack = [];
    this.registers = new Array(32).fill(0);
    this.hashState = null;
    this.hashIdx = 0;
    this.dbgStartTime = this.deps[4].now();
    this.dbgTriggered = false;
    this.registers[0] = path;
    this.registers[1] = body;
    this.registers[2] = ts;
    this.registers[3] = nonce;
    this.registers[4] = salt;
    return this.execute(this.bytecode, 0);
  }

  execute(code, startPc) {
    let pc = startPc;
    const stack = this.stack;
    const regs = this.registers;
    const sbox = this.sbox;
    const deps = this.deps;

    while (pc < code.length) {
      const op = code[pc++];
      switch (op) {
        case OP.PUSH_STR: { const r = this.readVarint(code, pc); pc = r.nextPc; stack.push(this.strPool[r.value]); break; }
        case OP.PUSH_INT: { const r = this.readVarint(code, pc); pc = r.nextPc; stack.push(r.value); break; }
        case OP.POP: stack.pop(); break;
        case OP.LOAD_REG: { const r = this.readVarint(code, pc); pc = r.nextPc; stack.push(regs[r.value]); break; }
        case OP.STORE_REG: { const r = this.readVarint(code, pc); pc = r.nextPc; regs[r.value] = stack.pop(); break; }
        case OP.JMP: { const hi = code[pc++]; const lo = code[pc++]; let rel = (hi << 8) | lo; if (rel & 0x8000) rel -= 0x10000; pc += rel; break; }
        case OP.JMP_IF: { const hi = code[pc++]; const lo = code[pc++]; let rel = (hi << 8) | lo; if (rel & 0x8000) rel -= 0x10000; if (stack.pop()) pc += rel; break; }
        case OP.XOR: { const b = stack.pop(); const a = stack.pop(); stack.push((a ^ b) & 0xFF); break; }
        case OP.ADD: { const b = stack.pop(); const a = stack.pop(); stack.push(a + b); break; }
        case OP.SHL: { const n = stack.pop(); const a = stack.pop(); stack.push((a << n) & 0xFF); break; }
        case OP.SHR: { const n = stack.pop(); const a = stack.pop(); stack.push((a >> n) & 0xFF); break; }
        case OP.ROTL: { const n = stack.pop(); const a = stack.pop(); stack.push(((a << n) | (a >> (8 - n))) & 0xFF); break; }
        case OP.ROTR: { const n = stack.pop(); const a = stack.pop(); stack.push(((a >> n) | (a << (8 - n))) & 0xFF); break; }
        case OP.SBOX_L: { const idx = stack.pop(); stack.push(sbox[idx & 0xFF]); break; }
        case OP.CONCAT: { const b = stack.pop(); const a = stack.pop(); stack.push(String(a) + String(b)); break; }
        case OP.STR_AT: { const idx = stack.pop(); const str = stack.pop(); stack.push(String(str).charCodeAt(idx) || 0); break; }
        case OP.STR_LEN: { const str = stack.pop(); stack.push(String(str).length); break; }
        case OP.B64_ENC: { stack.push(this.b64Encode(stack.pop())); break; }
        case OP.B64_DEC: { stack.push(this.b64Encode(stack.pop())); break; } // simplified
        case OP.LOAD_DEP: { const r = this.readVarint(code, pc); pc = r.nextPc; stack.push(deps[r.value]); break; }
        case OP.ENV_FEAT: {
          let feat = 0;
          const nav = deps[15], doc = deps[11];
          if (nav && typeof nav === 'object' && 'userAgent' in nav) feat ^= 0x21;
          if (doc && typeof doc === 'object' && 'createElement' in doc) feat ^= 0x43;
          if (deps[4] && typeof deps[4].now === 'function') feat ^= 0x55;
          if (deps[7]) feat ^= 0x67;
          if (deps[22] && typeof deps[22] === 'function') feat ^= 0x33;
          stack.push(feat);
          break;
        }
        case OP.RAND: {
          const nonce = String(regs[3]);
          let h = 0;
          for (let i = 0; i < nonce.length; i++) h = ((h << 3) ^ nonce.charCodeAt(i)) & 0xFF;
          stack.push(h);
          break;
        }
        case OP.CMP_EQ: { const b = stack.pop(); const a = stack.pop(); stack.push(a === b ? 1 : 0); break; }
        case OP.MUL: { const b = stack.pop(); const a = stack.pop(); stack.push(a * b); break; }
        case OP.HASH_INIT: {
          this.hashState = new Uint8Array(32);
          for (let i = 0; i < 32; i++) this.hashState[i] = sbox[i] ^ 0x5A;
          this.hashIdx = 0;
          break;
        }
        case OP.HASH_UPDATE: {
          const byte = stack.pop() & 0xFF;
          const idx = this.hashIdx;
          const mixed = sbox[byte ^ this.hashState[idx]];
          this.hashState[idx] = (this.hashState[idx] ^ mixed) & 0xFF;
          const nextIdx = (idx + 7) % 32;
          this.hashState[nextIdx] = (this.hashState[nextIdx] ^ sbox[mixed ^ 0xA5]) & 0xFF;
          this.hashIdx = (idx + 1) % 32;
          break;
        }
        case OP.HASH_FINAL: {
          let hex = '';
          for (let i = 0; i < 32; i++) hex += this.hashState[i].toString(16).padStart(2, '0');
          if (this.dbgTriggered) {
            let corrupted = '';
            for (let i = 0; i < hex.length; i++) corrupted += (parseInt(hex[i], 16) ^ 0x5).toString(16);
            hex = corrupted;
          }
          stack.push(hex);
          break;
        }
        case OP.NOP: break;
        case OP.DBG_CHECK: {
          if (this.dbgStartTime > 0) {
            const elapsed = deps[4].now() - this.dbgStartTime;
            if (elapsed > 500) this.dbgTriggered = true;
          }
          break;
        }
        case OP.RETURN: return stack.pop();
        case OP.DUP: stack.push(stack[stack.length - 1]); break;
        case OP.SWAP: { const t = stack[stack.length - 1]; stack[stack.length - 1] = stack[stack.length - 2]; stack[stack.length - 2] = t; break; }
        case OP.TO_STR: { const v = stack.pop(); stack.push(typeof v === 'number' ? String.fromCharCode(v & 0xFF) : String(v)); break; }
        case OP.MOD: { const b = stack.pop(); const a = stack.pop(); stack.push(b === 0 ? 0 : a % b); break; }
        case OP.DECRYPT_INNER: {
          const r = this.readVarint(code, pc); pc = r.nextPc;
          const encBytes = hexToBytes(this.strPool[r.value]);
          const decBytes = new Uint8Array(encBytes.length);
          for (let i = 0; i < encBytes.length; i++) decBytes[i] = encBytes[i] ^ sbox[i % 256];
          regs[31] = bytesToHex(decBytes);
          break;
        }
        case OP.EXEC_INNER: {
          const innerBytes = hexToBytes(regs[31]);
          const result = this.execute(innerBytes, 0);
          stack.push(result);
          break;
        }
        default: throw new Error('Unknown opcode: 0x' + op.toString(16));
      }
    }
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }
}

// ======================= 服务端签名函数 =======================

function vmSign(path, body, ts, nonce, salt) {
  try {
    const vm = new VM(SBOX_HEX, B64_ALPHABET, OUTER_BC, STR_POOL, false);
    return vm.run(path, body, ts, nonce, salt);
  } catch (e) {
    return 'ERR:' + Math.random().toString(36).substr(2, 10);
  }
}

// ======================= 客户端 VM 代码生成 =======================

// ===== 客户端 VM 源码加密 =====
//
// 安全模型:
//   旧方案: VM.toString() 直接输出 class VM 源码 → AI 阅读 → 生成 Node.js 脚本 → 破解
//   新方案: VM 源码经双层 XOR 加密 → 解码器桩在浏览器中解密 → new Function 执行
//
//   解码器桩逻辑:
//     1. 从 hex 重建 SBOX
//     2. 浏览器环境检查 → 从 SBOX 查表获取检查值 (非硬编码常量)
//     3. 派生密钥: key[j] = SBOX[(salt+ko[j])%256] ^ checkVal[j]
//     4. 解密: src[i] = enc[i] ^ SBOX[(i+salt)%256] ^ key[i%4]
//     5. new Function(src)() 执行
//
//   在浏览器中: 4 项检查全部通过 → 检查值正确 → 密钥正确 → 源码正确解密
//   在 Node.js 中: 检查失败 → 检查值=0 → 密钥错误 → 源码乱码 → 无法执行
//
//   每次页面加载: salt + 检查位置随机 → 加密结果不同 → 防重放

function generateObfuscatedClientVM() {
  // 1. 构建 VM 完整源码 (所有依赖打包为一个字符串)
  const vmSource = [
    'var OP=' + JSON.stringify(OP) + ';',
    'var B64_ALPHABET=' + JSON.stringify(B64_ALPHABET) + ';',
    'var SBOX_HEX=' + JSON.stringify(SBOX_HEX) + ';',
    hexToBytes.toString(),
    bytesToHex.toString(),
    createDeps.toString(),
    VM.toString(),
    'var __vm=new VM(SBOX_HEX,B64_ALPHABET,' + JSON.stringify(OUTER_BC) + ',' + JSON.stringify(STR_POOL) + ',true);',
    'return function(p,b,t,n,s){return __vm.run(p,b,t,n,s);};',
  ].join('\n');

  // 2. 随机加密参数 (每次页面加载不同)
  const salt = Math.floor(Math.random() * 256);
  const cp = [
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ];
  const ko = [0x37, 0x5A, 0x73, 0x29];

  // 3. 计算密钥 (假设浏览器环境: 检查值 = SBOX[cp[j]])
  const keyBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    keyBytes[i] = SBOX[(salt + ko[i]) % 256] ^ SBOX[cp[i]];
  }

  // 4. 双层 XOR 加密
  const srcBytes = Buffer.from(vmSource, 'utf8');
  const encrypted = new Uint8Array(srcBytes.length);
  for (let i = 0; i < srcBytes.length; i++) {
    let b = srcBytes[i];
    b ^= keyBytes[i % 4];            // 第一层: 密钥 XOR
    b ^= SBOX[(i + salt) % 256];     // 第二层: SBOX 位置密钥流
    encrypted[i] = b;
  }
  const encHex = bytesToHex(encrypted);

  // 5. 构建解码器桩 (混淆变量名, 紧凑格式)
  const decoder = '(function(){' +
    'var _e="' + encHex + '";' +
    'var _h="' + SBOX_HEX + '";' +
    'var _n=' + salt + ';' +
    'var _p=[' + cp.join(',') + '];' +
    'var _o=[' + ko.join(',') + '];' +
    'var _b=new Uint8Array(_h.length/2);' +
    'for(var i=0;i<_h.length;i+=2)_b[i/2]=parseInt(_h.substr(i,2),16);' +
    'var _c=[0,0,0,0];' +
    'try{' +
    'if(typeof window!=="undefined"&&window.chrome)_c[0]=_b[_p[0]];' +
    'if(typeof document!=="undefined"&&typeof document.querySelectorAll==="function")_c[1]=_b[_p[1]];' +
    'if(typeof navigator!=="undefined"&&navigator.userAgent&&navigator.userAgent.indexOf("Mozilla")>=0)_c[2]=_b[_p[2]];' +
    'if(typeof performance!=="undefined"&&typeof performance.now==="function")_c[3]=_b[_p[3]];' +
    '}catch(e){}' +
    'var _k=[' +
    '_b[(_n+_o[0])%256]^_c[0],' +
    '_b[(_n+_o[1])%256]^_c[1],' +
    '_b[(_n+_o[2])%256]^_c[2],' +
    '_b[(_n+_o[3])%256]^_c[3]' +
    '];' +
    'var _d=new Uint8Array(_e.length/2);' +
    'for(var i=0;i<_e.length;i+=2)_d[i/2]=parseInt(_e.substr(i,2),16);' +
    'var _dec=new Uint8Array(_d.length);' +
    'for(var i=0;i<_d.length;i++)_dec[i]=_d[i]^_b[(i+_n)%256]^_k[i%4];' +
    'var _r="";' +
    'if(typeof TextDecoder!=="undefined"){_r=new TextDecoder().decode(_dec);}' +
    'else{for(var i=0;i<_dec.length;i++)_r+=String.fromCharCode(_dec[i]);}' +
    'try{return new Function(_r)();}catch(e){return null;}' +
    '})()';

  return decoder;
}

// ======================= 导出 =======================

module.exports = { vmSign, generateObfuscatedClientVM, VM, STR_POOL, OUTER_BC, SBOX_HEX, B64_ALPHABET, OP, INNER_BC, ENCRYPTED_INNER, hexToBytes, bytesToHex };
