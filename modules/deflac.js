/**
 * deflac.js — a tiny, dependency-free FLAC audio decoder for ES2023.
 *
 * Target runtime: QuickJS (`qjs`). Also works in Node.js, Deno, Bun and
 * modern browsers (anything with ES2023).
 *
 * The decoder implements the "raw" (native) FLAC stream format:
 *
 *   https://xiph.org/flac/format.html
 *
 * Internally it is a fully resumable, streaming state machine: input may be
 * fed in arbitrarily small chunks (even single bytes) and decoding continues
 * exactly where it stopped. The internal input buffer is compacted as data
 * is consumed, so memory usage stays bounded by roughly one audio frame
 * plus a small slack. Channel data is decoded through CONSTANT, VERBATIM,
 * FIXED and LPC subframes (with Rice / Rice2 residual coding, escape
 * partitions and wasted-bits support), followed by stereo decorrelation
 * (left/side, right/side, mid/side) and interleaving. Both frame CRC-8 and
 * frame CRC-16 are verified; corrupted frames are dropped and the decoder
 * resynchronises on the next frame sync code.
 *
 * Public API (high level):
 *
 *   import { FlacDecoder, decodeFlac, toWav } from './deflac.js';
 *
 *   // One-shot decoding:
 *   const result = decodeFlac(arrayBufferOrUint8Array);
 *   // result: { ok, error, sampleRate, channels, bitsPerSample,
 *   //           totalSamples, duration, md5, samples: Int32Array, ... }
 *
 *   // Streaming:
 *   const dec = new FlacDecoder();
 *   dec.push(chunk1).push(chunk2).end();
 *   for (let b; (b = dec.readBlock()) !== null; ) { /* use b.samples *\/ }
 *
 *   // Convert decoded PCM to a RIFF/WAVE file:
 *   const wavBuffer = toWav(result);
 *
 * Samples are signed integers in the stream's native range (e.g. 16-bit
 * audio yields values in [-32768, 32767]), interleaved by channel.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
 * Small numeric helpers
 * ═══════════════════════════════════════════════════════════════════════ */

const POW2 = new Float64Array(64);
for (let i = 0; i < 64; i++) POW2[i] = 2 ** i;

/* CRC-8 (polynomial 0x07) and CRC-16 (polynomial 0x8005), both MSB-first,
 * initial value 0, no final XOR — exactly as specified by the FLAC format. */
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let k = 0; k < 8; k++) {
    c8 = (c8 & 0x80) !== 0 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = (c16 & 0x8000) !== 0 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}

/* Fixed predictor coefficients (orders 1..4). */
function fixedPredict(b, i, order) {
  switch (order) {
    case 1:
      return b[i - 1];
    case 2:
      return 2 * b[i - 1] - b[i - 2];
    case 3:
      return 3 * b[i - 1] - 3 * b[i - 2] + b[i - 3];
    default:
      return 4 * b[i - 1] - 6 * b[i - 2] + 4 * b[i - 3] - b[i - 4];
  }
}

function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof ArrayBuffer === 'function' && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('expected Uint8Array or ArrayBuffer, got ' + typeof data);
}

function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i] < 16 ? '0' + bytes[i].toString(16) : bytes[i].toString(16);
  }
  return s;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Internal state machine constants
 *
 * The numeric ordering matters: states S_FRAME_HEADER..S_FOOTER are "inside
 * an audio frame" and keep the frame start position as a compaction anchor.
 * ═══════════════════════════════════════════════════════════════════════ */

const S_INIT = 0; // searching for the "fLaC" stream marker
const S_METADATA = 1; // reading a metadata block header
const S_STREAMINFO = 2; // reading the STREAMINFO payload
const S_SKIP = 3; // skipping a metadata block payload
const S_SYNC = 4; // searching for an audio frame sync code
const S_FRAME_HEADER = 5; // reading an audio frame header
const S_SUBFRAME_HEADER = 6; // reading a channel subframe header
const S_SUB_CONSTANT = 7; // CONSTANT subframe payload
const S_SUB_VERBATIM = 8; // VERBATIM subframe payload
const S_WARMUP = 9; // predictor warm-up samples (FIXED/LPC)
const S_LPC_HEADER = 10; // LPC precision/shift
const S_LPC_COEFFS = 11; // LPC coefficients
const S_RESIDUAL_HEADER = 12; // residual coding method + partition order
const S_RESIDUAL_PARTITION = 13; // Rice partition header
const S_RESIDUAL_SAMPLES = 14; // Rice/raw residual samples
const S_DECORRELATE = 15; // stereo decorrelation + interleave
const S_FOOTER = 16; // frame padding + CRC-16 check
const S_EOS = 17; // clean end of stream
const S_ABORT = 18; // fatal error

const S_FRAME_MIN = S_FRAME_HEADER;
const S_FRAME_MAX = S_FOOTER;

/* ═══════════════════════════════════════════════════════════════════════════
 * FlacDecoder
 * ═══════════════════════════════════════════════════════════════════════ */

