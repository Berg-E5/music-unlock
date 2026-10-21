/* ==========================================================================
   qmc.js — QQ 音乐加密格式解密
   基于 unlock-music (dfvips fork) 移植

   支持:
   - v1 (静态 XOR, 老格式): bkcmp3 / tkm / bkcflac / bkcogg 等
   - v2 Map cipher (现代): qmcflac / qmcogg / mgg / mggl (key 在文件头)
   - v2 RC4 (部分): bkcmp3 v2 升级版

   不支持 (需 WASM):
   - qmc0 / qmc2 / qmc3 / qmc4 / qmc6 / qmc8 新格式 (TeaCipher + WASM)
   ========================================================================== */

(function (global) {
  'use strict';

  // ---------- v1: Static cipher --------------------------------------------
  // 256 字节固定 XOR 表,从 unlock-music 移植
  const STATIC_BOX = new Uint8Array([
    0x77, 0x48, 0x32, 0x73, 0xDE, 0xF2, 0xC0, 0xC8,
    0x95, 0xEC, 0x30, 0xB2, 0x51, 0xC3, 0xE1, 0xA0,
    0x9E, 0xE6, 0x9D, 0xCF, 0xFA, 0x7F, 0x14, 0xD1,
    0xCE, 0xB8, 0xDC, 0xC3, 0x4A, 0x67, 0x93, 0xD6,
    0x28, 0xC2, 0x91, 0x70, 0xCA, 0x8D, 0xA2, 0xA4,
    0xF0, 0x08, 0x61, 0x90, 0x7E, 0x6F, 0xA2, 0xE0,
    0xEB, 0xAE, 0x3E, 0xB6, 0x67, 0xC7, 0x92, 0xF4,
    0x91, 0xB5, 0xF6, 0x6C, 0x5E, 0x84, 0x40, 0xF7,
    0xF3, 0x1B, 0x02, 0x7F, 0xD5, 0xAB, 0x41, 0x89,
    0x28, 0xF4, 0x25, 0xCC, 0x52, 0x11, 0xAD, 0x43,
    0x68, 0xA6, 0x41, 0x8B, 0x84, 0xB5, 0xFF, 0x2C,
    0x92, 0x4A, 0x26, 0xD8, 0x47, 0x6A, 0x7C, 0x95,
    0x61, 0xCC, 0xE6, 0xCB, 0xBB, 0x3F, 0x47, 0x58,
    0x89, 0x75, 0xC3, 0x75, 0xA1, 0xD9, 0xAF, 0xCC,
    0x08, 0x73, 0x17, 0xDC, 0xAA, 0x9A, 0xA2, 0x16,
    0x41, 0xD8, 0xA2, 0x06, 0xC6, 0x8B, 0xFC, 0x66,
    0x34, 0x9F, 0xCF, 0x18, 0x23, 0xA0, 0x0A, 0x74,
    0xE7, 0x2B, 0x27, 0x70, 0x92, 0xE9, 0xAF, 0x37,
    0xE6, 0x8C, 0xA7, 0xBC, 0x62, 0x65, 0x9C, 0xC2,
    0x08, 0xC9, 0x88, 0xB3, 0xF3, 0x43, 0xAC, 0x74,
    0x2C, 0x0F, 0xD4, 0xAF, 0xA1, 0xC3, 0x01, 0x64,
    0x95, 0x4E, 0x48, 0x9F, 0xF4, 0x35, 0x78, 0x95,
    0x7A, 0x39, 0xD6, 0x6A, 0xA0, 0x6D, 0x40, 0xE8,
    0x4F, 0xA8, 0xEF, 0x11, 0x1D, 0xF3, 0x1B, 0x3F,
    0x3F, 0x07, 0xDD, 0x6F, 0x5B, 0x19, 0x30, 0x19,
    0xFB, 0xEF, 0x0E, 0x37, 0xF0, 0x0E, 0xCD, 0x16,
    0x49, 0xFE, 0x53, 0x47, 0x13, 0x1A, 0xBD, 0xA4,
    0xF1, 0x40, 0x19, 0x60, 0x0E, 0xED, 0x68, 0x09,
    0x06, 0x5F, 0x4D, 0xCF, 0x3D, 0x1A, 0xFE, 0x20,
    0x77, 0xE4, 0xD9, 0xDA, 0xF9, 0xA4, 0x2B, 0x76,
    0x1C, 0x71, 0xDB, 0x00, 0xBC, 0xFD, 0x0C, 0x6C,
    0xA5, 0x47, 0xF7, 0xF6, 0x00, 0x79, 0x4A, 0x11,
  ]);

  class QmcStaticCipher {
    static getMask(offset) {
      if (offset > 0x7fff) offset = offset % 0x7fff;
      return STATIC_BOX[(offset * offset + 27) & 0xff];
    }
    static decrypt(buf, offset) {
      for (let i = 0; i < buf.length; i++) {
        buf[i] ^= QmcStaticCipher.getMask(offset + i);
      }
    }
  }

  // ---------- v2: Map cipher (key 嵌入文件) ---------------------------------
  class QmcMapCipher {
    constructor(key) {
      if (!key || key.length === 0) throw new Error('QmcMapCipher: key 不能为空');
      this.key = key;
      this.n = key.length;
    }
    static rotate(value, bits) {
      const r = (bits + 4) % 8;
      return ((value << r) | (value >> r)) & 0xff;
    }
    getMask(offset) {
      if (offset > 0x7fff) offset = offset % 0x7fff;
      const idx = (offset * offset + 71214) % this.n;
      return QmcMapCipher.rotate(this.key[idx], idx & 0x7);
    }
    decrypt(buf, offset) {
      for (let i = 0; i < buf.length; i++) {
        buf[i] ^= this.getMask(offset + i);
      }
    }
  }

  // ---------- v2: RC4 cipher (segment-based) --------------------------------
  class QmcRC4Cipher {
    static FIRST_SEGMENT_SIZE = 0x80;
    static SEGMENT_SIZE = 5120;

    constructor(key) {
      if (!key || key.length === 0) throw new Error('QmcRC4Cipher: key 不能为空');
      this.key = key;
      this.N = key.length;
      // KSA
      this.S = new Uint8Array(this.N);
      for (let i = 0; i < this.N; i++) this.S[i] = i & 0xff;
      let j = 0;
      for (let i = 0; i < this.N; i++) {
        j = (this.S[i] + j + this.key[i % this.N]) % this.N;
        [this.S[i], this.S[j]] = [this.S[j], this.S[i]];
      }
      // hash base
      this.hash = 1;
      for (let i = 0; i < this.N; i++) {
        const v = this.key[i];
        if (!v) continue;
        const next = (this.hash * v) >>> 0;
        if (next === 0 || next <= this.hash) break;
        this.hash = next;
      }
    }

    getSegmentKey(id) {
      const seed = this.key[id % this.N];
      const idx = Math.floor((this.hash / ((id + 1) * seed)) * 100.0);
      return idx % this.N;
    }

    encFirstSegment(buf, offset) {
      for (let i = 0; i < buf.length; i++) {
        buf[i] ^= this.key[this.getSegmentKey(offset + i)];
      }
    }

    encASegment(buf, offset) {
      const S = this.S.slice(0);
      const skipLen =
        (offset % QmcRC4Cipher.SEGMENT_SIZE) + this.getSegmentKey(Math.floor(offset / QmcRC4Cipher.SEGMENT_SIZE));
      let j = 0, k = 0;
      for (let i = -skipLen; i < buf.length; i++) {
        j = (j + 1) % this.N;
        k = (S[j] + k) % this.N;
        [S[k], S[j]] = [S[j], S[k]];
        if (i >= 0) {
          buf[i] ^= S[(S[j] + S[k]) % this.N];
        }
      }
    }

    decrypt(buf, offset) {
      let toProcess = buf.length;
      let processed = 0;

      // first segment
      if (offset < QmcRC4Cipher.FIRST_SEGMENT_SIZE) {
        const len = Math.min(buf.length, QmcRC4Cipher.FIRST_SEGMENT_SIZE - offset);
        this.encFirstSegment(buf.subarray(0, len), offset);
        toProcess -= len;
        processed += len;
        offset += len;
      }

      // align
      if (offset % QmcRC4Cipher.SEGMENT_SIZE !== 0 && toProcess > 0) {
        const len = Math.min(QmcRC4Cipher.SEGMENT_SIZE - (offset % QmcRC4Cipher.SEGMENT_SIZE), toProcess);
        this.encASegment(buf.subarray(processed, processed + len), offset);
        toProcess -= len;
        processed += len;
        offset += len;
      }

      // batch
      while (toProcess > QmcRC4Cipher.SEGMENT_SIZE) {
        this.encASegment(buf.subarray(processed, processed + QmcRC4Cipher.SEGMENT_SIZE), offset);
        toProcess -= QmcRC4Cipher.SEGMENT_SIZE;
        processed += QmcRC4Cipher.SEGMENT_SIZE;
        offset += QmcRC4Cipher.SEGMENT_SIZE;
      }

      // tail
      if (toProcess > 0) {
        this.encASegment(buf.subarray(processed), offset);
      }
    }
  }

  // ---------- Format detection ----------------------------------------------
  function detect(filename) {
    return /\.(qmc0|qmc1|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|mgg|mggl|bkcmp3|bkcm4a|bkcflac|bkcogg|mflac|mflac0|mmp4|666c6163|6d7033|6f6767|6d3461|776176)$/i.test(filename);
  }

  function getExt(filename) {
    const m = filename.toLowerCase().match(/\.(qmc0|qmc1|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|mgg|mggl|bkcmp3|bkcm4a|bkcflac|bkcogg|mflac|mflac0|mmp4|666c6163|6d7033|6f6767|6d3461|776176)$/);
    if (!m) return 'mp3';
    const e = m[1];
    if (e === 'qmcflac' || e === 'bkcflac' || e === 'mflac' || e === 'mflac0' || e === '666c6163') return 'flac';
    if (e === 'qmcogg' || e === 'bkcogg' || e === 'mgg' || e === 'mggl' || e === '6f6767') return 'ogg';
    if (e === 'tkm' || e === 'bkcm4a' || e === '6d3461') return 'm4a';
    if (e === 'bkcape') return 'ape';
    if (e === 'bkcwav' || e === '776176') return 'wav';
    if (e === 'bkcwma') return 'wma';
    if (e === 'mmp4') return 'mmp4';
    return 'mp3';
  }

  // 判断是 v1 还是 v2
  function getVersion(filename) {
    const m = filename.toLowerCase().match(/\.(qmc0|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|mgg|mggl|mflac|mflac0|mmp4|666c6163|6d7033|6f6767|6d3461|776176)$/);
    if (m) return 2;  // v2
    return 1;  // v1
  }

  // ---------- v2 key 提取 (从文件头) ---------------------------------------
  // qmc v2 文件: 头 0x1700 字节存放 key, 后面是加密音频
  // 实际从 unlock-music 看: 头 ~0x4000 区域, base64 encoded after offset
  // 简化: 我们读取头找 'QQMusic EncV2,Key:' 或 'KEY=' 标记

  function extractV2Key(fileBytes) {
    // 搜索文件头 key 标记
    // 模式 1: 'QQMusic EncV2,Key:'
    // 模式 2: 文件前几个 KB 含 base64 编码的 key
    const headerEnd = Math.min(fileBytes.length, 0x4000);
    const header = fileBytes.subarray(0, headerEnd);

    // 找 'QQMusic EncV2,Key:' 标记
    const marker = new Uint8Array([0x51, 0x51, 0x4D, 0x75, 0x73, 0x69, 0x63, 0x20, 0x45, 0x6E, 0x63, 0x56, 0x32, 0x2C, 0x4B, 0x65, 0x79, 0x3A]);
    // 'QQMusic EncV2,Key:' 18 bytes
    let pos = -1;
    for (let i = 0; i < header.length - marker.length; i++) {
      let match = true;
      for (let j = 0; j < marker.length; j++) {
        if (header[i + j] !== marker[j]) { match = false; break; }
      }
      if (match) { pos = i + marker.length; break; }
    }

    if (pos < 0) {
      // 尝试在文件前面找 base64 风格 key (长度 32-128 字节的 base64 字符)
      // 简化: 取前 0x100 字节的尾部, 如果是 printable ASCII, 可能是 key
      return null;
    }

    // 提取 key (到下一个 null 字节或换行)
    let end = pos;
    while (end < header.length && header[end] !== 0 && header[end] !== 0x0A) end++;
    return header.subarray(pos, end);
  }

  // ---------- QmcDecryptKey: Tea-based key derivation -----------------------
  // 跟 unlock-music QmcWasm QmcDecryptKey 字节级一致
  const SIMPLE_KEY = computeSimpleKey(106, 8);
  const MIX_KEY_1 = new Uint8Array([0x33,0x38,0x36,0x5A,0x4A,0x59,0x21,0x40,0x23,0x2A,0x24,0x25,0x5E,0x26,0x29,0x28]);
  const MIX_KEY_2 = new Uint8Array([0x2A,0x2A,0x23,0x21,0x28,0x23,0x24,0x25,0x26,0x5E,0x61,0x31,0x63,0x5A,0x2C,0x54]);
  const V2_KEY_PREFIX = new Uint8Array([0x51,0x51,0x4D,0x75,0x73,0x69,0x63,0x20,0x45,0x6E,0x63,0x56,0x32,0x2C,0x4B,0x65,0x79,0x3A]);

  function computeSimpleKey(salt, length) {
    const key = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const tmp = Math.tan(salt + i * 0.1);
      key[i] = 0xFF & Math.floor(Math.abs(tmp) * 100);
    }
    return key;
  }

  function hasV2Prefix(buf) {
    if (buf.length < V2_KEY_PREFIX.length) return false;
    for (let i = 0; i < V2_KEY_PREFIX.length; i++) {
      if (buf[i] !== V2_KEY_PREFIX[i]) return false;
    }
    return true;
  }

  function bytesToAscii(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function decryptV2Key(key) {
    if (!hasV2Prefix(key)) return key;
    try {
      let out = CU.teaDecryptCBC(key.subarray(18), MIX_KEY_1);
      out = CU.teaDecryptCBC(out, MIX_KEY_2);
      const decoded = CU.base64Decode(bytesToAscii(out));
      if (decoded.length < 16) throw new Error('EncV2 decoded key too short');
      return decoded;
    } catch (e) {
      throw new Error('EncV2 解密失败: ' + e.message);
    }
  }

  function QmcDecryptKey(rawKey) {
    const rawAscii = bytesToAscii(rawKey);
    let rawDec = CU.base64Decode(rawAscii);
    if (rawDec.length < 16) throw new Error('QmcDecryptKey: key length too short after base64');
    rawDec = decryptV2Key(rawDec);
    const teaKey = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      teaKey[i << 1] = SIMPLE_KEY[i];
      teaKey[(i << 1) + 1] = rawDec[i];
    }
    const body = rawDec.subarray(8);
    const sub = CU.teaDecryptCBC(body, teaKey);
    const result = new Uint8Array(8 + sub.length);
    result.set(rawDec.subarray(0, 8), 0);
    result.set(sub, 8);
    return result;
  }

  // 公共解密函数: 从 raw key 派生 cipher 并解密音频
  function decryptWithDerivedKey(audioBytes, rawKey, ext, tick) {
    try {
      const derivedKey = QmcDecryptKey(rawKey);
      tick(0.2);
      const cipher = makeCipherFromKey(derivedKey);
      tick(0.3);
      const audioOut = new Uint8Array(audioBytes);
      cipher.decrypt(audioOut, 0);
      tick(0.95);
      if (isPlausibleAudio(audioOut, ext)) {
        tick(1.0);
        return { audio: audioOut, ext: sniffAudioFormat(audioOut) || ext, meta: {}, cover: null };
      }
      const head = Array.from(audioOut.slice(0, 16)).map(b => b.toString(16).padStart(2,'0')).join(' ');
      throw new Error('derived-key 解密后不像音频 (头 16 字节: ' + head + ')');
    } catch (e) {
      throw new Error('QMC derived-key 解密失败: ' + e.message);
    }
  }

  // 站点地址: 运行时从当前页面推导 — 换域名/子路径部署无需改代码
function _siteBase() {
  try {
    if (self.location && self.location.origin && self.location.origin !== 'null') {
      return self.location.origin;
    }
  } catch (_) {}
  return '';
}

// ---------- 主解密流程 ----------------------------------------------------
  async function decode(fileBytes, filename, tick = () => {}, opts = {}) {
    const ext = getExt(filename);
    const out = new Uint8Array(fileBytes);

    // 1) 先检测文件末尾标记 — 决定 cipher 类型 (这是最可靠的检测方式)
    const detected = detectCipherType(fileBytes);
    tick(0.05);

    if (detected.type === 'v2-stag') {
      // STag / mgg2 / mflac2 / mgg (Android 客户端 cuizzzzzzzz 算法)
      // 这类文件的密钥不在文件里, 浏览器无法获得 -> 明确指引走借壳工具。
      throw new Error(
        '这类文件 (STag / .mgg / .mflac / .mgg2 / .mflac2) 的解密密钥不在文件内, '
        + '浏览器拿不到。\n'
        + '\n'
        + '请改用「借壳解密工具」: 在你自己已登录 QQ 音乐的电脑上运行, '
        + '让客户端自己完成解密 (不需要你提供密钥)。\n'
        + '工具下载: ' + _siteBase() + '/qqmusic-frida.zip\n'
        + '\n'
        + '解密得到的 .ogg / .mp3 再拖回本页面转格式即可。'
      );
    }
    if (detected.type === 'v3-musicex') {
      // V3 / MusicEx: 同样需要外部 ekey, 浏览器端已无获取途径。
      throw new Error(
        'MusicEx (V3) 文件的解密密钥同样不在文件内, 浏览器无法获得。\n'
        + '\n'
        + '请改用「借壳解密工具」: 在你自己已登录 QQ 音乐的电脑上运行, '
        + '让客户端自己完成解密 (不需要你提供密钥)。\n'
        + '工具下载: ' + _siteBase() + '/qqmusic-frida.zip\n'
        + '\n'
        + '解密得到的 .ogg / .mp3 再拖回本页面转格式即可。'
      );
    }

    if (detected.type === 'v2-qtag') {
      // QTag: file[len-8..len-4] = keySize LE, file[len-4..len] = "QTag"
      // rawKey = file[audioSize..audioSize+keySize], includes "key,songId,mediaVer"
      const keySize = detected.keySize;
      const audioSize = fileBytes.length - keySize - 8;
      const rawKeyWithMeta = fileBytes.subarray(audioSize, audioSize + keySize);
      let commaIdx = -1;
      for (let i = 0; i < rawKeyWithMeta.length; i++) {
        if (rawKeyWithMeta[i] === 0x2C) { commaIdx = i; break; }
      }
      const rawKey = commaIdx >= 0 ? rawKeyWithMeta.subarray(0, commaIdx) : rawKeyWithMeta;
      return decryptWithDerivedKey(fileBytes.subarray(0, audioSize), rawKey, ext, tick);
    }

    if (detected.type === 'v1-embedded-key') {
      // 文件末尾 4 字节是 keySize (LE), 前面 file[0..size-keySize-4] 是加密音频
      const rawKey = fileBytes.subarray(detected.audioSize, fileBytes.length - 4);
      return decryptWithDerivedKey(fileBytes.subarray(0, detected.audioSize), rawKey, ext, tick);
    }

    if (detected.type === 'v1-static') {
      // 先看末尾 8 字节是不是 "musicex\0" 这种未知 marker
      const last8 = Array.from(fileBytes.slice(-8)).map(b => b.toString(16).padStart(2,'0')).join(' ');
      const last4Str = String.fromCharCode(fileBytes[fileBytes.length-8], fileBytes[fileBytes.length-7], fileBytes[fileBytes.length-6], fileBytes[fileBytes.length-5]);
      const last4StrEnd = String.fromCharCode(fileBytes[fileBytes.length-4], fileBytes[fileBytes.length-3], fileBytes[fileBytes.length-2], fileBytes[fileBytes.length-1]);
      // 特殊 marker 检测
      if (last4Str === 'musi' || (fileBytes[fileBytes.length-7] === 0x6D && fileBytes[fileBytes.length-6] === 0x75)) {
        // "musicex\0" 标记 — QQ 音乐 v22.52+ Windows 客户端新格式
        // 从 QQMusicCommon.dll 反汇编看出: 文件末尾 16 字节 = "musicex\0" (8 bytes) + 8 bytes metadata
        const head = Array.from(fileBytes.slice(0, 16)).map(b => b.toString(16).padStart(2,'0')).join(' ');
        const last16 = Array.from(fileBytes.slice(-16)).map(b => b.toString(16).padStart(2,'0')).join(' ');
        const last16Ascii = Array.from(fileBytes.slice(-16)).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
        throw new Error('QQ 音乐 v22.52+ 新格式 (末尾标记 "musicex\\0")。文件大小 ' + fileBytes.length + ' 字节。原始头 16 字节: ' + head + '。末尾 16 字节: ' + last16 + ' ("' + last16Ascii + '")。需要文件头 32 字节 + QQ 音乐 EKB 文件才能逆向 v3 算法。');
      }
      // 纯静态 XOR, 全段解密
      tick(0.1);
      QmcStaticCipher.decrypt(out, 0);
      tick(0.9);
      if (isPlausibleAudio(out, ext)) {
        tick(1.0);
        return { audio: out, ext, meta: {}, cover: null };
      }
      // 详细诊断信息
      const head = Array.from(out.slice(0, 16)).map(b => b.toString(16).padStart(2,'0')).join(' ');
      const last = Array.from(out.slice(-16)).map(b => b.toString(16).padStart(2,'0')).join(' ');
      // 显示原始末尾 8 字节 + 解析出的 keySize, 帮用户判断是哪种路径
      const tailRaw8 = Array.from(fileBytes.slice(-8)).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ');
      const ks = fileBytes[fileBytes.length-4] | (fileBytes[fileBytes.length-3] << 8) | (fileBytes[fileBytes.length-2] << 16) | (fileBytes[fileBytes.length-1] << 24);
      throw new Error('v1-static 路径 (检测为静态 XOR, 但解出后不像音频)。文件: ' + filename + ', 大小: ' + fileBytes.length + ' 字节。末尾 8 字节: ' + tailRaw8 + '。LE keySize 解析: ' + ks + ' (= 0x' + ks.toString(16) + ', 阈值 0x400=1024)。解密后头 16 字节: ' + head + ', 尾 16 字节: ' + last + '。');
    }

    // 未知类型
    throw new Error('未知的 QMC 文件结构 (不是已知的 v1 / v2 格式)');
  }

  // 检测文件末尾 4 字节,决定 cipher 类型
  function detectCipherType(fileBytes) {
    if (fileBytes.length < 8) return { type: 'unknown' };
    const last4 = String.fromCharCode(fileBytes[fileBytes.length-4], fileBytes[fileBytes.length-3], fileBytes[fileBytes.length-2], fileBytes[fileBytes.length-1]);
    if (last4 === 'STag') return { type: 'v2-stag' };
    if (last4 === 'QTag') {
      // QTag 后面 4 字节 = keySize
      if (fileBytes.length < 12) return { type: 'unknown' };
      const keySize = fileBytes[fileBytes.length-8] | (fileBytes[fileBytes.length-7] << 8) | (fileBytes[fileBytes.length-6] << 16) | (fileBytes[fileBytes.length-5] << 24);
      return { type: 'v2-qtag', keySize };
    }
    // V3: "musicex\0" marker at end (8 bytes)
    // 注意: 只看魔数, 不校验 version。
    // version 字段的偏移/语义与 parseFooter 的实现不同步, 在这里硬校验会
    // 把真·MusicEx 文件误判成 v1-static。
    if (fileBytes.length >= 192) {
      const m = fileBytes[fileBytes.length-8];
      const u = fileBytes[fileBytes.length-7];
      const s = fileBytes[fileBytes.length-6];
      const i = fileBytes[fileBytes.length-5];
      const c = fileBytes[fileBytes.length-4];
      const e = fileBytes[fileBytes.length-3];
      const x = fileBytes[fileBytes.length-2];
      const z = fileBytes[fileBytes.length-1];
      if (m === 0x6D && u === 0x75 && s === 0x73 && i === 0x69 && c === 0x63 && e === 0x65 && x === 0x78 && z === 0x00) {
        return { type: 'v3-musicex' };
      }
    }
    // 否则最后 4 字节 = keySize (LE)
    const keySize = fileBytes[fileBytes.length-4] | (fileBytes[fileBytes.length-3] << 8) | (fileBytes[fileBytes.length-2] << 16) | (fileBytes[fileBytes.length-1] << 24);
    if (keySize < 0x400 && keySize > 0 && (fileBytes.length - keySize - 4) > 0) {
      // 有嵌入 key, audioSize = totalSize - keySize - 4
      const audioSize = fileBytes.length - keySize - 4;
      return { type: 'v1-embedded-key', keySize, audioSize };
    }
    // 否则是纯静态密钥 v1
    return { type: 'v1-static' };
  }

  function makeCipherFromKey(key) {
    // unlock-music: keyDec.length > 300 → QmcRC4Cipher, else QmcMapCipher
    // 但 key 本身是 QmcDeriveKey 解密后的 — 完整流程需要 Tea
    // 简化: key 长度 < 300 → Map, >= 300 → RC4
    if (key.length >= 300) return new QmcRC4Cipher(key);
    return new QmcMapCipher(key);
  }

  // 从解密后数据喵出真实音频格式 (不依赖后缀, 实际文件头优先)
  function sniffAudioFormat(data) {
    if (data.length < 4) return null;
    // 跳过 ID3v2 header
    let off = 0;
    if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33 && data.length >= 10) {
      const tagSize = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
      off = 10 + tagSize;
    }
    // MP3: MPEG sync (FF Fx) 在 ID3 之后
    if (off + 2 <= data.length && data[off] === 0xFF && (data[off + 1] & 0xE0) === 0xE0) return 'mp3';
    // FLAC: fLaC
    if (data[0] === 0x66 && data[1] === 0x4C && data[2] === 0x61 && data[3] === 0x43) return 'flac';
    if (off + 4 <= data.length && data[off] === 0x66 && data[off + 1] === 0x4C && data[off + 2] === 0x61 && data[off + 3] === 0x43) return 'flac';
    // OGG: OggS
    if (data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) return 'ogg';
    if (off + 4 <= data.length && data[off] === 0x4F && data[off + 1] === 0x67 && data[off + 2] === 0x67 && data[off + 3] === 0x53) return 'ogg';
    // M4A: ?ftyp... (offset 4, not 0)
    if (data.length >= 8 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'm4a';
    // WAV: RIFF....WAVE
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'wav';
    return null;
  }

  function isPlausibleAudio(data, ext) {
    if (data.length < 4) return false;
    // 优先喵探真实格式, 忽略传入的 ext
    if (sniffAudioFormat(data)) return true;
    // 退到 ext 判断 (用户没传 ext)
    if (!ext) return false;
    let off = 0;
    if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33 && data.length >= 10) {
      const tagSize = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
      off = 10 + tagSize;
    }
    if (off + 2 > data.length) return false;
    if (ext === 'mp3') return data[off] === 0xFF && (data[off + 1] & 0xE0) === 0xE0;
    if (ext === 'flac') {
      if (data[0] === 0x66 && data[1] === 0x4C && data[2] === 0x61 && data[3] === 0x43) return true;
      return false;
    }
    if (ext === 'ogg') return data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
    if (ext === 'm4a') return data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70;
    if (ext === 'wav') return data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46;
    return true;
  }

  global.QMC = { decode, detect, getExt };
})(typeof window !== 'undefined' ? window : globalThis);
