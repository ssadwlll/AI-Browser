/**
 * 小红书 x-s-common 签名生成器 - 纯 Node.js 实现
 *
 * 从 vendor-dynamic.8cd1891c.js 模块 41439 逆向提取
 *
 * 生成流程:
 *   1. 构建 payload 对象 en = {s0, s1, x0~x12}
 *   2. JSON.stringify(en)
 *   3. encodeUtf8(str) → byte array
 *   4. b64Encode(bytes) → 自定义 Base64 编码
 *   5. 结果即为 x-s-common 值
 *
 * 关键函数:
 *   - b64Encode: 使用自定义字母表 ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5
 *   - encodeUtf8: encodeURIComponent → byte array
 *   - w (tb): CRC32 变体哈希函数
 *   - crc32: 标准 CRC32
 */

'use strict';

// ======================= 自定义 Base64 字母表 =======================

const B64_CHARS = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';
const B64_TABLE = B64_CHARS.split('');

// ======================= encodeUtf8 =======================

function encodeUtf8(str) {
  const encoded = encodeURIComponent(str);
  const result = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded.charAt(i);
    if (ch === '%') {
      const byte = parseInt(encoded.charAt(i + 1) + encoded.charAt(i + 2), 16);
      result.push(byte);
      i += 2;
    } else {
      result.push(ch.charCodeAt(0));
    }
  }
  return result;
}

// ======================= b64Encode (自定义 Base64) =======================

function tripletToBase64(num) {
  return B64_TABLE[num >> 18 & 63] + B64_TABLE[num >> 12 & 63] + B64_TABLE[num >> 6 & 63] + B64_TABLE[num & 63];
}

function encodeChunk(bytes, start, end) {
  const result = [];
  for (let i = start; i < end; i += 3) {
    const num = (bytes[i] << 16 & 0xff0000) + (bytes[i + 1] << 8 & 65280) + (255 & bytes[i + 2]);
    result.push(tripletToBase64(num));
  }
  return result.join('');
}

function b64Encode(bytes) {
  const len = bytes.length;
  const remainder = len % 3;
  const chunks = [];
  const chunkSize = 16383;
  let i = 0;
  const mainLen = len - remainder;

  for (; i < mainLen; i += chunkSize) {
    chunks.push(encodeChunk(bytes, i, Math.min(i + chunkSize, mainLen)));
  }

  if (remainder === 1) {
    const a = bytes[len - 1];
    chunks.push(B64_TABLE[a >> 2] + B64_TABLE[a << 4 & 63] + '==');
  } else if (remainder === 2) {
    const a = (bytes[len - 2] << 8) + bytes[len - 1];
    chunks.push(B64_TABLE[a >> 10] + B64_TABLE[a >> 4 & 63] + B64_TABLE[a << 2 & 63] + '=');
  }

  return chunks.join('');
}

// ======================= CRC32 变体 (w 函数 / tb) =======================

function makeCrc32Variant() {
  const polynomial = 0xedb88320;
  const table = new Array(256);

  for (let i = 255; i >= 0; i--) {
    let r = i;
    for (let j = 8; j > 0; j--) {
      if (r & 1) {
        r = (r >>> 1) ^ polynomial;
      } else {
        r = r >>> 1;
      }
    }
    table[i] = r >>> 0;
  }

  return function (data) {
    let crc = -1;
    if (typeof data === 'string') {
      for (let i = 0; i < data.length; i++) {
        crc = table[255 & crc ^ data.charCodeAt(i)] ^ (crc >>> 8);
      }
    } else {
      for (let i = 0; i < data.length; i++) {
        crc = table[255 & crc ^ data[i]] ^ (crc >>> 8);
      }
    }
    return (-1 ^ crc) ^ polynomial;
  };
}

const tb = makeCrc32Variant();

// ======================= 标准 CRC32 (kn) =======================

function crc32(str) {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let a = i;
    for (let j = 0; j < 8; j++) {
      if (a & 1) {
        a = 0xedb88320 ^ (a >>> 1);
      } else {
        a = a >>> 1;
      }
    }
    table[i] = a;
  }

  let crc = -1;
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8) ^ table[255 & (crc ^ str.charCodeAt(i))];
  }
  return (-1 ^ crc) >>> 0;
}

// ======================= x-s-common 生成 =======================

/**
 * 生成 x-s-common
 * @param {Object} options - 配置选项
 * @param {string} options.platform - 平台标识 (如 'PC')
 * @param {string} options.url - 请求 URL
 * @param {string} options.mnsToken - X-Mns 头 (可选)
 * @param {string} options.xsSign - X-Sign 头 (可选)
 * @param {string} options.cookieA1 - a1 cookie 值
 * @param {string} options.fingerprint - localStorage 中的指纹值 (w.q2)
 * @param {string} options.version - 指纹版本 (localStorage w.z7 或默认 w.fI)
 * @param {string} options.dsl - window._dsl 值
 * @param {number} options.sigCount - 签名计数
 * @returns {string} x-s-common 值
 */