class FlacDecoder {
  /* ── input buffer ─────────────────────────────────────────────────── */
  #buf = new Uint8Array(1 << 14);
  #len = 0; // number of valid bytes in #buf
  #pos = 0; // read cursor (byte index)
  #bit = 0; // bits consumed within the byte at #pos (0..7)
  #uflow = false;
  /* ── lifecycle ────────────────────────────────────────────────────── */
  #ended = false; // end() was called
  #done = false; // terminal state reached (no more blocks)
  #error = null; // { code, message } once a fatal error occurred
  /* ── stream level ─────────────────────────────────────────────────── */
  #state = S_INIT;
  #si = null; // decoded STREAMINFO contents
  #metaIsLast = false;
  #metaSkipRem = 0;
  #id3Checked = false;
  #id3Rem = 0;
  /* ── frame level ──────────────────────────────────────────────────── */
  #frameStart = 0; // byte offset of the current frame header
  #blockSize = 0;
  #channels = 0;
  #channelMode = 0; // 4-bit channel assignment code
  #bps = 0; // frame sample size in bits
  #blockingVar = false; // variable (sample number) blocking strategy
  #codedNumber = 0; // frame or sample number
  #chan = 0; // channel currently being decoded
  /* ── subframe level ───────────────────────────────────────────────── */
  #subPos = 0; // rewind position of the current subframe header
  #subBit = 0;
  #order = 0;
  #isLpc = false;
  #wasted = 0;
  #subBps = 0; // bits per sample of this subframe
  #idx = 0; // warm-up/verbatim/residual sample cursor
  #coef = new Float64Array(32); // LPC coefficients
  #coefIdx = 0;
  #lpcPrec = 0;
  #lpcShift = 0;
  /* ── residual level ───────────────────────────────────────────────── */
  #riceBits = 4; // 4 (RICE) or 5 (RICE2)
  #partOrder = 0;
  #partSamples = 0; // samples per partition
  #partIdx = 0;
  #partEnd = 0; // exclusive end of the current partition
  #rawBits = -1; // >= 0 → "escaped" raw partition
  #riceParam = 0;
  #riceZ = 0; // unary quotient accumulated so far
  #ricePhase = 0; // 0 = reading unary, 1 = reading low bits
  /* ── output ───────────────────────────────────────────────────────── */
  #chanBufs = []; // per-channel Float64Array
  #chanCap = 0;
  #frameOut = null; // Int32Array, interleaved samples
  #onBlock = null;
  #blocks = []; // decoded blocks waiting to be read
  /* ── statistics ───────────────────────────────────────────────────── */
  #frames = 0;
  #lost = 0;

  /**
   * @param {object} [options]
   * @param {(block: object) => void} [options.onBlock]
   *        Callback invoked with each decoded block as soon as it is ready.
   *        When given, blocks are delivered through the callback only and
   *        {@link FlacDecoder#readBlock} always returns null.
   */
  constructor(options = {}) {
    this.#onBlock = typeof options.onBlock === 'function' ? options.onBlock : null;
  }

  /* ── public API ──────────────────────────────────────────────────────── */

  /** STREAMINFO contents, or null before it has been parsed. */
  get info() {
    const si = this.#si;
    if (!si) return null;
    return {
      sampleRate: si.sampleRate,
      channels: si.channels,
      bitsPerSample: si.bitsPerSample,
      totalSamples: si.totalSamples,
      minBlockSize: si.minBlockSize,
      maxBlockSize: si.maxBlockSize,
      minFrameSize: si.minFrameSize,
      maxFrameSize: si.maxFrameSize,
      md5: hex(si.md5),
    };
  }

  /** Fatal error (`{ code, message }`) or null. */
  get error() {
    return this.#error;
  }

