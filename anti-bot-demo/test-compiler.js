/**
 * 测试 VM 编译器
 * 
 * 运行: node test-compiler.js
 */

const { compile } = require('./vm-compiler');
const { vmSign, SBOX_HEX, INNER_BC, ENCRYPTED_INNER, STR_POOL } = require('./vm-sign');

console.log('========== 1. DSL 源码 ==========');
const DSL = `
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
console.log(DSL);

console.log('========== 2. 编译结果 ==========');
const compiled = compile(DSL);
console.log('指令数量:', compiled.instructions.length);
console.log('字符串池:', compiled.strPoolStrings);

console.log('\n========== 3. 字节码（前100字符）==========');
// 需要用 assemble 函数
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

function encodeVarint(n) {
  const bytes = [];
  do {
    let b = n & 0x7F;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return bytes;
}

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
      for (const a of inst.args) {
        let v = a, s = 0;
        do { s++; v = Math.floor(v / 128); } while (v > 0);
        size += s;
      }
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

const bytecode = assemble(compiled.instructions);
console.log('字节码长度:', bytecode.length, '字符（', bytecode.length / 2, '字节）');
console.log('字节码前200字符:', bytecode.substring(0, 200));

console.log('\n========== 4. 运行签名 ==========');
const path = '/api/data';
const body = '{"test":"data"}';
const ts = Date.now().toString();
const nonce = 'abc123';
const salt = 'test_salt';

const signature = vmSign(path, body, ts, nonce, salt);
console.log('签名结果:', signature);

console.log('\n========== 5. 修改 DSL 后重新编译 ==========');
// 修改：for i = 0 to 14 → for i = 0 to 13
const DSL_MODIFIED = `
func sign(path, body, ts, nonce, salt):
    dbg_check()
    env = env_feat()
    rnd = rand()
    seed1 = 0xA3 ^ 0x5C ^ 0x7E ^ 0x21
    seed2 = 0x1F ^ 0x8B ^ 0xD4 ^ 0x06
    key = ""
    for i = 0 to 13:
        k = sbox[sbox[seed1 ^ i] ^ seed2]
        key = key + char(k)
    endfor
    key = salt + key
    keylen = len(key)
    data = path + body + ts + nonce
    hash_init()
    for counter = 0 to datalen:
        hash_update(0x42)
    endfor
    return hash_final()
endfunc
`;
const compiled2 = compile(DSL_MODIFIED);
const bytecode2 = assemble(compiled2.instructions);
console.log('修改后字节码长度:', bytecode2.length, '字符');
console.log('修改后字节码前200字符:', bytecode2.substring(0, 200));

console.log('\n========== 6. 加密后字节码 ==========');
console.log('加密前字节码长度:', INNER_BC.length);
console.log('加密后字节码长度:', ENCRYPTED_INNER.length);
console.log('加密后字节码前100字符:', ENCRYPTED_INNER.substring(0, 100));