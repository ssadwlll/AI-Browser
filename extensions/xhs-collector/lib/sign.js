/**
 * 小红书签名模块 — 在 content script (ISOLATED world) 中运行
 *
 * 包含：
 *   1. 自定义 Base64 编码（字母表与小红书一致）
 *   2. encodeUtf8 工具函数
 *   3. CRC32 变体 (tb 函数，用于 x-s-common 的 x9 字段)
 *   4. x-s-common 生成（纯 JS，与 xs-common-node.js 逻辑一致）
 *   5. XYS_ 签名构建（调用 MAIN world 的 window.mnsv2 获取签名核心）
 *
 * 依赖：lib/md5.js（window.XHS_MD5）
 */
(function () {
  'use strict';

  // ======================= 自定义 Base64 字母表 =======================

  var B64_CHARS = 'ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5';
  var B64_TABLE = B64_CHARS.split('');

  function tripletToBase64(num) {
    return B64_TABLE[num >> 18 & 63] + B64_TABLE[num >> 12 & 63] + B64_TABLE[num >> 6 & 63] + B64_TABLE[num & 63];
  }

  function encodeChunk(bytes, start, end) {
    var result = [];
    for (var i = start; i < end; i += 3) {
      var num = (bytes[i] << 16 & 0xff0000) + (bytes[i + 1] << 8 & 65280) + (255 & bytes[i + 2]);
      result.push(tripletToBase64(num));
    }
    return result.join('');
  }

  function b64Encode(bytes) {
    var len = bytes.length;
    var remainder = len % 3;
    var chunks = [];
    var chunkSize = 16383;
    var i = 0;
    var mainLen = len - remainder;

    for (; i < mainLen; i += chunkSize) {
      chunks.push(encodeChunk(bytes, i, Math.min(i + chunkSize, mainLen)));
    }

    if (remainder === 1) {
      var a = bytes[len - 1];
      chunks.push(B64_TABLE[a >> 2] + B64_TABLE[a << 4 & 63] + '==');
    } else if (remainder === 2) {
      var b = (bytes[len - 2] << 8) + bytes[len - 1];
      chunks.push(B64_TABLE[b >> 10] + B64_TABLE[b >> 4 & 63] + B64_TABLE[b << 2 & 63] + '=');
    }

    return chunks.join('');
  }

  function encodeUtf8(str) {
    var encoded = encodeURIComponent(str);
    var result = [];
    for (var i = 0; i < encoded.length; i++) {
      var ch = encoded.charAt(i);
      if (ch === '%') {
        result.push(parseInt(encoded.charAt(i + 1) + encoded.charAt(i + 2), 16));
        i += 2;
      } else {
        result.push(ch.charCodeAt(0));
      }
    }
    return result;
  }

  // ======================= CRC32 变体 (tb 函数) =======================

  function makeCrc32Variant() {
    var polynomial = 0xedb88320;
    var table = new Array(256);

    for (var i = 255; i >= 0; i--) {
      var r = i;
      for (var j = 8; j > 0; j--) {
        if (r & 1) {
          r = (r >>> 1) ^ polynomial;
        } else {
          r = r >>> 1;
        }
      }
      table[i] = r >>> 0;
    }

    return function (data) {
      var crc = -1;
      if (typeof data === 'string') {
        for (var k = 0; k < data.length; k++) {
          crc = table[255 & crc ^ data.charCodeAt(k)] ^ (crc >>> 8);
        }
      } else {
        for (var m = 0; m < data.length; m++) {
          crc = table[255 & crc ^ data[m]] ^ (crc >>> 8);
        }
      }
      return (-1 ^ crc) ^ polynomial;
    };
  }

  var tb = makeCrc32Variant();

  // ======================= x-s-common 生成 =======================

  /**
   * 生成 x-s-common
   * @param {Object} options
   * @param {string} options.cookieA1 - a1 cookie 值
   * @param {string} options.version - 指纹版本 (默认 4.3.7)
   * @param {number} options.sigCount - 签名计数
   * @returns {string} x-s-common 值
   */
  function generateXsCommon(options) {
    options = options || {};
    var cookieA1 = options.cookieA1 || '';
    var version = options.version || '4.3.7';
    var sigCount = options.sigCount || 0;
    var platform = options.platform || 'PC';

    var en = {
      s0: 5,
      s1: '',
      x0: version,
      x1: 'web',
      x2: platform,
      x3: 'xhs-pc-web',
      x4: '6.31.2',
      x5: cookieA1,
      x6: '',
      x7: '',
      x8: '',
      x9: tb(''),
      x10: sigCount,
      x11: 'normal',
      x12: '',
    };

    var jsonStr = JSON.stringify(en);
    var bytes = encodeUtf8(jsonStr);
    return b64Encode(bytes);
  }

  // ======================= XYS_ 签名构建 =======================

  /**
   * 构建 XYS_ 签名的 payload（不含 mnsv2 调用）
   *
   * seccore_signv2 算法：
   *   c = apiPath + JSON.stringify(body)
   *   u = MD5(c)
   *   p = MD5(apiPath)
   *   v = mnsv2(c, u, p)   ← 需要在 MAIN world 中调用
   *
   * @param {string} apiPath - API 路径
   * @param {string|object} body - 请求体
   * @returns {{ c: string, u: string, p: string, buildPayload: function }} 签名输入 + payload 构建器
   */
  function buildSignInput(apiPath, body) {
    var c = apiPath;
    if (body !== null && body !== undefined) {
      if (typeof body === 'object') c += JSON.stringify(body);
      else if (typeof body === 'string') c += body;
    }
    var u = window.XHS_MD5.hex(c);
    var p = window.XHS_MD5.hex(apiPath);

    return {
      c: c,
      u: u,
      p: p,
      /**
       * 用 mnsv2 返回值构建最终的 XYS_ 签名
       * @param {string} v - mnsv2(c, u, p) 的返回值
       * @returns {{ 'X-s': string, 'X-t': string }}
       */
      buildPayload: function (v) {
        var S = {
          x0: '4.3.7',
          x1: 'xhs-pc-web',
          x2: 'Windows',
          x3: v,
          x4: body ? typeof body : '',
        };
        var jsonStr = JSON.stringify(S);
        var utf8Bytes = encodeUtf8(jsonStr);
        var b64 = b64Encode(utf8Bytes);
        return {
          'X-s': 'XYS_' + b64,
          'X-t': String(Date.now()),
        };
      },
    };
  }

  // ======================= Cookie 工具 =======================

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : '';
  }

  // ======================= 暴露到全局 =======================

  window.XHS_SIGN = {
    generateXsCommon: generateXsCommon,
    buildSignInput: buildSignInput,
    b64Encode: b64Encode,
    encodeUtf8: encodeUtf8,
    tb: tb,
    getCookie: getCookie,
    B64_CHARS: B64_CHARS,
  };
})();