  /** `{ framesDecoded, framesLost }`. */
  get stats() {
    return { framesDecoded: this.#frames, framesLost: this.#lost };
  }

  /** True once no further blocks can be produced (end of stream or error). */
  get done() {
    return this.#done;
  }

  /**
   * Feeds a chunk of raw FLAC data into the decoder. `data` may be a
   * Uint8Array or an ArrayBuffer. Returns the decoder for chaining.
   */
  push(data) {
    if (this.#done) return this; // ignore input after a terminal state
    this.#append(toU8(data));
    this.#pump();
    return this;
  }

  /** Signals that no more input will be pushed. */
  end() {
    this.#ended = true;
    this.#pump();
    return this;
  }

  /**
   * Returns the next decoded block, or null when no more blocks are
   * currently available (either because more input is needed or because the
   * stream ended / failed).
   *
   * Block shape:
   *   {
   *     samples: Int32Array,   // interleaved, native range
   *     sampleRate, channels, bitsPerSample, blockSize,
   *     frameNumber,           // for fixed blocking strategy, else null
   *     sampleNumber           // for variable blocking strategy, else null
   *   }
   */
  readBlock() {
    if (this.#blocks.length > 0) return this.#blocks.shift();
    if (this.#done) return null;
    this.#pump(); // normally a no-op; kept for robustness
    return this.#blocks.length > 0 ? this.#blocks.shift() : null;
  }

  /**
   * One-shot convenience: decodes `data` completely and returns a result
   * object with the stream metadata and all interleaved samples.
   * Cannot be combined with the `onBlock` constructor option.
   */
  decode(data) {
    if (this.#onBlock) {
      throw new Error('decode() cannot be used when the onBlock option is set');
    }
    this.push(data).end();
    const blocks = this.#blocks;
    let total = 0;
    for (let i = 0; i < blocks.length; i++) total += blocks[i].samples.length;
    const samples = new Int32Array(total);
    let off = 0;
    for (let i = 0; i < blocks.length; i++) {
      samples.set(blocks[i].samples, off);
      off += blocks[i].samples.length;
    }
    const si = this.#si;
    const err = this.#error;
    const ok = !err && (this.#frames > 0 || this.#lost === 0);
    return {
      ok,
      error: ok ? null : err ?? {
        code: 'NO_FRAMES_DECODED',
        message: 'no decodable audio frames found in the stream',
      },
      sampleRate: si ? si.sampleRate : null,
      channels: si ? si.channels : null,
      bitsPerSample: si ? si.bitsPerSample : null,
      totalSamples: si ? si.totalSamples : null,
      duration: si && si.sampleRate && si.channels
        ? total / (si.sampleRate * si.channels)
        : null,
      md5: si ? hex(si.md5) : null,
      minBlockSize: si ? si.minBlockSize : null,
      maxBlockSize: si ? si.maxBlockSize : null,
      minFrameSize: si ? si.minFrameSize : null,
      maxFrameSize: si ? si.maxFrameSize : null,
      samples,
      frames: this.#frames,
      framesLost: this.#lost,
    };
  }

  /* ── driver ──────────────────────────────────────────────────────────── */

  #pump() {
    if (this.#run() !== 'stall') this.#done = true;
  }

  #run() {
    for (;;) {
      if (this.#state === S_EOS) return 'eos';
      if (this.#state === S_ABORT) return 'abort';
      if (!this.#step()) {
        if (this.#state === S_EOS) return 'eos';
        if (this.#state === S_ABORT) return 'abort';
        if (this.#ended) {
          // Out of data with the end flag set: decide between a clean end
          // and a truncation error.
          if (this.#state === S_SYNC) {
            this.#state = S_EOS;
            return 'eos';
          }
          if (this.#state === S_INIT) {
            this.#fail('NO_FLAC_STREAM', 'the "fLaC" stream marker was not found');
          }
          this.#fail('TRUNCATED', 'unexpected end of stream inside ' + this.#stateName());
        }
        return 'stall';
      }
    }
  }

  #stateName() {
    return [
      'the stream header search', 'a metadata block header', 'the STREAMINFO block',
      'a metadata block', 'the frame sync search', 'a frame header',
      'a subframe header', 'a CONSTANT subframe', 'a VERBATIM subframe',
      'predictor warm-up samples', 'the LPC header', 'the LPC coefficients',
      'the residual header', 'a Rice partition header', 'residual samples',
      'channel decorrelation', 'the frame footer',
    ][this.#state] ?? 'an unknown state';
  }

  #step() {
    switch (this.#state) {
      case S_INIT: return this.#sInit();
      case S_METADATA: return this.#sMetadata();
      case S_STREAMINFO: return this.#sStreaminfo();
      case S_SKIP: return this.#sSkip();
      case S_SYNC: return this.#sSync();
      case S_FRAME_HEADER: return this.#sFrameHeader();
      case S_SUBFRAME_HEADER: return this.#sSubframeHeader();
      case S_SUB_CONSTANT: return this.#sSubConstant();
      case S_SUB_VERBATIM: return this.#sSubVerbatim();
      case S_WARMUP: return this.#sWarmup();
      case S_LPC_HEADER: return this.#sLpcHeader();
      case S_LPC_COEFFS: return this.#sLpcCoeffs();
      case S_RESIDUAL_HEADER: return this.#sResidualHeader();
      case S_RESIDUAL_PARTITION: return this.#sResidualPartition();
      case S_RESIDUAL_SAMPLES: return this.#sResidualSamples();
      case S_DECORRELATE: return this.#sDecorrelate();
      case S_FOOTER: return this.#sFooter();
      default:
        return this.#fail('INTERNAL', 'invalid decoder state ' + this.#state);
    }
  }

  #fail(code, message) {
    if (!this.#error) this.#error = { code, message };
    this.#state = S_ABORT;
    return false;
  }

  /** Drops the current frame and searches for the next sync code. */
  #badFrame() {
    this.#lost++;
    this.#state = S_SYNC;
    this.#pos = this.#frameStart + 1;
    this.#bit = 0;
    return true;
  }

  /* ── bit-level input ─────────────────────────────────────────────────── */

  #availBits() {
    return (this.#len - this.#pos) * 8 - this.#bit;
  }

  #ensure(n) {
    return this.#availBits() >= n;
  }

  /**
   * Reads up to 32 bits, MSB first. Never consumes anything when the
   * requested number of bits is not available; sets #uflow instead, so that
   * every state can simply retry once more data has been pushed.
   */
  #read(n) {
    if ((this.#len - this.#pos) * 8 - this.#bit < n) {
      this.#uflow = true;
      return 0;
    }
    this.#uflow = false;
    let v = 0;
    let pos = this.#pos;
    let bit = this.#bit;
    const buf = this.#buf;
    while (n > 0) {
      const avail = 8 - bit;
      const b = buf[pos];
      if (n >= avail) {
        v = v * POW2[avail] + (b & ((1 << avail) - 1));
        n -= avail;
        pos++;
        bit = 0;
      } else {
        v = v * POW2[n] + ((b >>> (avail - n)) & ((1 << n) - 1));
        bit += n;
        n = 0;
      }
    }
    this.#pos = pos;
    this.#bit = bit;
    return v;
  }

  /** Like #read(), but for widths up to 53 bits (FLAC needs at most 33). */
  #readBig(n) {
    if (n <= 32) return this.#read(n);
    if (!this.#ensure(n)) {
      this.#uflow = true;
      return 0;
    }
    const hi = this.#read(n - 32);
    const lo = this.#read(32);
    return hi * 4294967296 + lo;
  }

  /** Sign extension of an unsigned n-bit value (1 <= n <= 33). */
  #sext(v, n) {
    const half = POW2[n - 1];
    return v >= half ? v - half - half : v;
  }

  /* ── input buffer management ─────────────────────────────────────────── */

  #append(u8) {
    const n = u8.length;
    if (n === 0) return;
    if (this.#len + n > this.#buf.length) {
      // Free consumed bytes first; grow only if that is not enough.
      const inFrame = this.#state >= S_FRAME_MIN && this.#state <= S_FRAME_MAX;
      this.#compact(inFrame ? this.#frameStart : this.#pos);
      if (this.#len + n > this.#buf.length) {
        let cap = this.#buf.length * 2;
        if (cap < this.#len + n) cap = this.#len + n;
        if (cap < 1 << 12) cap = 1 << 12;
        const nb = new Uint8Array(cap);
        nb.set(this.#buf.subarray(0, this.#len));
        this.#buf = nb;
      }
    }
    this.#buf.set(u8, this.#len);
    this.#len += n;
  }

  /** Drops all bytes before `keep` (must be byte aligned and <= #pos). */
  #compact(keep) {
    if (keep <= 0) return;
    const rem = this.#len - keep;
    if (rem > 0) this.#buf.copyWithin(0, keep, this.#len);
    this.#len = rem;
    this.#pos -= keep;
    this.#frameStart = this.#frameStart >= keep ? this.#frameStart - keep : 0;
    this.#subPos = this.#subPos >= keep ? this.#subPos - keep : 0;
  }

  /* ── stream level states ─────────────────────────────────────────────── */

  #sInit() {
    const buf = this.#buf;
    const len = this.#len;
    let pos = this.#pos;

    // Optionally skip an ID3v2 tag in front of the FLAC stream.
    if (!this.#id3Checked) {
      if (len < 10) return false;
      this.#id3Checked = true;
      if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf[3] <= 4) {
        const size =
          ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
          ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        this.#id3Rem = 10 + size + (buf[5] & 0x10 ? 10 : 0);
      }
    }
    if (this.#id3Rem > 0) {
      const can = Math.min(this.#id3Rem, len - pos);
      pos += can;
      this.#id3Rem -= can;
      this.#pos = pos;
      if (this.#id3Rem > 0) return false;
    }

    // Search for the "fLaC" marker.
    let i = pos;
    while (i + 4 <= len) {
      if (buf[i] === 0x66 && buf[i + 1] === 0x4c && buf[i + 2] === 0x61 && buf[i + 3] === 0x43) {
        this.#pos = i + 4;
        this.#state = S_METADATA;
        return true;
      }
      i++;
    }
    this.#pos = i; // keep the last 3 bytes: a marker may straddle chunks
    return false;
  }

  #sMetadata() {
    const buf = this.#buf;
    const pos = this.#pos;
    if (this.#len - pos < 4) return false;
    const isLast = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    if (type === 127) {
      return this.#fail('BAD_METADATA', 'invalid metadata block type 127');
    }
    this.#pos = pos + 4;
    this.#metaIsLast = isLast;
    if (type === 0) {
      if (size !== 34) {
        return this.#fail('BAD_METADATA', 'STREAMINFO block must be 34 bytes, got ' + size);
      }
      this.#state = S_STREAMINFO;
    } else {
      this.#metaSkipRem = size;
      this.#state = S_SKIP;
    }
    return true;
  }

  #sStreaminfo() {
    if (this.#len - this.#pos < 34) return false;
    const minBlockSize = this.#read(16);
    const maxBlockSize = this.#read(16);
    const minFrameSize = this.#read(24);
    const maxFrameSize = this.#read(24);
    const hi = this.#read(32);
    const lo = this.#read(32);
    const md5 = this.#buf.slice(this.#pos, this.#pos + 16);
    this.#pos += 16;
    const sampleRate = hi >>> 12;
    const channels = ((hi >>> 9) & 7) + 1;
    const bitsPerSample = ((hi >>> 4) & 31) + 1;
    const totalSamples = (hi & 15) * 4294967296 + lo;
    if (sampleRate === 0) {
      return this.#fail('BAD_METADATA', 'STREAMINFO sample rate is zero');
    }
    this.#si = {
      minBlockSize,
      maxBlockSize,
      minFrameSize,
      maxFrameSize,
      sampleRate,
      channels,
      bitsPerSample,
      totalSamples: totalSamples === 0 ? null : totalSamples,
      md5,
    };
    this.#afterMetadata();
    return true;
  }

  #sSkip() {
    const can = Math.min(this.#metaSkipRem, this.#len - this.#pos);
    this.#pos += can;
    this.#metaSkipRem -= can;
    if (this.#metaSkipRem > 0) return false;
    this.#afterMetadata();
    return true;
  }

  #afterMetadata() {
    if (this.#metaIsLast) {
      if (this.#si) this.#state = S_SYNC;
      else this.#fail('NO_STREAMINFO', 'the STREAMINFO metadata block is missing');
    } else {
      this.#state = S_METADATA;
    }
  }

  /* ── frame level states ──────────────────────────────────────────────── */

  #sSync() {
    const buf = this.#buf;
    const len = this.#len;
    let pos = this.#pos;
    // The frame sync code is 0b11111111111110 followed by a reserved 0 bit
    // and the blocking strategy bit, i.e. the bytes 0xFF 0xF8/0xF9.
    while (pos + 1 < len) {
      if (buf[pos] === 0xff && (buf[pos + 1] & 0xfe) === 0xf8) {
        this.#frameStart = pos;
        this.#pos = pos + 2;
        this.#bit = 0;
        this.#chan = 0;
        this.#blockingVar = (buf[pos + 1] & 1) !== 0;
        this.#state = S_FRAME_HEADER;
        return true;
      }
      pos++;
    }
    this.#pos = pos; // with a trailing 0xFF we must wait for the next byte
    return false;
  }

  #sFrameHeader() {
    // On underflow the whole (small) header is restarted from the frame
    // start; reads never partially consume, so this is always safe.
    const restart = () => {
      this.#pos = this.#frameStart + 2;
      this.#bit = 0;
    };

    // Block size / sample rate / channel assignment / sample size codes.
    const v = this.#read(16);
    if (this.#uflow) {
      restart();
      return false;
    }
    const bsCode = v >>> 12;
    const srCode = (v >>> 8) & 15;
    const channelMode = (v >>> 4) & 15;
    const bpsCode = (v >>> 1) & 7;
    if ((v & 1) !== 0 || channelMode > 10 || srCode === 15 || bsCode === 0) {
      return this.#badFrame();
    }

    // Frame/sample number, coded like UTF-8 (up to 7 bytes).
    const b0 = this.#read(8);
    if (this.#uflow) {
      restart();
      return false;
    }
    let number = 0;
    let rem = 0;
    if (b0 < 0x80) {
      number = b0;
    } else {
      let ones = 0;
      let m = b0;
      while (m & 0x80) {
        m = (m << 1) & 0xff;
        ones++;
      }
      const maxBytes = this.#blockingVar ? 7 : 6;
      if (ones === 1 || ones > maxBytes) return this.#badFrame();
      number = b0 & ((1 << (7 - ones)) - 1);
      rem = ones - 1;
    }
    while (rem > 0) {
      const b = this.#read(8);
      if (this.#uflow) {
        restart();
        return false;
      }
      if ((b & 0xc0) !== 0x80) return this.#badFrame();
      number = number * 64 + (b & 0x3f);
      rem--;
    }

    // Optional block size / sample rate fields at the end of the header.
    let blockSize;
    if (bsCode === 6) {
      const x = this.#read(8);
      if (this.#uflow) {
        restart();
        return false;
      }
      blockSize = x + 1;
    } else if (bsCode === 7) {
      const x = this.#read(16);
      if (this.#uflow) {
        restart();
        return false;
      }
      blockSize = x + 1;
    } else if (bsCode === 1) {
      blockSize = 192;
    } else if (bsCode <= 5) {
      blockSize = 576 << (bsCode - 2);
    } else {
      blockSize = 256 << (bsCode - 8);
    }
    if (srCode === 12) {
      const x = this.#read(8); // kHz — consumed for the CRC, value unused
      if (this.#uflow) {
        restart();
        return false;
      }
    } else if (srCode === 13 || srCode === 14) {
      const x = this.#read(16); // Hz / 0.1 Hz
      if (this.#uflow) {
        restart();
        return false;
      }
    }

    // CRC-8 over the whole header (header is always byte aligned here).
    if (this.#bit !== 0) return this.#badFrame();
    const hdrEnd = this.#pos;
    const crc8Stored = this.#read(8);
    if (this.#uflow) {
      restart();
      return false;
    }
    let crc8 = 0;
    for (let i = this.#frameStart; i < hdrEnd; i++) crc8 = CRC8[crc8 ^ this.#buf[i]];
    if (crc8 !== crc8Stored) return this.#badFrame();

    // Resolve channels / sample size and validate them.
    const channels = channelMode <= 7 ? channelMode + 1 : 2;
    let bps;
    if (bpsCode === 0) {
      bps = this.#si ? this.#si.bitsPerSample : 0;
      if (bps < 1) return this.#badFrame();
    } else if (bpsCode === 3) {
      return this.#badFrame();
    } else {
      bps = SAMPLE_SIZES[bpsCode];
    }

    this.#blockSize = blockSize;
    this.#channels = channels;
    this.#channelMode = channelMode;
    this.#bps = bps;
    this.#codedNumber = number;
    this.#ensureBuffers();
    this.#chan = 0;
    this.#subPos = this.#pos;
    this.#subBit = 0;
    this.#state = S_SUBFRAME_HEADER;
    return true;
  }

  /* ── subframe level states ───────────────────────────────────────────── */

  /** True if the current subframe carries the stereo difference signal. */
  #sideChannel() {
    const m = this.#channelMode;
    const c = this.#chan;
    return (m === 8 && c === 1) || (m === 9 && c === 0) || (m === 10 && c === 1);
  }

  #rewindSub() {
    this.#pos = this.#subPos;
    this.#bit = this.#subBit;
    return false;
  }

  #sSubframeHeader() {
    // The first 8 bits (padding + type + wasted-bits flag) are read
    // atomically; the optional wasted-bits unary number is re-read from the
    // subframe start on underflow.
    if (!this.#ensure(8)) return this.#rewindSub();
    const v = this.#read(8);
    if ((v & 0x80) !== 0) return this.#badFrame();
    const type = (v >>> 1) & 63;
    const hasWasted = (v & 1) !== 0;

    let order = 0;
    let isLpc = false;
    let kind; // 0 = CONSTANT, 1 = VERBATIM, 2 = FIXED/LPC
    if (type === 0) {
      kind = 0;
    } else if (type === 1) {
      kind = 1;
    } else if (type >= 8 && type <= 12) {
      kind = 2;
      order = type - 8;
    } else if (type >= 32) {
      kind = 2;
      order = type - 31; // (type - 32) + 1
      isLpc = true;
    } else {
      return this.#badFrame();
    }
    if (order > this.#blockSize) return this.#badFrame();

    let wasted = 0;
    if (hasWasted) {
      let z = 0;
      for (;;) {
        if (!this.#ensure(1)) return this.#rewindSub();
        if (this.#read(1) !== 0) break;
        if (++z > 32) return this.#badFrame();
      }
      wasted = z + 1;
    }

    const chBps = this.#bps + (this.#sideChannel() ? 1 : 0);
    const subBps = chBps - wasted;
    if (subBps < 1) return this.#badFrame();

    this.#order = order;
    this.#isLpc = isLpc;
    this.#wasted = wasted;
    this.#subBps = subBps;
    if (kind === 0) {
      this.#state = S_SUB_CONSTANT;
    } else if (kind === 1) {
      this.#idx = 0;
      this.#state = S_SUB_VERBATIM;
    } else {
      this.#idx = 0;
      this.#state = S_WARMUP;
    }
    return true;
  }

  #sSubConstant() {
    const v = this.#readBig(this.#subBps);
    if (this.#uflow) return false;
    const value = this.#sext(v, this.#subBps) * POW2[this.#wasted];
    const b = this.#chanBufs[this.#chan];
    b.fill(value, 0, this.#blockSize);
    return this.#nextChannel();
  }

  #sSubVerbatim() {
    const b = this.#chanBufs[this.#chan];
    const subBps = this.#subBps;
    const mul = POW2[this.#wasted];
    const n = this.#blockSize;
    let i = this.#idx;
    while (i < n) {
      const v = this.#readBig(subBps);
      if (this.#uflow) {
        this.#idx = i;
        return false;
      }
      b[i] = this.#sext(v, subBps) * mul;
      i++;
    }
    return this.#nextChannel();
  }

  #sWarmup() {
    const b = this.#chanBufs[this.#chan];
    const subBps = this.#subBps;
    const n = this.#order;
    let i = this.#idx;
    while (i < n) {
      const v = this.#readBig(subBps);
      if (this.#uflow) {
        this.#idx = i;
        return false;
      }
      b[i] = this.#sext(v, subBps);
      i++;
    }
    this.#state = this.#isLpc ? S_LPC_HEADER : S_RESIDUAL_HEADER;
    return true;
  }

  #sLpcHeader() {
    if (!this.#ensure(9)) return false;
    const precRaw = this.#read(4);
    const shiftRaw = this.#read(5);
    if (precRaw === 15) return this.#badFrame();
    const shift = this.#sext(shiftRaw, 5);
    if (shift < 0) return this.#badFrame();
    this.#lpcPrec = precRaw + 1;
    this.#lpcShift = shift;
    this.#coefIdx = 0;
    this.#state = S_LPC_COEFFS;
    return true;
  }

  #sLpcCoeffs() {
    const coef = this.#coef;
    const prec = this.#lpcPrec;
    const n = this.#order;
    let i = this.#coefIdx;
    while (i < n) {
      const v = this.#read(prec);
      if (this.#uflow) {
        this.#coefIdx = i;
        return false;
      }
      coef[i] = this.#sext(v, prec);
      i++;
    }
    this.#state = S_RESIDUAL_HEADER;
    return true;
  }

  #sResidualHeader() {
    if (!this.#ensure(6)) return false;
    const method = this.#read(2);
    if (method > 1) return this.#badFrame();
    this.#riceBits = method === 0 ? 4 : 5;
    const partOrder = this.#read(4);
    const ps = this.#blockSize >>> partOrder;
    if ((this.#blockSize & ((1 << partOrder) - 1)) !== 0 || ps < this.#order) {
      return this.#badFrame();
    }
    this.#partOrder = partOrder;
    this.#partSamples = ps;
    this.#partIdx = 0;
    this.#state = S_RESIDUAL_PARTITION;
    return true;
  }

  #sResidualPartition() {
    // Rice parameter plus an optional 5-bit escape width, read atomically.
    if (!this.#ensure(this.#riceBits + 5)) return false;
    const param = this.#read(this.#riceBits);
    let rawBits = -1;
    if (param === (1 << this.#riceBits) - 1) {
      rawBits = this.#read(5);
    }
    this.#riceParam = param;
    this.#rawBits = rawBits;
    // Partition 0 skips the predictor warm-up samples.
    const start = this.#partIdx === 0 ? this.#order : this.#partIdx * this.#partSamples;
    this.#partEnd = (this.#partIdx + 1) * this.#partSamples;
    this.#idx = start;
    this.#riceZ = 0;
    this.#ricePhase = 0;
    this.#state = S_RESIDUAL_SAMPLES;
    return true;
  }

  /**
   * The hot loop: reads residual samples (Rice-coded or raw), applies the
   * fixed/LPC predictor and stores the reconstructed samples. Fully
   * resumable on a per-sample basis.
   */
  #sResidualSamples() {
    const b = this.#chanBufs[this.#chan];
    const buf = this.#buf;
    const len = this.#len;
    let pos = this.#pos;
    let bit = this.#bit;
    let i = this.#idx;
    const end = this.#partEnd;
    const order = this.#order;
    const isLpc = this.#isLpc;
    const coef = this.#coef;
    const shift = this.#lpcShift;
    const rawBits = this.#rawBits;

    const predict = () => {
      if (isLpc) {
        let s = 0;
        for (let j = 0; j < order; j++) s += coef[j] * b[i - 1 - j];
        // Arithmetic (floor) shift; exact for |s| < 2^53 in IEEE-754.
        return shift !== 0 ? Math.floor(s / POW2[shift]) : s;
      }
      return order === 0 ? 0 : fixedPredict(b, i, order);
    };

    if (rawBits >= 0) {
      // "Escaped" partition: raw two's complement residuals.
      while (i < end) {
        let r = 0;
        if (rawBits > 0) {
          if ((len - pos) * 8 - bit < rawBits) {
            this.#saveCursor(i, pos, bit, 0, 0);
            return false;
          }
          let v = 0;
          let n = rawBits;
          while (n > 0) {
            const avail = 8 - bit;
            const byt = buf[pos];
            if (n >= avail) {
              v = v * POW2[avail] + (byt & ((1 << avail) - 1));
              n -= avail;
              pos++;
              bit = 0;
            } else {
              v = v * POW2[n] + ((byt >>> (avail - n)) & ((1 << n) - 1));
              bit += n;
              n = 0;
            }
          }
          const half = POW2[rawBits - 1];
          r = v >= half ? v - half - half : v;
        }
        b[i] = r + predict();
        i++;
      }
    } else {
      // Rice-coded partition: unary quotient + param low bits, zigzag.
      const param = this.#riceParam;
      let riceZ = this.#riceZ;
      let phase = this.#ricePhase;
      while (i < end) {
        let r;
        if (phase === 0) {
          for (;;) {
            if (pos >= len) {
              this.#saveCursor(i, pos, bit, riceZ, 0);
              return false;
            }
            const byt = buf[pos];
            const w = 8 - bit;
            const rem = byt & ((1 << w) - 1);
            if (rem === 0) {
              riceZ += w;
              pos++;
              bit = 0;
              continue;
            }
            const p = 31 - Math.clz32(rem); // highest set bit of rem
            riceZ += w - 1 - p; // leading zeros within rem
            const nb = 8 - p; // position after the terminating 1 bit
            if (nb === 8) {
              pos++;
              bit = 0;
            } else {
              bit = nb;
            }
            break;
          }
          phase = 1;
        }
        let lo = 0;
        if (param > 0) {
          if ((len - pos) * 8 - bit < param) {
            this.#saveCursor(i, pos, bit, riceZ, 1);
            return false;
          }
          let n = param;
          while (n > 0) {
            const avail = 8 - bit;
            const byt = buf[pos];
            if (n >= avail) {
              lo = lo * POW2[avail] + (byt & ((1 << avail) - 1));
              n -= avail;
              pos++;
              bit = 0;
            } else {
              lo = lo * POW2[n] + ((byt >>> (avail - n)) & ((1 << n) - 1));
              bit += n;
              n = 0;
            }
          }
        }
        const z = riceZ * POW2[param] + lo;
        r = (z & 1) === 0 ? z / 2 : -((z + 1) / 2);
        riceZ = 0;
        phase = 0;
        b[i] = r + predict();
        i++;
      }
    }

    this.#pos = pos;
    this.#bit = bit;
    this.#idx = i;
    this.#partIdx++;
    if (this.#partIdx === 1 << this.#partOrder) {
      // Subframe complete: apply the wasted-bits left shift.
      if (this.#wasted !== 0) {
        const mul = POW2[this.#wasted];
        for (let k = 0; k < this.#blockSize; k++) b[k] *= mul;
      }
      return this.#nextChannel();
    }
    this.#state = S_RESIDUAL_PARTITION;
    return true;
  }

  #saveCursor(i, pos, bit, riceZ, phase) {
    this.#idx = i;
    this.#pos = pos;
    this.#bit = bit;
    this.#riceZ = riceZ;
    this.#ricePhase = phase;
  }

  #nextChannel() {
    this.#chan++;
    if (this.#chan < this.#channels) {
      this.#subPos = this.#pos;
      this.#subBit = this.#bit;
      this.#state = S_SUBFRAME_HEADER;
      return true;
    }
    this.#state = S_DECORRELATE;
    return true;
  }

  /* ── frame output ────────────────────────────────────────────────────── */

  #sDecorrelate() {
    const n = this.#blockSize;
    const mode = this.#channelMode;
    if (n > 0 && mode >= 8) {
      const a = this.#chanBufs[0];
      const s = this.#chanBufs[1];
      if (mode === 8) {
        // left/side: right = left - side
        for (let i = 0; i < n; i++) s[i] = a[i] - s[i];
      } else if (mode === 9) {
        // right/side: left = side + right
        for (let i = 0; i < n; i++) a[i] = a[i] + s[i];
      } else {
        // mid/side: left = mid + floor((side + 1) / 2), right = left - side
        for (let i = 0; i < n; i++) {
          const side = s[i];
          const left = a[i] + Math.floor((side + 1) / 2);
          a[i] = left;
          s[i] = left - side;
        }
      }
    }
    // Interleave the channels into the output buffer.
    const out = this.#frameOut;
    const cc = this.#channels;
    const ch = this.#chanBufs;
    let k = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < cc; c++) out[k++] = ch[c][i];
    }
    this.#state = S_FOOTER;
    return true;
  }

  #sFooter() {
    // Byte-align: the padding bits are covered by the CRC-16, so their
    // (byte) value must be available before the checksum can be computed.
    if (this.#bit !== 0) {
      if (this.#pos >= this.#len) return false;
      this.#pos++;
      this.#bit = 0;
    }
    if (this.#len - this.#pos < 2) return false;
    const buf = this.#buf;
    let crc = 0;
    for (let i = this.#frameStart; i < this.#pos; i++) {
      crc = CRC16[(crc >>> 8) ^ buf[i]] ^ ((crc << 8) & 0xffff);
    }
    const stored = (buf[this.#pos] << 8) | buf[this.#pos + 1];
    if (stored !== crc) return this.#badFrame();

    this.#pos += 2;
    this.#frames++;
    this.#emitBlock();
    this.#frameStart = this.#pos;
    if (this.#pos > 1 << 16) this.#compact(this.#pos); // keep memory bounded
    this.#state = S_SYNC;
    return true;
  }

  #ensureBuffers() {
    const need = this.#blockSize;
    const cc = this.#channels;
    if (this.#chanCap < need) this.#chanCap = need;
    for (let c = 0; c < cc; c++) {
      const b = this.#chanBufs[c];
      if (!b || b.length < this.#chanCap) {
        this.#chanBufs[c] = new Float64Array(this.#chanCap);
      }
    }
    const n = need * cc;
    if (!this.#frameOut || this.#frameOut.length < n) {
      this.#frameOut = new Int32Array(n);
    }
  }

  #emitBlock() {
    const cc = this.#channels;
    const n = this.#blockSize * cc;
    const si = this.#si;
    const block = {
      samples: this.#frameOut.slice(0, n),
      sampleRate: si ? si.sampleRate : 0,
      channels: cc,
      bitsPerSample: this.#bps,
      blockSize: this.#blockSize,
      frameNumber: this.#blockingVar ? null : this.#codedNumber,
      sampleNumber: this.#blockingVar ? this.#codedNumber : null,
    };
    if (this.#onBlock) this.#onBlock(block);
    else this.#blocks.push(block);
  }
}

/* Frame-header sample size codes 1..7 (0 means "take from STREAMINFO"). */
const SAMPLE_SIZES = [0, 8, 12, 0, 16, 20, 24, 32];

/* ═══════════════════════════════════════════════════════════════════════════
 * Convenience functions
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Decodes a complete FLAC stream in one call.
 *
 * @param {Uint8Array|ArrayBuffer} data
 * @returns object with `ok`, `error`, stream metadata, `samples`
 *          (Int32Array, interleaved, native range), `frames`, `framesLost`
 *          and `duration` (seconds, or null when unknown).
 */
function decodeFlac(data) {
  return new FlacDecoder().decode(data);
}

/**
 * Packs decoded PCM into a RIFF/WAVE file (returned as an ArrayBuffer).
 * Accepts anything with `sampleRate`, `channels`, `bitsPerSample` and
 * `samples` — e.g. a `decodeFlac()` result or a single decoder block.
 * Bit depths that WAVE cannot represent exactly (12, 20) are left-shifted
 * into the next supported depth (16, 24).
 */
function toWav(decoded) {
  const { sampleRate, channels, bitsPerSample, samples } = decoded;
  if (!sampleRate || !channels || !bitsPerSample || !samples) {
    throw new TypeError('toWav(): missing sampleRate/channels/bitsPerSample/samples');
  }
  // WAVE only supports whole-byte sample sizes: 12-bit input is up-shifted
  // to 16 bits, 20-bit to 24 bits. 8-bit WAVE is unsigned, everything else
  // is signed two's complement, little endian.
  const bits = bitsPerSample <= 8 ? 8 : bitsPerSample <= 16 ? 16 : bitsPerSample <= 24 ? 24 : 32;
  const shift = bits - bitsPerSample;
  const wide = bits >> 3;
  const n = samples.length;
  const dataLen = n * wide;
  // More than two channels requires the WAVE_FORMAT_EXTENSIBLE header.
  const ext = channels > 2;
  const fmtSize = ext ? 40 : 16;
  const dataOff = 12 + 8 + fmtSize + 8;
  const buf = new ArrayBuffer(dataOff + dataLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, dataOff + dataLen - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, fmtSize, true);
  dv.setUint16(20, ext ? 0xfffe : 1, true); // WAVE_FORMAT_EXTENSIBLE / PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * wide, true);
  dv.setUint16(32, channels * wide, true);
  dv.setUint16(34, bits, true);
  if (ext) {
    const masks = { 3: 0x7, 4: 0x33, 5: 0x37, 6: 0x3f, 7: 0x13f, 8: 0x63f };
    dv.setUint16(36, 22, true); // cbSize
    dv.setUint16(38, bits, true); // valid bits per sample
    dv.setUint32(40, masks[channels] ?? 0, true); // channel mask
    // PCM sub-format GUID (little endian)
    u8.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00,
      0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 44);
  }
  ascii(dataOff - 8, 'data');
  dv.setUint32(dataOff - 4, dataLen, true);
  for (let i = 0; i < n; i++) {
    let v = samples[i];
    if (shift > 0) v *= POW2[shift];
    const off = dataOff + i * wide;
    if (bits === 8) {
      u8[off] = v + 128; // 8-bit WAVE is unsigned
    } else {
      u8[off] = v & 0xff;
      u8[off + 1] = (v >> 8) & 0xff;
      if (bits > 16) u8[off + 2] = (v >> 16) & 0xff;
      if (bits > 24) u8[off + 3] = v >> 24;
    }
  }
  return buf;
}

if (typeof self !== "undefined") { self.FlacDecoder = FlacDecoder; self.decodeFlac = decodeFlac; self.toWav = toWav; } if (typeof module !== "undefined" && module.exports) { module.exports = { FlacDecoder, decodeFlac, toWav }; }