function generateXsCommon(options = {}) {
  const {
    platform = 'PC',
    url = '',
    mnsToken = '',   // R 变量 (X-Mns 相关)
    xsSign = '',     // I 变量 (X-Sign 头)
    cookieA1 = '',   // x5 字段 (a1 cookie)
    fingerprint = '', // x8 字段 (localStorage w.q2)
    version = '4.3.7', // x0 字段 (localStorage w.z7 或 w.fI)
    dsl = '',        // x12 字段 (localStorage w.br + window._dsl)
    sigCount = 0,    // x10 字段
  } = options;

  // 构建 payload 对象 en
  const en = {
    s0: 5,            // (0,v.SW)(u) → 固定值 5
    s1: '',           // 空字符串
    x0: version,      // 指纹版本
    x1: 'web',        // w.i8 → 固定值 'web'
    x2: platform,     // 平台
    x3: 'xhs-pc-web', // 应用 ID
    x4: '6.31.2',     // webBuild 版本
    x5: cookieA1,     // a1 cookie 值
    x6: mnsToken,     // X-Mns 相关 (R 变量)
    x7: xsSign,       // X-Sign 头 (I 变量)
    x8: fingerprint,  // localStorage 指纹 (G 变量)
    x9: tb(`${mnsToken}${xsSign}${fingerprint}`), // CRC32 哈希
    x10: sigCount,    // 签名计数
    x11: 'normal',    // 固定值
    x12: dsl,         // localStorage w.br + window._dsl
  };

  // 生成 x-s-common: encodeUtf8 → b64Encode
  const jsonStr = JSON.stringify(en);
  const bytes = encodeUtf8(jsonStr);
  return b64Encode(bytes);
}

// ======================= 导出 =======================

module.exports = {
  generateXsCommon,
  b64Encode,
  encodeUtf8,
  tb,
  crc32,
  B64_CHARS,
};

// ======================= 测试 =======================

if (require.main === module) {
  console.log('=== x-s-common 生成器测试 ===\n');

  // 测试1: 基本功能
  const xsc = generateXsCommon({
    platform: 'PC',
    url: '/api/sns/web/v1/feed',
    cookieA1: '19c8eaa1ff3spyelsj2p2752b30l5wnu5a2iv9kfb50000150045',
    fingerprint: '',
    version: '4.3.7',
    dsl: '',
    sigCount: 0,
  });
  console.log('生成的 x-s-common:');
  console.log(xsc.substring(0, 100) + '...');
  console.log('长度:', xsc.length);
  console.log('前4字符:', xsc.substring(0, 4), '(期望: 2UQA)');

  // 测试2: encodeUtf8
  console.log('\n=== encodeUtf8 测试 ===');
  const testStr = '{"s0":5,"s1":"","x0":"4.3.7"}';
  const bytes = encodeUtf8(testStr);
  console.log('输入:', testStr);
  console.log('输出 bytes:', bytes.slice(0, 20), '...');
  console.log('字节数:', bytes.length);

  // 测试3: b64Encode
  console.log('\n=== b64Encode 测试 ===');
  const encoded = b64Encode(bytes);
  console.log('编码结果:', encoded.substring(0, 50), '...');
  console.log('长度:', encoded.length);

  // 测试4: tb (CRC32 变体)
  console.log('\n=== tb (CRC32变体) 测试 ===');
  console.log('tb(""):', tb(''));
  console.log('tb("test"):', tb('test'));
  console.log('tb("abc"):', tb('abc'));

  // 测试5: 对比 err.json 中的真实 x-s-common
  console.log('\n=== 对比真实 x-s-common ===');
  const realFeedXsc = '2UQAPsHC+aIjqArjwjHjNsQhPsHCH0rjNsQhPaHCH0c1PUh7HjIj2eHjwjQgynEDJ74AHjIj2ePjwjQhyoPTqBPT49pjHjIj2ecjwjH9N0PlN0HjNsQh+aHCH0rEGAYSGnrl8fGAq7mE8nlAy0QIP0qMPfHAPBIM49EM+nrUygGEy98j+/ZIPeZl+/ZI+eLjNsQh+jHCHjHVHdW7H0ijHjIj2eWjwjQQPAYUaBzdq9k6qB4Q4fpA8b878FSet9RQzLlTcSiM8/+n4MYP8FMMHjIj2eDjwjF7+/qFP/ZIPePVHdWlPsHCPsIj2erlH0ijJfRUJnbVHjIj2erUH0ijP/qhPALE+0q7w/ZI+0Vl+AWI+/cMPeGl+/GMHdF=';
  console.log('真实 feed x-s-common 长度:', realFeedXsc.length);
  console.log('真实 feed x-s-common 前30:', realFeedXsc.substring(0, 30));
  console.log('生成 x-s-common 前30:', xsc.substring(0, 30));
  console.log('前缀匹配:', realFeedXsc.substring(0, 4) === xsc.substring(0, 4) ? '✅' : '❌');
}
