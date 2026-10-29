/* ==========================================================================
   crypto-utils.js — 通用密码学工具
   - AES-ECB / AES-CBC (Web Crypto API)
   - Buffer 工具
   - CRC32
   - MD5 (基于 spark-md5 的 JKM md5 实现, MIT license)
   ========================================================================== */

(function (global) {
  'use strict';

  // ---------- Buffer helpers --------------------------------------------------
  const BufferUtil = {
    toHex(buf) {
      const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
      return s;
    },

    fromHex(hex) {
      const len = hex.length / 2;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return out;
    },

    toUtf8(buf) {
      return new TextDecoder('utf-8').decode(buf);
    },

    toLatin1(buf) {
      return new TextDecoder('latin1').decode(buf);
    },

    fromLatin1(str) {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    },

    fromUtf8(str) {
      return new TextEncoder().encode(str);
    },

    concat(arrays) {
      let total = 0;
      for (const a of arrays) total += a.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const a of arrays) { out.set(a, off); off += a.length; }
      return out;
    },

    slice(buf, start, end) {
      return new Uint8Array(buf.buffer, buf.byteOffset + start, (end ?? buf.length) - start);
    },

    readUInt32LE(buf, offset = 0) {
      const v = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
      return v >>> 0;
    },
  };

  // ---------- AES via Web Crypto API -----------------------------------------
  // AES-ECB is NOT in the WebCrypto spec (and not in Node 22's webcrypto either).
  // We use aes-js (https://github.com/ricmoo/aes-js, MIT) loaded as a global
  // via <script> tag. Falls back to a no-op error if aes-js failed to load.
  // 纯 JS 实现, 128 字节 key 解密 ~1ms, 完全够用 (NCM key/meta 都很小).
  async function aesEcbDecrypt(data, key) {
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
      throw new Error('AES key must be 16/24/32 bytes, got ' + key.length);
    }
    if (typeof globalThis.aesjs === 'undefined') {
      throw new Error('aes-js 未加载 (globalThis.aesjs 不存在)');
    }
    const aesEcb = new globalThis.aesjs.ModeOfOperation.ecb(key);
    // aes-js 逐 block 解密, 保留所有字节 (包括 PKCS#7 padding)
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 16) {
      const block = data.slice(off, off + 16);
      const dec = aesEcb.decrypt(block);
      out.set(dec, off);
    }
    return out;
  }

  async function aesCbcDecrypt(data, key, iv) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'AES-CBC' }, false, ['decrypt']
    );
    const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
    return new Uint8Array(pt);
  }

  function buildAesKeyFromHex(hex, length = 16) {
    let raw = hex;
    while (raw.length < length * 2) raw += hex;
    return BufferUtil.fromHex(raw.substr(0, length * 2));
  }

  // ---------- CRC32 -----------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- MD5 -------------------------------------------------------------
  // Based on Joseph Myers' JKM md5 implementation (MIT licensed),
  // which is the fastest & most reliable public-domain MD5 in JS.
  // Reference: http://www.myersdaily.org/joseph/javascript/md5-text.html
  function md5(input) {
    const bytes = typeof input === 'string' ? BufferUtil.fromUtf8(input) : input;

    function add32(a, b) { return (a + b) | 0; }
    function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32(rol(a, s), b);
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

    function md5cycle(state, block) {
      let a = state[0], b = state[1], c = state[2], d = state[3];

      a = ff(a, b, c, d, block[0],  7, -680876936);
      d = ff(d, a, b, c, block[1], 12, -389564586);
      c = ff(c, d, a, b, block[2], 17,  606105819);
      b = ff(b, c, d, a, block[3], 22, -1044525330);
      a = ff(a, b, c, d, block[4],  7, -176418897);
      d = ff(d, a, b, c, block[5], 12,  1200080426);
      c = ff(c, d, a, b, block[6], 17, -1473231341);
      b = ff(b, c, d, a, block[7], 22, -45705983);
      a = ff(a, b, c, d, block[8],  7,  1770035416);
      d = ff(d, a, b, c, block[9], 12, -1958414417);
      c = ff(c, d, a, b, block[10], 17, -42063);
      b = ff(b, c, d, a, block[11], 22, -1990404162);
      a = ff(a, b, c, d, block[12],  7,  1804603682);
      d = ff(d, a, b, c, block[13], 12, -40341101);
      c = ff(c, d, a, b, block[14], 17, -1502002290);
      b = ff(b, c, d, a, block[15], 22,  1236535329);

      a = gg(a, b, c, d, block[1],  5, -165796510);
      d = gg(d, a, b, c, block[6],  9, -1069501632);
      c = gg(c, d, a, b, block[11], 14,  643717713);
      b = gg(b, c, d, a, block[0], 20, -373897302);
      a = gg(a, b, c, d, block[5],  5, -701558691);
      d = gg(d, a, b, c, block[10],  9,  38016083);
      c = gg(c, d, a, b, block[15], 14, -660478335);
      b = gg(b, c, d, a, block[4], 20, -405537848);
      a = gg(a, b, c, d, block[9],  5,  568446438);
      d = gg(d, a, b, c, block[14],  9, -1019803690);
      c = gg(c, d, a, b, block[3], 14, -187363961);
      b = gg(b, c, d, a, block[8], 20,  1163531501);
      a = gg(a, b, c, d, block[13],  5, -1444681467);
      d = gg(d, a, b, c, block[2],  9, -51403784);
      c = gg(c, d, a, b, block[7], 14,  1735328473);
      b = gg(b, c, d, a, block[12], 20, -1926607734);

      a = hh(a, b, c, d, block[5],  4, -378558);
      d = hh(d, a, b, c, block[8], 11, -2022574463);
      c = hh(c, d, a, b, block[11], 16,  1839030562);
      b = hh(b, c, d, a, block[14], 23, -35309556);
      a = hh(a, b, c, d, block[1],  4, -1530992060);
      d = hh(d, a, b, c, block[4], 11,  1272893353);
      c = hh(c, d, a, b, block[7], 16, -155497632);
      b = hh(b, c, d, a, block[10], 23, -1094730640);
      a = hh(a, b, c, d, block[13],  4,  681279174);
      d = hh(d, a, b, c, block[0], 11, -358537222);
      c = hh(c, d, a, b, block[3], 16, -722521979);
      b = hh(b, c, d, a, block[6], 23,  76029189);
      a = hh(a, b, c, d, block[9],  4, -640364487);
      d = hh(d, a, b, c, block[12], 11, -421815835);
      c = hh(c, d, a, b, block[15], 16,  530742520);
      b = hh(b, c, d, a, block[2], 23, -995338651);

      a = ii(a, b, c, d, block[0],  6, -198630844);
      d = ii(d, a, b, c, block[7], 10,  1126891415);
      c = ii(c, d, a, b, block[14], 15, -1416354905);
      b = ii(b, c, d, a, block[5], 21, -57434055);
      a = ii(a, b, c, d, block[12],  6,  1700485571);
      d = ii(d, a, b, c, block[3], 10, -1894986606);
      c = ii(c, d, a, b, block[10], 15, -1051523);
      b = ii(b, c, d, a, block[1], 21, -2054922799);
      a = ii(a, b, c, d, block[8],  6,  1873313359);
      d = ii(d, a, b, c, block[15], 10, -30611744);
      c = ii(c, d, a, b, block[6], 15, -1560198380);
      b = ii(b, c, d, a, block[13], 21,  1309151649);
      a = ii(a, b, c, d, block[4],  6, -145523070);
      d = ii(d, a, b, c, block[11], 10, -1120210379);
      c = ii(c, d, a, b, block[2], 15,  718787259);
      b = ii(b, c, d, a, block[9], 21, -343485551);

      state[0] = add32(a, state[0]);
      state[1] = add32(b, state[1]);
      state[2] = add32(c, state[2]);
      state[3] = add32(d, state[3]);
    }

    function md51(bytes) {
      const n = bytes.length;
      const state = [1732584193, -271733879, -1732584194, 271733878];
      let i;

      // Process full 64-byte blocks
      const block = new Array(16);
      for (i = 64; i <= n; i += 64) {
        for (let j = 0; j < 16; j++) {
          block[j] =
            (bytes[i - 64 + j * 4]) |
            (bytes[i - 64 + j * 4 + 1] << 8) |
            (bytes[i - 64 + j * 4 + 2] << 16) |
            (bytes[i - 64 + j * 4 + 3] << 24);
        }
        md5cycle(state, block);
      }

      // Final partial block(s) with padding
      const tail = new Array(16);
      tail.fill(0);
      const remaining = i - 64 < n ? n - (i - 64) : 0;
      for (let k = 0; k < remaining; k++) {
        tail[k >>> 2] |= bytes[(i - 64) + k] << ((k & 3) << 3);
      }
      // Append 0x80
      tail[remaining >>> 2] |= 0x80 << ((remaining & 3) << 3);

      // If there's no room for the 8-byte length, this is the final block
      const totalLen = n;
      if (remaining > 55) {
        md5cycle(state, tail);
        tail.fill(0);
      }

      // Append length in bits as 64-bit LE
      const bitLen = totalLen * 8;
      // low 32 bits
      tail[14] = (bitLen >>> 0);
      // high 32 bits
      tail[15] = Math.floor(bitLen / 0x100000000);

      md5cycle(state, tail);
      return state;
    }

    function rhex(n) {
      let s = '';
      for (let j = 0; j < 4; j++) s += ((n >>> (j * 8)) & 0xff).toString(16).padStart(2, '0');
      return s;
    }

    const state = md51(bytes);
    return rhex(state[0]) + rhex(state[1]) + rhex(state[2]) + rhex(state[3]);
  }

  // ---------- Tencent Tea cipher (used by QMC v2 key decryption) ----------
  // 标准 32 rounds TEA + CBC 包装, 跟 unlock-music QmcWasm 一致
  const TEA_DELTA = 0x9E3779B9;
  // Tencent 的 tc_tea 变体用 16 轮 (不是标准 TEA 的 32 轮),
  // 与 Rust um_crypto / test/xval-vectors/qmc_ref.py 的 TEA_ROUNDS=16 一致。
  const TEA_ROUNDS = 16;

  function teaDecryptBlock(block, key) {
    // block: Uint8Array 8 bytes, key: 16 bytes
    // 使用大端 (TCP/IP 网络序) — 跟 unlock-music ntohl 一致
    //
    // 轮数是 16 不是 32: 这是 Tencent 的 tc_tea 变体 (TEA_ROUNDS=16),
    // 与 Rust um_crypto / qmc_ref.py 一致。32 轮解出来的是垃圾,
    // 会以 "Tea CBC: zero check failed" 报错。
    const v = new DataView(block.buffer, block.byteOffset, 8);
    let y = v.getUint32(0, false);  // big-endian read
    let z = v.getUint32(4, false);
    const k = new DataView(key.buffer, key.byteOffset, 16);
    const k0 = k.getUint32(0, false), k1 = k.getUint32(4, false);
    const k2 = k.getUint32(8, false), k3 = k.getUint32(12, false);
    let sum = (TEA_DELTA * TEA_ROUNDS) >>> 0;
    for (let i = 0; i < TEA_ROUNDS; i++) {
      z = (z - (((y << 4) + k2) ^ (y + sum) ^ ((y >>> 5) + k3))) >>> 0;
      y = (y - (((z << 4) + k0) ^ (z + sum) ^ ((z >>> 5) + k1))) >>> 0;
      sum = (sum - TEA_DELTA) >>> 0;
    }
    const out = new Uint8Array(8);
    const o = new DataView(out.buffer);
    o.setUint32(0, y, false);
    o.setUint32(4, z, false);
    return out;
  }

  function teaEncryptBlock(block, key) {
    const v = new DataView(block.buffer, block.byteOffset, 8);
    let y = v.getUint32(0, false);
    let z = v.getUint32(4, false);
    const k = new DataView(key.buffer, key.byteOffset, 16);
    const k0 = k.getUint32(0, false), k1 = k.getUint32(4, false);
    const k2 = k.getUint32(8, false), k3 = k.getUint32(12, false);
    let sum = 0;
    for (let i = 0; i < TEA_ROUNDS; i++) {
      sum = (sum + TEA_DELTA) >>> 0;
      y = (y + (((z << 4) + k0) ^ (z + sum) ^ ((z >>> 5) + k1))) >>> 0;
      z = (z + (((y << 4) + k2) ^ (y + sum) ^ ((y >>> 5) + k3))) >>> 0;
    }
    const out = new Uint8Array(8);
    const o = new DataView(out.buffer);
    o.setUint32(0, y, false);
    o.setUint32(4, z, false);
    return out;
  }

  // CBC 解密 (Tencent 格式: PadLen(1) + Padding(0-7) + Salt(2) + Body + Zero(7))
  function teaDecryptCBC(inBuf, key) {
    if (inBuf.length % 8 !== 0 || inBuf.length < 16) throw new Error('Tea CBC: invalid input size');
    let tmp = teaDecryptBlock(inBuf.subarray(0, 8), key);
    const nPadLen = tmp[0] & 0x7;
    const outLen = inBuf.length - 1 - nPadLen - 2 - 7;
    if (outLen < 0) throw new Error('Tea CBC: invalid out length');
    const out = new Uint8Array(outLen);
    let ivPrev = new Uint8Array(8);
    let ivCur = inBuf.subarray(0, 8);
    let inPos = 8;
    let tmpIdx = 1 + nPadLen;
    // 跳过 Salt (2 bytes)
    for (let i = 0; i < 2; ) {
      if (tmpIdx < 8) { tmpIdx++; i++; }
      else {
        ivPrev = ivCur;
        ivCur = inBuf.subarray(inPos, inPos + 8);
        for (let j = 0; j < 8; j++) tmp[j] ^= ivCur[j];
        tmp = teaDecryptBlock(tmp, key);
        inPos += 8;
        tmpIdx = 0;
      }
    }
    // 读取 Body
    let outPos = 0;
    while (outPos < outLen) {
      if (tmpIdx < 8) {
        out[outPos] = tmp[tmpIdx] ^ ivPrev[tmpIdx];
        outPos++;
        tmpIdx++;
      } else {
        ivPrev = ivCur;
        ivCur = inBuf.subarray(inPos, inPos + 8);
        for (let j = 0; j < 8; j++) tmp[j] ^= ivCur[j];
        tmp = teaDecryptBlock(tmp, key);
        inPos += 8;
        tmpIdx = 0;
      }
    }
    // 校验 Zero
    for (let i = 1; i <= 7; i++) {
      if (tmp[tmpIdx] !== ivPrev[tmpIdx]) throw new Error('Tea CBC: zero check failed');
    }
    return out;
  }

  // ---------- base64 工具 (atob/btoa 包装) ---------------------------------
  //
  // 环境判定用「全局 Buffer 存不存在」, 不能用 BufferUtil 自己的方法 ——
  // BufferUtil.fromUtf8 在任何环境都存在, 拿它当判据会永远走进 Node 分支,
  // 然后去调一个根本不存在的 BufferUtil.from, 于是任何环境都抛错。
  //
  // 浏览器 / Web Worker: 只有 atob
  // Node: 有 Buffer.from(str, 'base64')
  function base64Decode(str) {
    if (typeof globalThis !== 'undefined' &&
        typeof globalThis.Buffer !== 'undefined' &&
        typeof globalThis.Buffer.from === 'function') {
      return new Uint8Array(globalThis.Buffer.from(str, 'base64'));
    }
    // 浏览器 / Web Worker 环境
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- Export ----------------------------------------------------------
  global.CU = {
    Buffer: BufferUtil,
    aesEcbDecrypt,
    aesCbcDecrypt,
    buildAesKeyFromHex,
    crc32,
    md5,
    teaDecryptCBC,
    base64Decode,
  };
})(typeof window !== 'undefined' ? window : globalThis);
