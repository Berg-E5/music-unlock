/* ============================================
 * Decryption Worker
 * 浏览器后台线程跑解密,主线程不卡
 *
 * 协议:
 *   IN  { id, type: 'decrypt', file: File }
 *   OUT { id, type: 'progress', ratio }
 *   OUT { id, type: 'done', payload: { blob, filename, meta, size } }
 *   OUT { id, type: 'error', message }
 * ============================================ */

// 版本号 — 改了 worker.js 或 modules 时同步改这里, 强制浏览器绕缓存
const V = 103;

importScripts(
  `../../modules/aes-js.js?v=${V}`,
  `../../modules/crypto-utils.js?v=${V}`,
  `../../modules/ncm.js?v=${V}`,
  `../../modules/qmc.js?v=${V}`,
  `../../modules/qmc-mobile.js?v=${V}`,
  `../../modules/kgm.js?v=${V}`,
  `../../modules/metadata.js?v=${V}`,
  `../../modules/deflac.js?v=${V}`,
  `../../modules/lame.min.js?v=${V}`
);

const CU = self.CU;
const NCM = self.NCM;
const QMC = self.QMC;
const KGM = self.KGM;
const Metadata = self.Metadata;

// 用文件头魔数猜格式, 用于 handler 返回 ext='bin' 的兑底
function sniffExtByMagic(bytes) {
  if (!bytes || bytes.length < 4) return null;
  // FLAC: 'fLaC'
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 'flac';
  // OGG: 'OggS'
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'ogg';
  // MP3: 同步字 'FF FB' / 'FF F3' / 'FF F2' 之一
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  // M4A/MP4: 'ftyp' 在 4-7
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'm4a';
  // WAV: 'RIFF'....'WAVE'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'wav';
  return null;
}

function detectFormat(filename) {
  if (/\.ncm$/i.test(filename)) return 'ncm';
  // QMC: 扩展名是加密后缀, 后后可跟个普通音频后缀
  if (/\.(qmc0|qmc1|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|mgg|mgg0|mgg1|mggl|mgg2|mgg3|mflac|mflac0|mflac2|mmp4|mqmc|mqcf|mqms|mqms2|bkcmp3|bkcm4a|bkcflac|bkcogg|666c6163|6d7033|6f6767|6d3461|776176)(\.[^.]+)?$/i.test(filename)) return 'qmc';
  if (/\.(kgm|kgma|vpr)$/i.test(filename)) return 'kgm';
  return null;
}

// QMC 加密后缀, 走双后缀去缀
const QMC_TRAIL_SUFFIX = /\.(qmc0|qmc1|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|mgg|mgg0|mgg1|mggl|mgg2|mgg3|mflac|mflac0|mflac2|mmp4|mqmc|mqcf|mqms|mqms2|bkcmp3|bkcm4a|bkcflac|bkcogg|666c6163|6d7033|6f6767|6d3461|776176)(\.[^.]+)?$/i;

function stripQmcSuffix(name) {
  // 反复去后缀, 直到 QMC_TRAIL_SUFFIX 不再匹配
  let prev;
  do {
    prev = name;
    name = name.replace(QMC_TRAIL_SUFFIX, '');
  } while (name !== prev);
  return name;
}

function buildFilename(meta, originalName, ext) {
  const title  = (meta && meta.musicName) ? String(meta.musicName).trim() : '';
  const artist = (meta && Array.isArray(meta.artist)) ? meta.artist.map(a => a[0]).join(', ').trim() : '';
  if (title && artist) return `${artist} - ${title}.${ext}`;
  if (title) return `${title}.${ext}`;
  return stripQmcSuffix(originalName) + '.' + ext;
}

