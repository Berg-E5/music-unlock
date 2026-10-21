/*
 * qmc-mobile.js — QQ 音乐 Android 客户端 QMC 解密
 *
 * 移植自 cuizzzzzzzz/qqmusic-music-decrypt-algorithm
 * 原始算法逆向自 Android 客户端 libekey_decrypt.so (ARM64)
 *
 * 适用于: .mflac / .mflac0~5 / .mdolby / .mgg / .mgg0~2 / .qmc0 / .qmc3 / .qmc6
 * 走法:  ekey (base64) → SimpleMakeKey + TEA → 密钥流 → map_le 或分段 RC4 → XOR 流
 * 区别于 mzj3920/qqmusic-decrypt (PC 端 QMC2), 不能混用 ekey
 */
(function (root) {
  'use strict';

  // ============================================================
  // 1. SimpleMakeKey: byte = int(abs(tan(seed + i*0.1)) * 100) & 0xFF
  // ============================================================
  function simpleMakeKey(seed, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = Math.floor(Math.abs(Math.tan(seed + i * 0.1)) * 100) & 0xFF;
    }
    return out;
  }

  // ============================================================
  // 2. TEA 解密 (大端 64-bit, 16 轮)
  // ============================================================
  const TEA_DELTA = 0x9E3779B9;
  function teaDecryptBlock(v0, v1, key) {
    let s = (TEA_DELTA * 16) & 0xFFFFFFFF;
    for (let r = 0; r < 16; r++) {
      v1 = (v1 - (((v0 << 4) + key[2] ^ (v0 + s) ^ ((v0 >>> 5) + key[3])))) & 0xFFFFFFFF;
      v0 = (v0 - (((v1 << 4) + key[0] ^ (v1 + s) ^ ((v1 >>> 5) + key[1])))) & 0xFFFFFFFF;
      s = (s - TEA_DELTA) & 0xFFFFFFFF;
    }
    return [v0 >>> 0, v1 >>> 0];
  }

  // ============================================================
  // 3. oi_symmetry_decrypt2 (QQ 私有 TEA-ECB + 异或链)
  // ============================================================
  function oiSymmetryDecrypt2(ciphertext, teaKey) {
    const N = ciphertext.length;
    if (N & 7 || N <= 15) throw new Error('oi_symmetry_decrypt2: input length invalid (need >15 and multiple of 8)');

    const k = [
      (teaKey[0] << 24 | teaKey[1] << 16 | teaKey[2] << 8 | teaKey[3]) >>> 0,
      (teaKey[4] << 24 | teaKey[5] << 16 | teaKey[6] << 8 | teaKey[7]) >>> 0,
      (teaKey[8] << 24 | teaKey[9] << 16 | teaKey[10] << 8 | teaKey[11]) >>> 0,
      (teaKey[12] << 24 | teaKey[13] << 16 | teaKey[14] << 8 | teaKey[15]) >>> 0
    ];

    // 解密第一块
    let v0 = (ciphertext[0] << 24 | ciphertext[1] << 16 | ciphertext[2] << 8 | ciphertext[3]) >>> 0;
    let v1 = (ciphertext[4] << 24 | ciphertext[5] << 16 | ciphertext[6] << 8 | ciphertext[7]) >>> 0;
    let [d0, d1] = teaDecryptBlock(v0, v1, k);
    let scratch = new Uint8Array(8);
    scratch[0] = (d0 >>> 24) & 0xFF;
    scratch[1] = (d0 >>> 16) & 0xFF;
    scratch[2] = (d0 >>> 8) & 0xFF;
    scratch[3] = d0 & 0xFF;
    scratch[4] = (d1 >>> 24) & 0xFF;
    scratch[5] = (d1 >>> 16) & 0xFF;
    scratch[6] = (d1 >>> 8) & 0xFF;
    scratch[7] = d1 & 0xFF;

    const padFlag = scratch[0] & 7;
    const outLen = N - 10 - padFlag;
    if (outLen < 0) return new Uint8Array(0);

    let ptrA = new Uint8Array(8);   // zero
    let ptrB = ciphertext.subarray(0, 8);
    let nextOff = 8;
    const result = new Uint8Array(outLen);
    let outIdx = 0;
    let pos = 1 + padFlag;
    let phase = 1;

    function nextBlock() {
      ptrA = ptrB;
      const block = ciphertext.subarray(nextOff, nextOff + 8);
      ptrB = block;
      for (let j = 0; j < 8; j++) scratch[j] ^= block[j];
      const av = (scratch[0] << 24 | scratch[1] << 16 | scratch[2] << 8 | scratch[3]) >>> 0;
      const bv = (scratch[4] << 24 | scratch[5] << 16 | scratch[6] << 8 | scratch[7]) >>> 0;
      const [da, db] = teaDecryptBlock(av, bv, k);
      scratch[0] = (da >>> 24) & 0xFF; scratch[1] = (da >>> 16) & 0xFF;
      scratch[2] = (da >>> 8) & 0xFF;  scratch[3] = da & 0xFF;
      scratch[4] = (db >>> 24) & 0xFF; scratch[5] = (db >>> 16) & 0xFF;
      scratch[6] = (db >>> 8) & 0xFF;  scratch[7] = db & 0xFF;
      nextOff += 8;
    }

    // 跳过填充 (两阶段)
    while (phase <= 2) {
      if (pos <= 7) { pos++; phase++; }
      else if (pos === 8) { nextBlock(); pos = 0; }
      else break;
    }

    while (outIdx < outLen) {
      if (pos <= 7) {
        result[outIdx++] = scratch[pos] ^ ptrA[pos];
        pos++;
      } else if (pos === 8) {
        nextBlock();
        pos = 0;
      } else break;
    }

    return result;
  }

  // ============================================================
  // 4. derive_key: base64 ekey → (key_stream, key_length)
  // ============================================================
  function deriveKey(ekey) {
    // base64 解码
    let bin = atob(ekey);
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const N = raw.length;

    const simpleKey = simpleMakeKey(106, 8);
    // 交错合并: simple_key[i//2] if i%2==0 else raw[i//2]
    const mergedKey = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      mergedKey[i] = (i % 2 === 0) ? simpleKey[i >> 1] : raw[i >> 1];
    }

    const keyStream = new Uint8Array(raw.subarray(0, 8));
    if (N > 8) {
      const rest = oiSymmetryDecrypt2(raw.subarray(8), mergedKey);
      const out = new Uint8Array(keyStream.length + rest.length);
      out.set(keyStream, 0);
      out.set(rest, keyStream.length);
      return { keyStream: out, keyLength: out.length };
    }
    return { keyStream, keyLength: keyStream.length };
  }

  // ============================================================
  // 5. RC4 KSA + hash_base
  // ============================================================
  function rc4Ksa(keyStream, keyLength) {
    const S = new Uint8Array(keyLength);
    for (let i = 0; i < keyLength; i++) S[i] = i & 0xFF;

    let j = 0;
    for (let i = 0; i < keyLength; i++) {
      j = (j + S[i] + keyStream[i % keyLength]) % keyLength;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }

    let hashBase = 1;
    for (let i = 0; i < keyLength; i++) {
      const val = keyStream[i];
      if (val === 0) continue;
      const product = (hashBase * val) >>> 0;
      if (product === 0 || product <= hashBase) break;
      hashBase = product;
    }

    return { sbox: S, hashBase };
  }

  // ============================================================
  // 6. mapLE (短密钥流)
  // ============================================================
  function mapLe(keyStream, keyLength, offset) {
    const off = offset <= 0x7FFF ? offset : offset % 32767;
    const temp = off * off + 0x1162E;
    const idx = temp % keyLength;
    const byteVal = keyStream[idx];
    let shift = idx & 7;
    shift = shift > 3 ? shift - 4 : shift + 4;
    return ((byteVal << shift) | (byteVal >>> shift)) & 0xFF;
  }

  // ============================================================
  // 7-9. RC4 分段解密
  // ============================================================
  function encFirstSegment(keyStream, keyLength, hashBase, fileOffset, data, start, size) {
    for (let i = 0; i < size; i++) {
      const pos = fileOffset + i;
      const byteVal = keyStream[pos % keyLength];
      const prod = (pos + 1) * byteVal;
      if (prod === 0) {
        data[start + i] ^= keyStream[0];
      } else {
        const idx = Math.floor(hashBase / prod * 100) % keyLength;
        data[start + i] ^= keyStream[idx];
      }
    }
  }

  function encASegment(sbox, keyLength, keyStream, hashBase, blockIndex, fileOffset, data, start, size) {
    const S = new Uint8Array(sbox);
    const localIdx = blockIndex & 0x1FF;
    if (localIdx >= keyLength) return;
    const prod = (blockIndex + 1) * keyStream[localIdx];
    let numDrops = 0;
    if (prod !== 0) numDrops = Math.floor(hashBase / prod * 100) & 0x1FF;
    const warmup = numDrops + (fileOffset % 5120);

    let i = 0, j = 0;
    for (let w = 0; w < warmup; w++) {
      i = (i + 1) % keyLength;
      j = (j + S[i]) % keyLength;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    for (let n = 0; n < size; n++) {
      i = (i + 1) % keyLength;
      j = (j + S[i]) % keyLength;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      data[start + n] ^= S[(S[i] + S[j]) % keyLength];
    }
  }

  function processByRc4(sbox, keyLength, keyStream, hashBase, offset, data, size) {
    let remaining = size, bufOffset = 0, off = offset;

    if (off < 128) {
      const chunk = Math.min(128 - off, remaining);
      if (chunk > 0) {
        encFirstSegment(keyStream, keyLength, hashBase, off, data, bufOffset, chunk);
        bufOffset += chunk; off += chunk; remaining -= chunk;
      }
    }

    while (remaining > 0) {
      const remInSeg = off % 5120;
      const chunk = remInSeg !== 0 ? Math.min(5120 - remInSeg, remaining) : Math.min(5120, remaining);
      if (chunk <= 0) break;
      encASegment(sbox, keyLength, keyStream, hashBase, Math.floor(off / 5120), off, data, bufOffset, chunk);
      bufOffset += chunk; off += chunk; remaining -= chunk;
    }
  }

  // ============================================================
  // 10. 解密入口
  // ============================================================
  function decryptChunk(keyStream, keyLength, sbox, hashBase, offset, data) {
    if (keyLength > 0x12C) {
      processByRc4(sbox, keyLength, keyStream, hashBase, offset, data, data.length);
    } else {
      for (let i = 0; i < data.length; i++) {
        data[i] ^= mapLe(keyStream, keyLength, offset + i);
      }
    }
  }

  class QMCMobileDecryptor {
    constructor(ekey) {
      const { keyStream, keyLength } = deriveKey(ekey);
      const { sbox, hashBase } = rc4Ksa(keyStream, keyLength);
      this.ekey = ekey;
      this.keyStream = keyStream;
      this.keyLength = keyLength;
      this.sbox = sbox;
      this.hashBase = hashBase;
    }
    decrypt(data, offset = 0) {
      decryptChunk(this.keyStream, this.keyLength, this.sbox, this.hashBase, offset, data);
      return data;
    }
    decryptBytes(src, opts = {}) {
      // src: Uint8Array (整个文件)
      // opts: { chunkSize = 512*1024, stripFooter = true }
      const chunkSize = opts.chunkSize || 524288;
      const stripFooter = opts.stripFooter !== false;
      let footerSize = 0;
      if (stripFooter && src.length >= 8) {
        const tail4 = src.subarray(src.length - 4);
        if (tail4[0] === 0x53 && tail4[1] === 0x54 && tail4[2] === 0x61 && tail4[3] === 0x67) {
          // 'STag'
          const tail8 = src.subarray(src.length - 8, src.length - 4);
          const metaLen = (tail8[0] << 24 | tail8[1] << 16 | tail8[2] << 8 | tail8[3]) >>> 0;
          if (metaLen > 0 && metaLen <= 256) footerSize = metaLen + 8;
        }
      }
      const decryptSize = src.length - footerSize;
      const out = new Uint8Array(src.length);  // 含 footer
      let off = 0;
      while (off < decryptSize) {
        const take = Math.min(chunkSize, decryptSize - off);
        const buf = new Uint8Array(src.buffer, src.byteOffset + off, take);
        const bufOut = new Uint8Array(take);
        bufOut.set(buf);
        this.decrypt(bufOut, off);
        out.set(bufOut, off);
        off += take;
      }
      // 复制 footer (不解密)
      if (footerSize > 0) out.set(src.subarray(decryptSize), decryptSize);
      return out;
    }
  }

  // ============================================================
  // 11. 扩展名推断
  // ============================================================
  const QMC_EXT_MAP = {
    '.mflac': '.flac', '.mflac0': '.flac', '.mflac1': '.flac', '.mflac2': '.flac',
    '.mflac3': '.flac', '.mflac4': '.flac', '.mflac5': '.flac', '.mdolby': '.flac',
    '.mgg': '.ogg', '.mgg0': '.ogg', '.mgg1': '.ogg', '.mgg2': '.ogg',
    '.qmc': '.ogg', '.qmc0': '.flac', '.qmc3': '.mp3', '.qmc6': '.ogg'
  };
  function inferOutputExt(src) {
    const lower = src.toLowerCase();
    // 先试双后缀: .mgg2.flac / .mflac0.flac 等
    const doubleKeys = Object.keys(QMC_EXT_MAP)
      .sort((a, b) => b.length - a.length);
    for (const k of doubleKeys) {
      // 在文件名中任何位置出现 .mgg2. 都算
      if (lower.includes(k + '.')) return QMC_EXT_MAP[k];
    }
    const keys = Object.keys(QMC_EXT_MAP).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (lower.endsWith(k)) return QMC_EXT_MAP[k];
    }
    return '.flac';
  }

  // ============================================================
  // 自检
  // ============================================================
  function _selftest() {
    const checks = [];
    function chk(cond, msg) { checks.push((cond ? '  PASS ' : '  FAIL ') + msg); }

    // 1. simpleMakeKey 确定性
    const sk = simpleMakeKey(106, 8);
    chk(sk.length === 8, 'simpleMakeKey(106,8) 8 bytes');
    const sk2 = simpleMakeKey(106, 8);
    chk(sk.every((b, i) => b === sk2[i]), 'simpleMakeKey 确定性');

    // 2. TEA 解密
    const k = [0x30313233, 0x34353637, 0x38396162, 0x63646566];
    const r = teaDecryptBlock(0x12345678, 0x9abcdef0, k);
    chk(r[0] === 0x21c2674d && r[1] === 0xd5aff1cd, `teaDecryptBlock → 0x${r[0].toString(16)},0x${r[1].toString(16)}`);

    // 3. deriveKey
    const fake = btoa(String.fromCharCode(...Array.from({length: 72}, (_, i) => i & 0xFF)));
    const { keyStream, keyLength } = deriveKey(fake);
    chk(keyLength > 8, `deriveKey 长度 ${keyLength}`);

    // 4. 异或流自反
    const dec = new QMCMobileDecryptor(fake);
    const data = Uint8Array.from('hello qqmusic '.repeat(64).split('').map(c => c.charCodeAt(0)));
    const orig = new Uint8Array(data);
    dec.decrypt(data, 0);
    dec.decrypt(data, 0);
    chk(data.every((b, i) => b === orig[i]), '异或流自反: 解两次还原');

    // 5. 长密钥流走 RC4
    const fake2 = btoa(String.fromCharCode(...Array.from({length: 400}, (_, i) => i & 0xFF)));
    const dec2 = new QMCMobileDecryptor(fake2);
    chk(dec2.keyLength > 0x12C, `长密钥流 keyLength=${dec2.keyLength}`);
    const buf = new Uint8Array(6000).fill(0x41);
    dec2.decrypt(buf, 0);
    chk(buf.some(b => b !== 0x41), 'RC4 分段解密确实改写了数据');

    // 6. 扩展名
    chk(inferOutputExt('song.mflac0') === '.flac', 'song.mflac0 → .flac');
    chk(inferOutputExt('x.mgg1') === '.ogg', 'x.mgg1 → .ogg');
    chk(inferOutputExt('王力宏 - 大城小爱 [mqms2].mgg2.flac') === '.ogg', '王力宏 - 大城小爱 [mqms2].mgg2.flac → .ogg');

    const allPass = checks.every(s => s.includes('PASS'));
    console.log(checks.join('\n'));
    console.log('\n自检:', allPass ? '全部通过 ✅' : '有失败 ❌');
    return allPass;
  }

  // 暴露
  const exports = {
    simpleMakeKey, teaDecryptBlock, oiSymmetryDecrypt2, deriveKey,
    rc4Ksa, mapLe, processByRc4, decryptChunk,
    QMCMobileDecryptor, inferOutputExt, _selftest
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
  if (root) root.QmcMobile = exports;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
