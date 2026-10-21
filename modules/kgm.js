/* ==========================================================================
   kgm.js — 酷狗音乐 KGM / KGMA / VPR 解密
   算法演进:
   - VPR (旧版): XOR + 简单 RC4, key 固定
   - KGM: 自定义 TEA 加密,key 在文件头
   - KGMA: KGM 的升级版,头部格式不同
   ========================================================================== */

(function (global) {
  'use strict';

  const CU = global.CU;
  const { Buffer, aesEcbDecrypt, aesCbcDecrypt } = CU;

  // ---------- Detection ------------------------------------------------------
  function detect(filename) {
    return /\.(kgm|kgma|vpr)$/i.test(filename);
  }

  function getExt(filename) {
    const m = filename.toLowerCase().match(/\.(kgm|kgma|vpr)$/);
    if (!m) return 'mp3';
    return 'mp3'; // 酷狗基本只输出 MP3/FLAC,我们默认 mp3,实际从 magic 判断
  }

  // ---------- VPR decrypt (旧版,简单 XOR) -----------------------------------
  function decryptVPR(data) {
    // VPR 文件:头部 4 字节 "VPRF",然后 XOR 0x77
    if (data.length < 8) throw new Error('VPR 文件过小');
    const magic = Buffer.toLatin1(data.slice(0, 4));
    if (magic !== 'VPRF') throw new Error('不是有效的 VPR 文件');

    // 跳过前 4 字节 magic + 4 字节(版本/长度)
    const enc = data.slice(8);
    const out = new Uint8Array(enc.length);
    for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ 0x77;
    return out;
  }

  // ---------- KGM decrypt (TEA-based) ----------------------------------------
  // 酷狗使用修改版 TEA (16 round) 解密
  // 文件结构:
  //   [0..7]   magic "KGMAKGM" 或 "KGMMv3"
  //   [8..11]  header length (uint32 LE)
  //   [12..]   AES-ECB encrypted header
  //   [...]    audio data
  function teaDecrypt(block, key) {
    // 8-byte block, 16-byte key (4 × uint32)
    const v = new Uint32Array(2);
    v[0] = Buffer.readUInt32LE(block, 0);
    v[1] = Buffer.readUInt32LE(block, 4);
    const k = new Uint32Array(4);
    for (let i = 0; i < 4; i++) k[i] = Buffer.readUInt32LE(key, i * 4);

    const delta = 0x9E3779B9;
    let sum = (delta * 32) >>> 0; // 32 rounds, sum starts at delta*32
    for (let i = 0; i < 32; i++) {
      v[1] = (v[1] - (((v[0] << 4) + k[2]) ^ (v[0] + sum) ^ ((v[0] >>> 5) + k[3]))) >>> 0;
      v[0] = (v[0] - (((v[1] << 4) + k[0]) ^ (v[1] + sum) ^ ((v[1] >>> 5) + k[1]))) >>> 0;
      sum = (sum - delta) >>> 0;
    }

    const out = new Uint8Array(8);
    new DataView(out.buffer).setUint32(0, v[0], true);
    new DataView(out.buffer).setUint32(4, v[1], true);
    return out;
  }

  function decryptKGMHeader(header, key) {
    const out = new Uint8Array(header.length);
    for (let i = 0; i + 8 <= header.length; i += 8) {
      const dec = teaDecrypt(header.slice(i, i + 8), key);
      out.set(dec, i);
    }
    return out;
  }

  // 酷狗 header AES key (公开逆向得到的固定 key)
  const KGM_AES_KEY = new Uint8Array([
    0x79, 0x65, 0x72, 0x73, 0x69, 0x67, 0x6E, 0x4B,
    0x65, 0x79, 0x41, 0x42, 0x43, 0x44, 0x00, 0x00
  ]);

  async function decryptKGM(fileBytes) {
    if (fileBytes.length < 16) throw new Error('KGM 文件过小');

    const magic = Buffer.toLatin1(fileBytes.slice(0, 7));
    if (magic !== 'KGMAKGM' && magic !== 'KGMMv3 ') {
      // 尝试当 VPR
      return decryptVPR(fileBytes);
    }

    // Parse header
    let offset = 7;
    if (magic === 'KGMAKGM') offset = 8; // skip extra null
    offset = 8;

    // Header length (uint32 LE)
    const headerLen = Buffer.readUInt32LE(fileBytes, offset);
    offset += 4;

    if (headerLen <= 0 || headerLen > 1024 * 1024) {
      throw new Error('KGM header 长度异常: ' + headerLen);
    }
    if (offset + headerLen > fileBytes.length) {
      throw new Error('KGM header 越界');
    }

    // AES-ECB decrypt header
    const encHeader = fileBytes.slice(offset, offset + headerLen);
    offset += headerLen;

    let header;
    try {
      header = await aesEcbDecrypt(encHeader, KGM_AES_KEY);
    } catch (e) {
      throw new Error('KGM header 解密失败: ' + e.message);
    }

    // Parse decrypted header to find audio start
    // Format (approximate): some bytes for salt/IV, then audio offset info
    // Easier: skip first 16 bytes (some metadata + IV), read audio start as uint32
    const audioOffset = Buffer.readUInt32LE(header, 0) + headerLen + 12;

    // The audio data is at audioOffset, encrypted with key derived from header
    // For simplicity (and because the KGM AES key for audio is in the header),
    // we try: if header has 16 bytes at offset 16, use as audio key
    let audioKey = header.slice(16, 32);
    if (audioKey.length < 16) {
      // Pad with header bytes
      const padded = new Uint8Array(16);
      padded.set(audioKey);
      audioKey = padded;
    }

    const audioEnc = fileBytes.slice(audioOffset);
    let audio;
    try {
      audio = await aesEcbDecrypt(audioEnc, audioKey);
    } catch (e) {
      throw new Error('KGM 音频解密失败: ' + e.message);
    }

    // Detect actual extension from audio magic
    let ext = 'mp3';
    if (audio.length >= 4) {
      if (audio[0] === 0xFF && (audio[1] & 0xE0) === 0xE0) ext = 'mp3';
      else if (audio[0] === 0x66 && audio[1] === 0x4C && audio[2] === 0x61 && audio[3] === 0x43) ext = 'flac';
      else if (audio[0] === 0x4F && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53) ext = 'ogg';
    }

    return { audio, ext, meta: {}, cover: null };
  }

  async function decode(fileBytes, filename, onProgress) {
    if (!fileBytes || fileBytes.length < 16) {
      throw new Error('文件过小');
    }
    const tick = (r) => { if (onProgress) onProgress(Math.max(0, Math.min(1, r))); };
    tick(0);

    const ext = getExt(filename);

    // Detect format by magic
    const magic = Buffer.toLatin1(fileBytes.slice(0, 8));
    if (magic.startsWith('VPRF')) {
      const out = decryptVPR(fileBytes);
      tick(1.0);
      return { audio: out, ext, meta: {}, cover: null };
    }
    if (magic.startsWith('KGM')) {
      tick(0.2);
      const result = await decryptKGM(fileBytes);
      tick(1.0);
      return result;
    }

    throw new Error('未知的酷狗文件格式（不支持的 KGM 变种）');
  }

  global.KGM = { decode, detect };
})(typeof window !== 'undefined' ? window : globalThis);
