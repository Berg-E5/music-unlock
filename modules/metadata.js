/* ==========================================================================
   metadata.js — 写入 ID3v2.3 标签 / FLAC Vorbis Comment
   把元数据(标题、艺术家、专辑、封面、歌词)写回解密后的音频
   ========================================================================== */

(function (global) {
  'use strict';

  const CU = global.CU;
  const { Buffer } = CU;

  // ---------- ID3v2.3 frame encoding -----------------------------------------
  // Frame ID list (we support a useful subset):
  const TEXT_FRAMES = {
    title:       'TIT2',
    artist:      'TPE1',
    album:       'TALB',
    albumArtist: 'TPE2',
    year:        'TYER',
    genre:       'TCON',
    comment:     'COMM',
    lyrics:      'USLT',
    track:       'TRCK',
  };

  function encodeSyncSafeInt(n) {
    // ID3v2.3 size uses 28-bit sync-safe integer (4 × 7 bits)
    return new Uint8Array([
      (n >> 21) & 0x7f,
      (n >> 14) & 0x7f,
      (n >> 7)  & 0x7f,
      n & 0x7f,
    ]);
  }

  function makeTextFrame(id, text, encoding = 0x03 /* UTF-8 */) {
    const textBytes = Buffer.fromUtf8(text);
    const body = new Uint8Array(1 + textBytes.length + (encoding === 0x01 ? 2 : 1));
    body[0] = encoding;
    if (encoding === 0x01) {
      // UTF-16 with BOM
      body[1] = 0xFF; body[2] = 0xFE;
      body.set(textBytes, 3);
    } else {
      body.set(textBytes, 1);
    }
    const size = encodeSyncSafeInt(body.length);
    const frame = new Uint8Array(10 + body.length);
    frame[0] = id.charCodeAt(0);
    frame[1] = id.charCodeAt(1);
    frame[2] = id.charCodeAt(2);
    frame[3] = id.charCodeAt(3);
    frame.set(size, 4);
    // flags: 0
    frame[8] = 0; frame[9] = 0;
    frame.set(body, 10);
    return frame;
  }

  function makePictureFrame(pic) {
    // APIC frame: encoding(1) + mime(null-term) + picType(1) + desc(null-term) + data
    const mime = Buffer.fromLatin1(pic.mime || 'image/jpeg');
    const desc = Buffer.fromUtf8('');
    const body = new Uint8Array(1 + mime.length + 1 + 1 + desc.length + 1 + pic.data.length);
    let off = 0;
    body[off++] = 0x03; // UTF-8 encoding
    body.set(mime, off); off += mime.length;
    body[off++] = 0x00; // null term mime
    body[off++] = 0x03; // picture type: front cover
    body.set(desc, off); off += desc.length;
    body[off++] = 0x00; // null term desc
    body.set(pic.data, off);

    const size = encodeSyncSafeInt(body.length);
    const frame = new Uint8Array(10 + body.length);
    frame[0] = 0x41; // A
    frame[1] = 0x50; // P
    frame[2] = 0x49; // I
    frame[3] = 0x43; // C
    frame.set(size, 4);
    frame.set(body, 10);
    return frame;
  }

  function makeUSLTFrame(text) {
    // USLT: encoding(1) + lang(3) + descriptor(null-term) + lyrics
    const textBytes = Buffer.fromUtf8(text);
    const body = new Uint8Array(1 + 3 + 1 + textBytes.length);
    body[0] = 0x03;
    body[1] = 0x65; body[2] = 0x6E; body[3] = 0x67; // "eng"
    body[4] = 0x00;
    body.set(textBytes, 5);
    const size = encodeSyncSafeInt(body.length);
    const frame = new Uint8Array(10 + body.length);
    frame[0] = 0x55; // U
    frame[1] = 0x53; // S
    frame[2] = 0x4C; // L
    frame[3] = 0x54; // T
    frame.set(size, 4);
    frame.set(body, 10);
    return frame;
  }

  /**
   * Build an ID3v2.3 tag.
   * @param {object} meta
   * @param {Uint8Array|null} cover
   */
  function buildID3v23(meta, cover) {
    const frames = [];

    if (meta.musicName || meta.title)
      frames.push(makeTextFrame(TEXT_FRAMES.title, meta.musicName || meta.title || ''));
    if (meta.artist)
      frames.push(makeTextFrame(TEXT_FRAMES.artist, Array.isArray(meta.artist) ? meta.artist.join(', ') : meta.artist));
    if (meta.album)
      frames.push(makeTextFrame(TEXT_FRAMES.album, meta.album));
    if (meta.albumArtist)
      frames.push(makeTextFrame(TEXT_FRAMES.albumArtist, meta.albumArtist));
    if (meta.albumPic || cover) {
      const pic = {
        mime: 'image/jpeg',
        data: cover || (meta.albumPic ? dataUrlToBytes(meta.albumPic) : null),
      };
      if (pic.data) frames.push(makePictureFrame(pic));
    }
    if (meta.lyric) {
      // Lyrics in NCM are LRC-like — strip timestamps for plain text version
      const plain = String(meta.lyric).replace(/\[\d+:\d+\.\d+\]/g, '').trim();
      if (plain) frames.push(makeUSLTFrame(plain));
    }

    if (frames.length === 0) return new Uint8Array(0);

    const body = Buffer.concat(frames);
    const tagSize = encodeSyncSafeInt(body.length);

    // Header: "ID3" + version(2) + flags(1) + size(4)
    const header = new Uint8Array(10);
    header[0] = 0x49; // I
    header[1] = 0x44; // D
    header[2] = 0x33; // 3
    header[3] = 0x03; // version 2.3.0
    header[4] = 0x00; // flags
    header.set(tagSize, 6);  // size field at offset 6, NOT 5

    return Buffer.concat([header, body]);
  }

  function dataUrlToBytes(url) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    const bin = atob(m[2]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- Strip existing ID3v2 from audio --------------------------------
  function stripID3(audio) {
    if (audio.length >= 10 &&
        audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
      const tagSize =
        ((audio[6] & 0x7f) << 21) |
        ((audio[7] & 0x7f) << 14) |
        ((audio[8] & 0x7f) << 7)  |
        (audio[9] & 0x7f);
      const total = tagSize + 10;
      if (total < audio.length) return audio.slice(total);
    }
    return audio;
  }

  // ---------- Public API -----------------------------------------------------
  /**
   * Inject ID3v2 tag into MP3 audio.
   */
  function embedMp3(audio, meta, cover) {
    if (!meta && !cover) return audio;
    const tag = buildID3v23(meta || {}, cover || (meta && meta.albumPic ? null : null));
    if (tag.length === 0) return audio;
    // Strip existing tag to avoid duplicates
    const stripped = stripID3(audio);
    return Buffer.concat([tag, stripped]);
  }

  /**
   * Inject Vorbis Comment block into FLAC.
   * (Simplified: append a VORBIS_COMMENT block before the audio frames.
   *  FLAC structure: "fLaC" + [metadata blocks] + audio frames)
   */
  function embedFlac(audio, meta, cover) {
    // For simplicity: if no existing metadata, prepend ours.
    // Real-world: parse existing blocks to avoid duplication.
    if (!meta && !cover) return audio;
    if (audio.length < 4) return audio;

    const isFlac = audio[0] === 0x66 && audio[1] === 0x4C && audio[2] === 0x61 && audio[3] === 0x43;
    if (!isFlac) return audio;

    const vc = buildVorbisComment(meta || {});
    const pic = cover ? buildFlacPicture(cover) : null;

    const blocks = [];
    if (vc) blocks.push(vc);
    if (pic) blocks.push(pic);

    if (blocks.length === 0) return audio;

    // Insert after "fLaC" magic (4 bytes), before other blocks
    const rest = audio.slice(4);
    return Buffer.concat([
      audio.slice(0, 4),
      ...blocks,
      rest,
    ]);
  }

  function buildVorbisComment(meta) {
    const fields = [];
    if (meta.musicName || meta.title) fields.push(['TITLE', meta.musicName || meta.title]);
    if (meta.artist) fields.push(['ARTIST', Array.isArray(meta.artist) ? meta.artist.join(', ') : meta.artist]);
    if (meta.album) fields.push(['ALBUM', meta.album]);
    if (meta.albumArtist) fields.push(['ALBUMARTIST', meta.albumArtist]);
    if (meta.year) fields.push(['DATE', meta.year]);

    if (fields.length === 0) return null;

    // Vendor string + fields
    const vendor = 'Music Unlock';
    let body = '';
    body += u32le(vendor.length) + vendor;
    body += u32le(fields.length);
    for (const [k, v] of fields) {
      const s = k + '=' + v;
      body += u32le(s.length) + s;
    }

    const bodyBytes = Buffer.fromUtf8(body);
    const blockHeader = new Uint8Array(4);
    blockHeader[0] = 0x04; // type = VORBIS_COMMENT
    const size = bodyBytes.length;
    blockHeader[1] = (size >> 16) & 0xff;
    blockHeader[2] = (size >> 8) & 0xff;
    blockHeader[3] = size & 0xff;

    return Buffer.concat([blockHeader, bodyBytes]);
  }

  function buildFlacPicture(cover) {
    const body = new Uint8Array(4 + 4 + 4 + 4 + 4 + cover.length);
    let off = 0;
    body[off++] = 0x03; // picture type: front cover
    u32leBytes(cover.length, body, off); off += 4;
    const mime = 'image/jpeg';
    u32leBytes(mime.length, body, off); off += 4;
    body.set(Buffer.fromLatin1(mime), off); off += mime.length;
    u32leBytes(0, body, off); off += 4; // description length
    u32leBytes(0, body, off); off += 4; // width
    u32leBytes(0, body, off); off += 4; // height
    u32leBytes(0, body, off); off += 4; // depth
    u32leBytes(0, body, off); off += 4; // colors
    body.set(cover, off);

    const blockHeader = new Uint8Array(4);
    blockHeader[0] = 0x06; // type = PICTURE
    const size = body.length;
    blockHeader[1] = (size >> 16) & 0xff;
    blockHeader[2] = (size >> 8) & 0xff;
    blockHeader[3] = size & 0xff;

    return Buffer.concat([blockHeader, body]);
  }

  function u32le(n) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, n, true);
    return Buffer.toLatin1(buf);
  }
  function u32leBytes(n, dest, off) {
    dest[off]   = n & 0xff;
    dest[off+1] = (n >> 8) & 0xff;
    dest[off+2] = (n >> 16) & 0xff;
    dest[off+3] = (n >> 24) & 0xff;
  }

  // ---------- OGG Vorbis Comment injection -----------------------------------
  // OGG 用流式页结构;元数据在 page #2 (Vorbis comment header).
  // 我们找到该页,替换其 body,然后重算 segment_table + CRC32.

  const OGG_CRC_TABLE = new Uint32Array(256);
  (function initOggCrc() {
    for (let n = 0; n < 256; n++) {
      let c = n << 24;
      for (let k = 0; k < 8; k++) {
        c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1);
      }
      OGG_CRC_TABLE[n] = c >>> 0;
    }
  })();
  function oggCrc(buf, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
      crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
    }
    return crc;
  }

  // Read uint32 LE
  function readU32le(buf, off) {
    return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24)) >>> 0;
  }
  function writeU32le(n) {
    const b = new Uint8Array(4);
    b[0] = n & 0xff;
    b[1] = (n >> 8) & 0xff;
    b[2] = (n >> 16) & 0xff;
    b[3] = (n >>> 24) & 0xff;
    return b;
  }

  // Build a fresh OGG page (with 1 packet = body)
  function buildOggPage({ flags, granulePos, serial, pageSeq, packet }) {
    // Build segment table: each segment ≤ 255 bytes
    const segments = [];
    let p = 0;
    while (p < packet.length) {
      const take = Math.min(255, packet.length - p);
      segments.push(take);
      p += take;
    }
    // If packet ends on 255 boundary, need a 0 lacing value to mark end
    if (packet.length > 0 && packet.length % 255 === 0) segments.push(0);
    // Empty packet case
    if (segments.length === 0) segments.push(0);

    const segCount = segments.length;
    const bodyLen = segments.reduce((a, b) => a + b, 0);
    const headerSize = 27 + segCount;
    const totalSize = headerSize + bodyLen;

    const page = new Uint8Array(totalSize);
    // Capture pattern
    page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53;
    // Stream version
    page[4] = 0x00;
    // Header type flag
    page[5] = flags;
    // Absolute granule position (8 bytes LE)
    let g = granulePos;
    for (let i = 0; i < 8; i++) { page[6 + i] = g & 0xff; g = Math.floor(g / 256); }
    // Stream serial number (4 bytes LE)
    page[14] = serial & 0xff;
    page[15] = (serial >>> 8) & 0xff;
    page[16] = (serial >>> 16) & 0xff;
    page[17] = (serial >>> 24) & 0xff;
    // Page sequence number (4 bytes LE)
    page[18] = pageSeq & 0xff;
    page[19] = (pageSeq >>> 8) & 0xff;
    page[20] = (pageSeq >>> 16) & 0xff;
    page[21] = (pageSeq >>> 24) & 0xff;
    // CRC placeholder (4 bytes, set to 0)
    page[22] = 0; page[23] = 0; page[24] = 0; page[25] = 0;
    // Number of segments
    page[26] = segCount;
    // Segment table
    for (let i = 0; i < segCount; i++) page[27 + i] = segments[i];
    // Body
    page.set(packet, headerSize);

    // Compute CRC
    const crc = oggCrc(page, 0, totalSize);
    page[22] = crc & 0xff;
    page[23] = (crc >>> 8) & 0xff;
    page[24] = (crc >>> 16) & 0xff;
    page[25] = (crc >>> 24) & 0xff;

    return page;
  }

  // Build a Vorbis Comment packet (the full packet, not split into segments)
  // Format: 0x03 "vorbis" + vendor_len(4 LE) + vendor + num_fields(4 LE) + fields
  function buildVorbisCommentPacket(meta, cover) {
    const fields = [];
    if (meta.musicName || meta.title)
      fields.push(['TITLE', meta.musicName || meta.title || '']);
    if (meta.artist) {
      const a = Array.isArray(meta.artist) ? meta.artist.join(', ') : String(meta.artist);
      fields.push(['ARTIST', a]);
    }
    if (meta.album) fields.push(['ALBUM', meta.album]);
    if (meta.albumArtist) fields.push(['ALBUMARTIST', meta.albumArtist]);
    if (meta.year) fields.push(['DATE', String(meta.year)]);

    const vendor = 'Music Unlock';

    // Compute body size
    let bodySize = 1 + 6 + 4 + vendor.length;  // 0x03 "vorbis" + vendor_len + vendor
    bodySize += 4; // num_fields
    const fieldBytes = [];
    for (const [k, v] of fields) {
      const s = k + '=' + v;
      const u = Buffer.fromUtf8(s);
      bodySize += 4 + u.length;
      fieldBytes.push(u);
    }

    const packet = new Uint8Array(bodySize);
    let off = 0;
    packet[off++] = 0x03;  // packet type
    // "vorbis" magic
    packet[off++] = 0x76; packet[off++] = 0x6F; packet[off++] = 0x72;
    packet[off++] = 0x62; packet[off++] = 0x69; packet[off++] = 0x73;
    // Vendor length + string
    const vlen = Buffer.fromUtf8(vendor);
    packet.set(writeU32le(vlen.length), off); off += 4;
    packet.set(vlen, off); off += vlen.length;
    // Number of fields
    packet.set(writeU32le(fields.length), off); off += 4;
    // Fields
    for (let i = 0; i < fields.length; i++) {
      packet.set(writeU32le(fieldBytes[i].length), off); off += 4;
      packet.set(fieldBytes[i], off); off += fieldBytes[i].length;
    }

    return packet;
  }

  /**
   * Replace page #2 (Vorbis comment header) in an OGG bitstream with a fresh
   * metadata block, recomputing CRC and segment table.
   *
   * Returns the new audio bytes, or the original if no metadata to write or
   * parsing fails.
   */
  function embedOgg(audio, meta, cover) {
    if (!meta && !cover) return audio;
    if (audio.length < 27) return audio;
    if (audio[0] !== 0x4F || audio[1] !== 0x67 || audio[2] !== 0x67 || audio[3] !== 0x53) {
      return audio;  // not OGG
    }

    // Walk pages to find page #2 (Vorbis comment header: starts with 0x03 "vorbis")
    const pages = [];
    let off = 0;
    while (off < audio.length) {
      if (off + 27 > audio.length) break;
      if (audio[off] !== 0x4F || audio[off+1] !== 0x67 || audio[off+2] !== 0x67 || audio[off+3] !== 0x53) {
        return audio;  // corrupt
      }
      const flags = audio[off + 5];
      const segCount = audio[off + 26];
      if (off + 27 + segCount > audio.length) return audio;
      // Sum body size
      let bodySize = 0;
      for (let i = 0; i < segCount; i++) bodySize += audio[off + 27 + i];
      const bodyStart = off + 27 + segCount;
      const totalSize = bodyStart - off + bodySize;
      pages.push({ offset: off, flags, segCount, bodyStart, bodySize, totalSize });
      off += totalSize;
    }

    if (pages.length < 3) {
      // Need at least: identification (page 0) + comment (page 1) + setup (page 2)
      // But page index in our array: page[0]=ident, page[1]=comment, page[2]=setup
      return audio;
    }

    // The comment page is page[1] (0-indexed). Its body starts with 0x03 "vorbis"
    const commentPage = pages[1];
    const body = audio.subarray(commentPage.bodyStart, commentPage.bodyStart + commentPage.bodySize);
    if (body[0] !== 0x03 || body[1] !== 0x76 || body[2] !== 0x6F || body[3] !== 0x72 ||
        body[4] !== 0x62 || body[5] !== 0x69 || body[6] !== 0x73) {
      return audio;  // not a Vorbis comment page
    }

    // Get serial + page_seq from original page for continuity
    const serial = readU32le(audio, commentPage.offset + 14);
    const pageSeq = readU32le(audio, commentPage.offset + 18);
    // granule pos of comment page is always 0 (per spec)
    const granulePos = 0;
    // Header flags: 0x02 (first page of logical stream? no - that's page 0)
    // Page 1 (comment) usually has flags = 0x00
    const flags = 0x00;

    // Build new comment packet
    const newPacket = buildVorbisCommentPacket(meta || {}, cover);

    // Build new page
    const newPage = buildOggPage({ flags, granulePos, serial, pageSeq, packet: newPacket });

    // Concatenate: [before comment page] + [new comment page] + [after comment page]
    const before = audio.subarray(0, commentPage.offset);
    const after = audio.subarray(commentPage.bodyStart + commentPage.bodySize);

    const result = new Uint8Array(before.length + newPage.length + after.length);
    result.set(before, 0);
    result.set(newPage, before.length);
    result.set(after, before.length + newPage.length);

    return result;
  }

  /**
   * Embed metadata based on audio extension.
   */
  function embed(audio, ext, meta, cover) {
    if (ext === 'mp3') return embedMp3(audio, meta, cover);
    if (ext === 'flac') return embedFlac(audio, meta, cover);
    if (ext === 'ogg') return embedOgg(audio, meta, cover);
    // For M4A — simple fallback, no metadata injection
    return audio;
  }

  global.Metadata = { embed, embedMp3, embedFlac, embedOgg };
})(typeof window !== 'undefined' ? window : globalThis);
