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
  //
  // 对应 Rust um_crypto 的 v2_map (key.rs::key_compress + transform.rs)。
  //
  // 注意: 旧的 unlock-music 公式是 getMask(offset) = rotate(key[(offset²+71214)%n], ...)
  // —— 每字节重新平方索引。那套是 v1 static cipher 的思路, 与 Rust 的 v2_map 不同,
  // 两者只在 offset=0 时偶然一致 (索引都是 71214 % n), 之后就分道扬镳。
  //
  // Rust v2_map 的实际流程:
  //   1. key_compress: 把 n 字节主密钥压缩成 128 字节调度表
  //      result[i] = rotate_left(long_key[(i*i + 71214) % n], (idx+4) % 8)
  //   2. transform:   按绝对偏移 pos 取调度表, 索引 = pos % 128 连续循环
  //      边界: pos <= 0x7FFF 时索引 = pos % 128; pos > 0x7FFF 时先 % 0x7FFF 再 % 128
  //      (所以 0x7FFF 的索引是 127, 0x8000 的索引是 1)
  class QmcMapCipher {
    static KEY_SIZE = 128;
    static OFFSET_BOUNDARY = 0x7fff;

    constructor(key) {
      if (!key || key.length === 0) throw new Error('QmcMapCipher: key 不能为空');
      this.n = key.length;
      this.sched = QmcMapCipher.keyCompress(key);
    }

    /** Rust v2_map/key.rs::key_compress —— 长密钥 -> 128 字节调度表 */
    static keyCompress(longKey) {
      const n = longKey.length;
      const out = new Uint8Array(QmcMapCipher.KEY_SIZE);
      for (let i = 0; i < QmcMapCipher.KEY_SIZE; i++) {
        const idx = (i * i + 71214) % n;
        const shift = (idx + 4) % 8;
        const v = longKey[idx];
        out[i] = ((v << shift) | (v >> shift)) & 0xff;
      }
      return out;
    }

    /** Rust v2_map/transform.rs —— 按绝对偏移取 mask 字节 */
    maskAt(pos) {
      if (pos > QmcMapCipher.OFFSET_BOUNDARY) pos = pos % QmcMapCipher.OFFSET_BOUNDARY;
      return this.sched[pos % QmcMapCipher.KEY_SIZE];
    }

    decrypt(buf, offset) {
      // 按 0x7FFF 边界切段: 段内 pos 连续递增, 索引 = pos % 128 循环
      let pos = offset;
      let i = 0;
      const total = buf.length;
      while (i < total) {
        let take, phase;
        if (pos <= QmcMapCipher.OFFSET_BOUNDARY) {
          take = Math.min(0x8000 - pos, total - i);
          phase = pos % QmcMapCipher.KEY_SIZE;
        } else {
          const r = pos % QmcMapCipher.OFFSET_BOUNDARY;
          take = Math.min(QmcMapCipher.OFFSET_BOUNDARY - r, total - i);
          phase = r % QmcMapCipher.KEY_SIZE;
        }
        for (let k = 0; k < take; k++) {
          buf[i + k] ^= this.sched[(phase + k) % QmcMapCipher.KEY_SIZE];
        }
        i += take;
        pos += take;
      }
    }
  }

  // ---------- v2: RC4 cipher (segment-based) --------------------------------
  //
  // 对应 Rust um_crypto 的 v2_rc4 (hash.rs / segment_key.rs / cipher.rs)。
  //
  // 关键: RC4 是**连续流**, 不是每段重置。Rust 侧预先生成一段 0x1600 字节的
  // 密钥流缓存, 各段按 skip 偏移去切连续片段; 旧的 unlock-music 移植每段都
  // 重新 KSA 并从 -skipLen 重跑, 状态被重置 -> 解出来的是垃圾。
  //
  // 另外 Rust 的 get_segment_key 是:
  //   denom = (id + 1) * seed            (u64 溢出取模)
  //   value = int(hash / float(denom) * 100.0)
  // first segment 用 value % n, other segment 用 value & 0x1FF (作为流内 skip)。
  class QmcRC4Cipher {
    static FIRST_SEGMENT_SIZE = 0x80;
    static SEGMENT_SIZE = 0x1400;
    static STREAM_CACHE_SIZE = 0x1600;

    constructor(key) {
      if (!key || key.length === 0) throw new Error('QmcRC4Cipher: key 不能为空');
      this.key = key;
      this.N = key.length;

      // --- KSA: 状态长度 = 密钥长度 (非 256), 状态值是 u8 (i & 0xff) ---
      const S = new Uint8Array(this.N);
      for (let i = 0; i < this.N; i++) S[i] = i & 0xff;
      let j = 0;
      for (let i = 0; i < this.N; i++) {
        j = (j + S[i] + this.key[i % this.N]) % this.N;
        const t = S[i]; S[i] = S[j]; S[j] = t;
      }
      this.S = S;

      // --- hash: Rust v2_rc4/hash.rs ---
      let h = 1;
      for (let i = 0; i < this.N; i++) {
        const v = this.key[i];
        if (!v) continue;
        const next = Math.imul(h, v) >>> 0;
        if (next === 0 || next <= h) break;
        h = next;
      }
      this.hash = h;

      // --- 预生成连续密钥流 (Rust cipher.rs 的 key_stream 缓存) ---
      this.keyStream = new Uint8Array(QmcRC4Cipher.STREAM_CACHE_SIZE);
      let ii = 0, jj = 0;
      for (let k = 0; k < QmcRC4Cipher.STREAM_CACHE_SIZE; k++) {
        ii = (ii + 1) % this.N;
        jj = (jj + this.S[ii]) % this.N;
        const t = this.S[ii]; this.S[ii] = this.S[jj]; this.S[jj] = t;
        this.keyStream[k] = this.S[(this.S[ii] + this.S[jj]) % this.N];
      }
    }

    /** Rust v2_rc4/segment_key.rs::get_segment_key */
    getSegmentKey(id, seed) {
      if (seed === 0) return 0;
      // denom = (id+1) * seed, u64 溢出取模 (JS 用 Number 精度足够: id <= 2^32)
      const denom = (id + 1) * seed;
      // 注意: Rust 是 f64 除法, hash 已是 u32
      return Math.floor(this.hash / denom * 100.0);
    }

    /** 首段 (0x80 字节): mask = key[get_segment_key(pos, key[pos%n]) % n] */
    processFirstSegment(buf, start, length, offset) {
      const n = this.N;
      for (let j = 0; j < length; j++) {
        const o = offset + j;
        const segKey = this.getSegmentKey(o, this.key[o % n]);
        buf[start + j] ^= this.key[segKey % n];
      }
    }

    /** 后续段: mask = keyStream[skip + blockOff ..] —— 连续流切片 */
    processOtherSegment(buf, start, length, offset) {
      const n = this.N;
      const segId = Math.floor(offset / QmcRC4Cipher.SEGMENT_SIZE);
      const blockOff = offset % QmcRC4Cipher.SEGMENT_SIZE;
      const seed = this.key[segId % n];
      const skip = this.getSegmentKey(segId, seed) & 0x1ff;
      const base = skip + blockOff;
      for (let j = 0; j < length; j++) {
        buf[start + j] ^= this.keyStream[base + j];
      }
    }

    decrypt(buf, offset) {
      const total = buf.length;
      let pos = offset;
      let start = 0;

      if (pos < QmcRC4Cipher.FIRST_SEGMENT_SIZE) {
        const take = Math.min(QmcRC4Cipher.FIRST_SEGMENT_SIZE - pos, total - start);
        this.processFirstSegment(buf, start, take, pos);
        start += take;
        pos += take;
      }

      // 对齐到段边界
      if (pos % QmcRC4Cipher.SEGMENT_SIZE !== 0 && start < total) {
        const take = Math.min(
          QmcRC4Cipher.SEGMENT_SIZE - (pos % QmcRC4Cipher.SEGMENT_SIZE),
          total - start);
        this.processOtherSegment(buf, start, take, pos);
        start += take;
        pos += take;
      }

      // 整段批处理
      while (total - start > QmcRC4Cipher.SEGMENT_SIZE) {
        this.processOtherSegment(buf, start, QmcRC4Cipher.SEGMENT_SIZE, pos);
        start += QmcRC4Cipher.SEGMENT_SIZE;
        pos += QmcRC4Cipher.SEGMENT_SIZE;
      }

      // 尾巴
      if (start < total) {
        this.processOtherSegment(buf, start, total - start, pos);
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
  // ekey 的来源有两种形态: 字符串 (base64 文本) 或字节数组。
  // 统一在这里转成字节数组 —— QmcDecryptKey 内部走 bytesToAscii -> base64Decode,
  // 直接传字符串会被当成字节数组逐字符取, 静默产出垃圾。
  function ekeyTextToBytes(ekey) {
    if (ekey instanceof Uint8Array) return ekey;
    if (Array.isArray(ekey)) return new Uint8Array(ekey);
    const s = String(ekey).trim();
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function decryptWithDerivedKey(audioBytes, rawKey, ext, tick, meta) {
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
        return { audio: audioOut, ext: sniffAudioFormat(audioOut) || ext, meta: meta || {}, cover: null };
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
      // MusicEx (V3): footer 只有元数据, 密钥不在文件内 —— 但 **ekey 可以由用户提供**。
      // (早先这里写的是「浏览器无法获得」, 那句话是错的: 只是不能自动拿到,
      //  用户自己从 QQ 音乐 API 取到后填进来就行。)
      const footer = parseMusicExFooter(fileBytes);
      const ekeyText = opts && opts.ekey;
      if (!ekeyText) {
        throw new Error(
          'MusicEx (V3) 文件的解密密钥不在文件内, 需要你提供 ekey。\n'
          + '\n'
          + '获取方式: 用你的 QQ 音乐账号登录后调用 QQ 音乐 API 拿 songmid 对应的 ekey,\n'
          + '然后在下面填入 (或用「借壳解密工具」在已登录的电脑上让客户端自己解密)。\n'
          + '工具下载: ' + _siteBase() + '/qqmusic-frida.zip\n'
          + '\n'
          + '解密得到的 .ogg / .mp3 再拖回本页面转格式即可。'
        );
      }
      // footer 缺失 → 裁掉默认 192 字节 (Rust oracle 的 PcV2MusicEx 固定长度)
      const audioSize = footer ? footer.audioSize : (fileBytes.length - MUSICEX_FOOTER_SIZE);
      const ekeyBytes = ekeyTextToBytes(ekeyText);
      return decryptWithDerivedKey(fileBytes.subarray(0, audioSize), ekeyBytes, ext, tick, footer);
    }

    if (detected.type === 'v2-qtag') {
      // QTag (Rust qmc/src/footer/): [密文][csv][payload_len u32 BE][b'QTag']
      // csv 格式 = "ekey,rid,ver" 三段, ver 必须是 '2' (与 oracle parse_footer 一致)
      const payloadLen = detected.keySize;
      const audioSize = fileBytes.length - payloadLen - 8;
      if (audioSize <= 0) {
        throw new Error('QTag: payload 长度非法 (' + payloadLen + '), 文件总长 ' + fileBytes.length);
      }
      const csvBuf = fileBytes.subarray(audioSize, audioSize + payloadLen);
      const csv = Array.from(csvBuf).map(b => String.fromCharCode(b)).join('');
      const parts = csv.split(',');
      if (parts.length !== 3) {
        throw new Error('QTag: CSV 格式错误 (应为 ekey,rid,ver 三段, 实际 ' + parts.length + ' 段)');
      }
      const [ekey, rid, ver] = parts;
      if (ver !== '2') {
        throw new Error('QTag: 版本不支持: ' + ver);
      }
      if (!/^\d+$/.test(rid)) {
        throw new Error('QTag: ID 非法: ' + rid);
      }
      // rawKey 必须是字节数组 (QmcDecryptKey 内部走 bytesToAscii -> base64Decode),
      // 传字符串会被当成字节数组逐字符取, 静默产出垃圾。
      const ekeyRaw = ekeyTextToBytes(ekey);
      return decryptWithDerivedKey(fileBytes.subarray(0, audioSize), ekeyRaw, ext, tick);
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
      // QTag 结构 (Rust qmc/src/footer/): [payload][payload_len u32 **BE**][b'QTag']
      // 长度字段在 QTag **前面**, 且是大端 —— 之前这里按 LE 读 file[len-8..len-4],
      // 算出的 audioSize 全错, 切出来的 key 片段是垃圾, 于是报 "key length too short"。
      if (fileBytes.length < 12) return { type: 'unknown' };
      const payloadLen = (fileBytes[fileBytes.length - 8] * 0x1000000) +
        (fileBytes[fileBytes.length - 7] << 16) +
        (fileBytes[fileBytes.length - 6] << 8) +
        fileBytes[fileBytes.length - 5];
      return { type: 'v2-qtag', keySize: payloadLen };
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

  // ---------- MusicEx (V3) footer 解析 --------------------------------------
  //
  // PC 客户端 19.57+ / Windows 22.x+ 的 musicex 格式。footer 只有元数据
  // (song_id / quality / media_mid / media_filename), **不含密钥** ——
  // ekey 必须另外提供。所以这一类文件的解密是「同一条 QMC2 cipher,
  // 换个 key 来源」, 不是新算法。
  //
  // 字节布局 (由 test/xval-vectors/qmc_ref.py 的 parse_footer 逐字节对拍确认):
  //   文件尾 16 字节: [payload_len u32 LE][version u32 LE]["musicex\0"]
  //   payload_len = 0xC0 (192) 是 **整个 footer 长度**, 不是 inner 长度
  //   inner (176B) = song_id(4) + quality1(4) + quality2(4)
  //                  + media_mid[60] UTF-16LE + media_filename[100] UTF-16LE
  //   两个字符串字段都以双零终止, 固定宽度只是上界 → 读到第一个双零即可
  const MUSICEX_MAGIC = [0x6D, 0x75, 0x73, 0x69, 0x63, 0x65, 0x78, 0x00]; // "musicex\0"
  const MUSICEX_FOOTER_SIZE = 192; // 0xC0 —— Rust oracle 的 PcV2MusicEx 固定 footer 长度

  function readUtf16leCstr(bytes, offset, maxLen) {
    let s = '';
    const end = Math.min(offset + maxLen, bytes.length);
    for (let i = offset; i < end - 1; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) break;
      s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return s;
  }

  // 解析 musicex footer。成功返回 {type, footerSize, audioSize, songId, mid, mediaFilename}
  // 不匹配返回 null。
  function parseMusicExFooter(fileBytes) {
    if (!fileBytes || fileBytes.length < 32) return null;
    const n = fileBytes.length;
    // 尾部 8 字节魔数
    for (let i = 0; i < 8; i++) {
      if (fileBytes[n - 8 + i] !== MUSICEX_MAGIC[i]) return null;
    }
    const payloadLen = (fileBytes[n - 16] | (fileBytes[n - 15] << 8) |
                        (fileBytes[n - 14] << 16) | (fileBytes[n - 13] << 24)) >>> 0;
    const version = (fileBytes[n - 12] | (fileBytes[n - 11] << 8) |
                      (fileBytes[n - 10] << 16) | (fileBytes[n - 9] << 24)) >>> 0;
    if (version !== 1) return null;
    // payload_len 是整个 footer 长度; 至少要装下尾部 16 字节
    if (payloadLen < 16 || payloadLen > n) return null;

    // inner = footer 去掉尾部 16 字节 (payload_len / version / magic) 的前段
    const footerStart = n - payloadLen;
    const innerLen = payloadLen - 16;
    if (innerLen < 12 + 60 + 100) return null; // 字段装不下
    const inner = fileBytes.subarray(footerStart, footerStart + innerLen);

    const songId = (inner[0] | (inner[1] << 8) | (inner[2] << 16) | (inner[3] << 24)) >>> 0;
    const mid = readUtf16leCstr(inner, 12, 60);
    const mediaFilename = readUtf16leCstr(inner, 12 + 60, 100);
    if (!mid) return null; // 没有 mid 说明不是合法的 MusicEx footer

    return {
      type: 'v3-musicex',
      footerSize: payloadLen,
      audioSize: footerStart,
      songId,
      mid,
      mediaFilename,
    };
  }

  global.QMC = { decode, detect, getExt, parseMusicExFooter };
})(typeof window !== 'undefined' ? window : globalThis);
