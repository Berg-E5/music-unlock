/* ==========================================================================
   ncm.js — 网易云音乐 NCM 格式解密
   基于 ncmdump-go (Golang) 开源实现移植

   支持两种 NCM 格式：
   - v1 (legacy, 网易云 2.x)：gap=8 字节, RC4 加密 key 块
   - v2 (current, 3.x)：     gap=2 字节, AES-ECB + 3.x meta 格式

   文件结构 (v2):
     [0..8]    "CTENFDAM"        magic
     [8..10]   0x01 0x00         version gap
     [10..14]  uint32 LE keyLen  AES-128-ECB encrypted key blob length
     [14..14+keyLen]  encrypted key (XOR 0x64, then AES-ECB with sCoreKey)
     [..]      uint32 LE metaLen
     [..+4..+4+metaLen]  encrypted meta (XOR 0x63, base64, AES-ECB with sModifyKey)
     [..]      5 bytes gap
     [..+4]    uint32 LE coverFrameLen
     [..+8]    uint32 LE coverDataLen
     [..+8..+8+coverDataLen]  embedded cover (may be empty in 3.x)
     [..]      audio stream (RC4-style XOR with keybox, per-chunk 0x8000)
   ========================================================================== */

(function (global) {
  'use strict';

  const CU = global.CU;
  const { Buffer, aesEcbDecrypt } = CU;

  // AES keys from ncmdump-go
  const S_CORE_KEY   = [0x68,0x7A,0x48,0x52,0x41,0x6D,0x73,0x6F,0x35,0x6B,0x49,0x6E,0x62,0x61,0x78,0x57];
  const S_MODIFY_KEY = [0x23,0x31,0x34,0x6C,0x6A,0x6B,0x5F,0x21,0x5C,0x5D,0x26,0x30,0x55,0x3C,0x27,0x28];

  // ---------- Helpers --------------------------------------------------------

  function xorInPlace(arr, mask) {
    for (let i = 0; i < arr.length; i++) arr[i] ^= mask;
  }

  // PKCS#7 unpad (returns a new Uint8Array without trailing padding)
  function pkcs7Unpad(data) {
    if (data.length === 0) return data;
    const pad = data[data.length - 1];
    if (pad < 1 || pad > 16) return data;
    // Verify padding bytes
    for (let i = data.length - pad; i < data.length; i++) {
      if (data[i] !== pad) return data;
    }
    return data.slice(0, data.length - pad);
  }

  // buildKeyBox from unlock-music: standard RC4 KSA, then transform to keystream
  // out[i] = S[(S[(i+1)&0xff] + S[(S[(i+1)&0xff] + (i+1))&0xff]) & 0xff]
  function buildKeyBox(key) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    return S;
  }

  // NCM 3.x audio decrypt: continuous XOR with 256-byte keystream
  // out[i] = in[i] ^ keystream[i & 0xff]
  // (unlock-music style — NOT ncmdump-go's per-chunk 0x8000 algorithm)
  function streamDecrypt(S, data) {
    // Pre-compute 256-byte keystream
    const ks = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const j = (i + 1) & 0xff;
      const a = S[j];
      const b = S[(a + j) & 0xff];
      ks[i] = S[(a + b) & 0xff];
    }
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = data[i] ^ ks[i & 0xff];
    }
    return out;
  }

  // ---------- File format decode --------------------------------------------
  async function decode(fileBytes, _ext, onProgress) {
    if (!fileBytes || fileBytes.length < 16) {
      throw new Error('文件过小，不是有效的 NCM');
    }
    const tick = (r) => { if (onProgress) onProgress(Math.max(0, Math.min(1, r))); };
    tick(0);

    // 1. Magic check
    const magic = Buffer.toLatin1(fileBytes.slice(0, 8));
    if (magic !== 'CTENFDAM') {
      throw new Error('不是有效的 NCM 文件（magic 不匹配）');
    }
    tick(0.05);

    // 2. Find keyLen
    //    v1 (legacy, 2.x): 0x01 + 7×0x00 gap → keyLen at offset 16
    //    v2 (3.x):         0x01 + 1×0x00 gap → keyLen at offset 10
    const _tryOffset = (off) => {
      if (off + 4 > fileBytes.length) return null;
      const v = Buffer.readUInt32LE(fileBytes, off);
      if (v <= 0 || v > 0x10000) return null;
      if (off + 4 + v > fileBytes.length) return null;
      return v;
    };
    let offset;
    const k_v2 = _tryOffset(10);
    const k_v1 = _tryOffset(16);
    if (k_v2 !== null && (k_v1 === null || k_v2 <= 512)) {
      offset = 10;  // v2 (3.x)
    } else if (k_v1 !== null) {
      offset = 16;  // v1 (legacy)
    } else {
      throw new Error('NCM 文件结构异常：key 块越界');
    }

    // ---- Block 1: AES key ----
    const keyLen = Buffer.readUInt32LE(fileBytes, offset);
    offset += 4;
    const encKey = fileBytes.slice(offset, offset + keyLen);
    offset += keyLen;

    // XOR 0x64 → AES-ECB-decrypt with sCoreKey → PKCS7 unpad → drop "neteasecloudmusic" prefix (17B) → keybox
    const keyXored = new Uint8Array(encKey);
    xorInPlace(keyXored, 0x64);
    const mKeyDataPadded = await aesEcbDecrypt(keyXored, new Uint8Array(S_CORE_KEY));
    const mKeyData = pkcs7Unpad(mKeyDataPadded);

    // 验证: 开头应该是 "neteasecloudmusic"
    const head = Buffer.toLatin1(mKeyData.slice(0, 17));
    if (head !== 'neteasecloudmusic') {
      throw new Error('NCM key 块解密异常：magic prefix 不匹配（' + head + '）');
    }
    const keyboxKey = mKeyData.slice(17);
    const keybox = buildKeyBox(keyboxKey);
    tick(0.2);

    // ---- Block 2: metadata ----
    let meta = {};
    let coverData = null;
    const metaLen = Buffer.readUInt32LE(fileBytes, offset);
    offset += 4;
    if (metaLen > 0) {
      if (offset + metaLen > fileBytes.length) {
        throw new Error('NCM 文件结构异常：meta 块越界');
      }
      const encMeta = fileBytes.slice(offset, offset + metaLen);
      offset += metaLen;

      const metaXored = new Uint8Array(encMeta);
      xorInPlace(metaXored, 0x63);
      const metaLatin1 = Buffer.toLatin1(metaXored);

      let decMeta = null;
      if (metaLatin1.startsWith('163 key(Don\'t modify):')) {
        // v2 (3.x): base64 + AES-ECB with sModifyKey, then skip "music:" prefix
        const b64 = metaLatin1.substring(22).trim();
        let b64Decoded = null;
        try { b64Decoded = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); } catch (e) {
          throw new Error('NCM meta 块 base64 解码失败');
        }
        const aesDec = await aesEcbDecrypt(b64Decoded, new Uint8Array(S_MODIFY_KEY));
        decMeta = pkcs7Unpad(aesDec);
        // Skip "music:" (6 bytes) → JSON (decMeta is UTF-8 encoded)
        if (decMeta.length >= 6 && decMeta[0] === 0x6d && decMeta[1] === 0x75 /* 'mu' */) {
          const jsonBytes = decMeta.slice(6);
          // trim trailing nulls
          let end = jsonBytes.length;
          while (end > 0 && jsonBytes[end - 1] === 0) end--;
          const jsonStr = new TextDecoder('utf-8').decode(jsonBytes.slice(0, end));
          try { meta = JSON.parse(jsonStr); } catch (e) {
            throw new Error('NCM meta JSON 解析失败');
          }
        }
      } else if (metaLatin1.startsWith('music:')) {
        // v1 (legacy): "music:" + base64 JSON + 0x00 + coverLen(4) + cover
        const nul = metaXored.indexOf(0x00, 6);
        const end = nul >= 0 ? nul : metaXored.length;
        const jsonB64 = metaLatin1.substring(6, end).trim();
        try {
          meta = JSON.parse(atob(jsonB64));
        } catch {
          try { meta = JSON.parse(jsonB64); } catch {}
        }
        let cursor = end + 1;
        if (cursor + 4 <= metaXored.length) {
          const coverSize = Buffer.readUInt32LE(metaXored, cursor);
          cursor += 4;
          if (coverSize > 0 && cursor + coverSize <= metaXored.length) {
            coverData = metaXored.slice(cursor, cursor + coverSize);
          }
        }
      } else {
        // v1 alternate: just a JSON blob (older clients)
        const nul = metaXored.indexOf(0x00);
        if (nul > 0) {
          try { meta = JSON.parse(metaLatin1.substring(0, nul)); } catch {}
          try { meta = JSON.parse(metaLatin1.substring(nul + 1)); } catch {}
        }
      }
    }
    tick(0.3);

    // ---- Cover (3.x): skip 5 bytes gap, then coverFrameLen(4) + coverDataLen(4) + cover
    if (offset + 5 + 8 <= fileBytes.length) {
      const coverFrameLen = Buffer.readUInt32LE(fileBytes, offset + 5);
      const coverDataLen  = Buffer.readUInt32LE(fileBytes, offset + 5 + 4);
      if (coverDataLen > 0 && coverDataLen < 0x1000000 &&
          offset + 5 + 8 + coverDataLen <= fileBytes.length) {
        coverData = fileBytes.slice(offset + 5 + 8, offset + 5 + 8 + coverDataLen);
        offset += 5 + 8 + coverFrameLen;
      } else {
        offset += 5 + 8 + coverFrameLen;
      }
    }

    if (offset >= fileBytes.length) {
      throw new Error('NCM 文件没有音频数据');
    }
    const audioEnc = fileBytes.slice(offset);
    tick(0.3);

    // ---- Block 3: audio — continuous XOR with 256-byte keystream (NCM 3.x)
    const out = new Uint8Array(audioEnc.length);
    // Pre-compute keystream
    const ks = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const j = (i + 1) & 0xff;
      const a = keybox[j];
      const b = keybox[(a + j) & 0xff];
      ks[i] = keybox[(a + b) & 0xff];
    }
    const CHUNK = 0x40000; // 256 KiB blocks for progress reporting
    const total = audioEnc.length;
    for (let off = 0; off < total; off += CHUNK) {
      const end = Math.min(off + CHUNK, total);
      const piece = audioEnc.slice(off, end);
      for (let i = 0; i < piece.length; i++) {
        out[off + i] = piece[i] ^ ks[(off + i) & 0xff];
      }
      // 音频占 70% 进度 (0.3 → 1.0)
      tick(0.3 + 0.7 * (end / total));
      // 让 UI 有机会刷新
      if (off % (CHUNK * 4) === 0) await new Promise(r => setTimeout(r, 0));
    }

    // NCM 在音频尾部追加填充字节 (e.g. "neteasecloudmusic" + 零) — 大多数播放器会忽略
    // 找到 ID3/fLaC 后的尾随垃圾位置, 截断到第一个 frame 同步字节之后
    // 简单起见保留完整输出 (ID3 tag 一般足够长, 播放器跳过)

    // Extension from meta.format
    let ext = 'mp3';
    if (meta && meta.format) {
      const f = String(meta.format).toLowerCase();
      if (f.includes('flac')) ext = 'flac';
      else if (f.includes('ogg')) ext = 'ogg';
      else if (f.includes('m4a') || f.includes('aac')) ext = 'm4a';
    }

    return { audio: out, ext, meta, cover: coverData };
  }

  function detect(filename) {
    return /\.ncm$/i.test(filename);
  }

  global.NCM = { decode, detect };
})(typeof window !== 'undefined' ? window : globalThis);