self.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'decrypt') return;
  const { id, file, outputFormat, mp3Bitrate } = msg;

  // ---------- FLAC/OGG/WAV → MP3 转码 (Web Audio API + lamejs) --------
  // Web Audio 的 AudioContext.decodeAudioData 浏览器原生支持 OGG/FLAC/WAV/MP3
  // AudioContext 不在 Worker 里, 通过 postMessage 委托主线程解码
  let _decodeSeq = 0;
  function decodeViaMainThread(audioBytes) {
    return new Promise((resolve, reject) => {
      const seq = ++_decodeSeq;
      const onMsg = (ev) => {
        const d = ev.data;
        if (d && d.type === 'audio-decoded' && d.seq === seq) {
          self.removeEventListener('message', onMsg);
          if (d.error) reject(new Error(d.error));
          else resolve(d);
        } else if (d && d.type === 'audio-decode-error' && d.seq === seq) {
          self.removeEventListener('message', onMsg);
          reject(new Error(d.error || 'decode 失败'));
        }
      };
      self.addEventListener('message', onMsg);
      // transferable: 复制一份发送 (原始 bytes 仍要保留给 transcode fallback)
      const copy = audioBytes.slice().buffer;
      self.postMessage({ id, type: 'audio-decode', seq, audioBuffer: copy }, [copy]);
    });
  }

  async function transcodeToMp3(audioBytes, srcExt, bitrate, onProgress) {
    if (!self.Mp3Encoder) throw new Error('lamejs 未加载');
    onProgress(0.05, '浏览器解码 ' + srcExt.toUpperCase() + ' → PCM...');
    let sampleRate, channels, chData;
    if (self.decodeFlac && srcExt === 'flac') {
      // FLAC 走 deflac (同步, 避免主线程负担)
      const decoded = self.decodeFlac(audioBytes);
      if (!decoded || !decoded.samples) throw new Error('FLAC 解码失败');
      sampleRate = decoded.sampleRate;
      channels = decoded.channels;
      const samples = decoded.samples;
      // samples 是 Int32Array interleaved; 拆成 [ch0[], ch1[]]
      chData = [];
      for (let c = 0; c < channels; c++) {
        const arr = new Float32Array(samples.length / channels);
        for (let i = 0; i < arr.length; i++) arr[i] = samples[i * channels + c] / 32768;
        chData.push(arr);
      }
    } else if (srcExt === 'ogg' || srcExt === 'flac' || srcExt === 'wav' || srcExt === 'mp3') {
      // 委托主线程 AudioContext.decodeAudioData
      const result = await decodeViaMainThread(audioBytes);
      sampleRate = result.sampleRate;
      channels = result.channels;
      // ch0, ch1 是 Float32Array, 已 transferable
      chData = [];
      for (let c = 0; c < channels; c++) chData.push(result['ch' + c]);
    } else {
      throw new Error('转码仅支持 FLAC/OGG/WAV/MP3 输入, 该文件是 ' + srcExt);
    }
    onProgress(0.5, 'MP3 编码中...');
    const length = chData[0].length;
    // 转 Int16
    const leftI16 = new Int16Array(length);
    const rightI16 = new Int16Array(length);
    const lr = chData[0];
    const rr = channels === 2 ? chData[1] : lr;
    for (let i = 0; i < length; i++) {
      let l = lr[i] * 32768, r = rr[i] * 32768;
      leftI16[i]  = l < -32768 ? -32768 : (l > 32767 ? 32767 : l | 0);
      rightI16[i] = r < -32768 ? -32768 : (r > 32767 ? 32767 : r | 0);
    }
    const enc = new self.Mp3Encoder(channels, sampleRate, bitrate);
    const mp3Chunks = [];
    const CHUNK = 1152;
    for (let i = 0; i < length; i += CHUNK) {
      const left = leftI16.subarray(i, i + CHUNK);
      const right = rightI16.subarray(i, i + CHUNK);
      const buf = enc.encodeBuffer(left, right);
      if (buf.length > 0) mp3Chunks.push(new Uint8Array(buf));
      if ((i / CHUNK) % 64 === 0) {
        onProgress(0.5 + 0.45 * (i / length), 'MP3 编码中 ' + Math.round(i / length * 100) + '%');
      }
    }
    const endBuf = enc.flush();
    if (endBuf.length > 0) mp3Chunks.push(new Uint8Array(endBuf));
    onProgress(1.0, '转码完成');
    let total = 0;
    for (const c of mp3Chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of mp3Chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  self.transcodeToMp3 = transcodeToMp3;

  try {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const fmt = detectFormat(file.name) || (/\.(flac|mp3|ogg|wav|m4a|aac|opus|ape)$/i.test(file.name) ? 'plain' : null);
    if (!fmt) throw new Error('不支持的文件格式: ' + file.name);

    // 诊断: 报告 module 加载状态
    console.log(`[worker v${V}] fmt=${fmt} name=${file.name} size=${file.size}`);
    console.log(`[worker v${V}] modules loaded: CU=${typeof CU} NCM=${typeof NCM} QMC=${typeof QMC} KGM=${typeof KGM} Metadata=${typeof Metadata}`);

    const bytes = new Uint8Array(await file.arrayBuffer());

    // 纯音频: 跳过 decrypt, 直接转码
    if (fmt === 'plain') {
      // 已经是 MP3 就原样返回 —— 走 lame 重编码只会白白掉音质。
      if (ext === 'mp3') {
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
        self.postMessage({
          id,
          type: 'done',
          payload: {
            blob,
            filename: file.name,
            meta: {},
            ext: 'mp3',
            size: blob.size,
            passthrough: true
          }
        });
        return;
      }
      const onTransPlain = (r, msg) => self.postMessage({ id, type: 'progress', ratio: 0.95 + r * 0.05, msg });
      const mp3Bytes = await transcodeToMp3(bytes, ext, mp3Bitrate || 320, onTransPlain);
      // 不抩 ID3 (plain 路径 meta={}, embedMp3 会直接 return audio)
      // 避免 Buffer.concat 在某些 worker 环境里 fail
      const blob = new Blob([mp3Bytes], { type: 'audio/mpeg' });
      const outName = file.name.replace(/\.[^.]+$/, '') + '.mp3';
      self.postMessage({
        id,
        type: 'done',
        payload: {
          blob,
          filename: outName,
          meta: {},
          ext: 'mp3',
          size: blob.size
        }
      });
      return;
    }

    let handler;
    if (fmt === 'ncm') handler = NCM;
    else if (fmt === 'qmc') handler = QMC;
    else if (fmt === 'kgm') handler = KGM;

    if (!handler || typeof handler.decode !== 'function') {
      throw new Error(`Handler ${fmt} 未加载 (handler=${handler}, typeof handler.decode=${handler && typeof handler.decode})`);
    }

    const onProg = (r) => self.postMessage({ id, type: 'progress', ratio: r });

    const opts = {};

    const result = await handler.decode(bytes, ext, onProg, opts);
    onProg(1.0);

    // 兜底: 如果 handler 没识别出格式, 用文件名后缀猜; 再不行用通用 .mp3
    let outExt = (result.ext || '').toLowerCase();
    console.log(`[worker v${V}] outExt from handler: '${outExt}', audio magic: ${Array.from(result.audio.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    if (outExt === 'bin' || !outExt) {
      const guessed = sniffExtByMagic(result.audio);
      if (guessed) outExt = guessed;
      else if (self.QmcMobile) {
        // 双后缀优先用 mobile infer (e.g. .mgg2.flac → .ogg)
        const inf = self.QmcMobile.inferOutputExt(file.name);
        if (inf && inf !== '.flac') outExt = inf.slice(1);
        else if (ext === 'mgg' || ext === 'mflac' || ext === 'qmcogg') outExt = 'ogg';
        else if (ext === 'qmcflac' || ext === 'mggl') outExt = 'flac';
        else outExt = 'mp3';
      }
      else if (ext === 'mgg' || ext === 'mflac' || ext === 'qmcogg') outExt = 'ogg';
      else if (ext === 'qmcflac' || ext === 'mggl') outExt = 'flac';
      else outExt = 'mp3';
    }
    const meta   = result.meta || {};

    // 如果用户要求转码为 MP3 且解密后不是 MP3, 转码; 已经是 MP3 跳过 (免二次有损)
    if (outputFormat === 'mp3' && outExt !== 'mp3') {
      try {
        const onTrans = (r, msg) => self.postMessage({ id, type: 'progress', ratio: 0.95 + r * 0.05, msg });
        const mp3Bytes = await transcodeToMp3(result.audio, outExt, mp3Bitrate || 320, onTrans);
        // 转码后的 MP3 抩入 ID3 标签
        const tagged = Metadata.embedMp3(mp3Bytes, meta, result.cover || null);
        const blob = new Blob([tagged], { type: 'audio/mpeg' });
        outExt = 'mp3';
        // 覆盖后续逻辑, 直接跳到 done postMessage
        self.postMessage({
          id,
          type: 'done',
          payload: {
            blob,
            filename: buildFilename(meta, file.name, outExt),
            meta,
            ext: outExt,
            size: blob.size
          }
        });
        return;
      } catch (e) {
        throw new Error('转码失败: ' + e.message + '\n提示: 该文件可手动用 ffmpeg 转码: ffmpeg -i input.flac -ab 320k output.mp3');
      }
    }

    let blob;
    if (outExt === 'mp3') {
      const tagged = Metadata.embedMp3(result.audio, meta, result.cover || null);
      blob = new Blob([tagged], { type: 'audio/mpeg' });
    } else if (outExt === 'flac') {
      const tagged = Metadata.embedFlac(result.audio, meta, result.cover || null);
      blob = new Blob([tagged], { type: 'audio/flac' });
    } else if (outExt === 'ogg') {
      const tagged = Metadata.embedOgg(result.audio, meta, result.cover || null);
      blob = new Blob([tagged], { type: 'audio/ogg' });
    } else {
      // fallback: 用二进制通用 MIME (audio/mpeg 是浏览器最不会改后缀的兜底),
      // 真正的后缀由 buildFilename(meta, file.name, outExt) 给出的扩展名决定
      blob = new Blob([result.audio], { type: 'audio/mpeg' });
    }

    self.postMessage({
      id,
      type: 'done',
      payload: {
        blob,
        filename: buildFilename(meta, file.name, outExt),
        meta,
        size: blob.size,
        ext: outExt
      }
    });
  } catch (err) {
    console.error('[worker]', err);
    self.postMessage({
      id,
      type: 'error',
      message: (err && err.message) ? err.message : String(err)
    });
  }
});
