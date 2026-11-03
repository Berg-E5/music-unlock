/*
 * qq-ekey.js — QQ 音乐 ekey (V3/MusicEx 加密文件密钥) 获取
 *
 * 协议逆向自 QQ 音乐 PC 客户端 (QQMusic_Setup_2276.exe):
 *   - QQMusic_Protocol.dll 字符串表:
 *       music.vkey.GetEVkey / .CgiGetEVkey      → ekey 请求
 *       music.vkey.GetVkey  / .CgiGetTempVkey   → 普通 vkey 请求
 *       music.vkey.GetDownUrl/.CgiGetDownUrl    → 普通下载 url
 *       music.vkey.GetEDownUrl/.CgiGetEDownUrl  → 加密下载 url
 *       请求字段: songmid / filename / songtype / guid / uin / platform /
 *                 loginflag / ctx / musicfile / mediamid / downloadfrom /
 *                 nettype / checklimit / midurlinfo / tempVkey
 *       响应字段: midurlinfo[].ekey
 *   - 客户端用腾讯自研二进制协议 (QQMusicBinPacket), 但同一套 module/method
 *     在 JSON 信封 (musicu.fcg) 下同样可用 —— 已实测 code:0 正常返回。
 *
 * 三个必须踩准的坑:
 *   1. musicu.fcg 必须用 GET, JSON 放 query string。
 *      用 POST 发 data=... 会所有请求都返回 {"code":500001},
 *      看起来像登录态错, 其实不是。
 *   2. songtype 必须为 1。填 0 只返回 vkey, 不返回 ekey。
 *   3. filename 必须带加密扩展名 (.mgg / .mflac), 且是 footer 里
 *      那个原始 mediaFilename, 不能自己拼音质前缀。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QQEkey = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GATEWAY = 'https://u6.y.qq.com/cgi-bin/musicu.fcg';

  const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  // 构造 musicu.fcg 的 query string。
  // comm 是通用信封, req_1 是本次业务请求; key 名任意, 响应按同名返回。
  function buildQuery(params, options) {
    const opt = options || {};
    const comm = {
      ct: 24,
      cv: 4747474,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 1,
      uin: opt.uin || '0',
      g_tk: 5381,
      g_tk_new_20200303: 5381
    };
    // authst: PC 客户端登录票据, 拿加密资源 ekey 时需要
    if (opt.authst) comm.authst = opt.authst;
    // tmeLoginType: 3 = QQ 账号登录
    if (opt.tmeLoginType) comm.tmeLoginType = opt.tmeLoginType;

    const payload = {
      comm: comm,
      req_1: {
        module: opt.module || 'music.vkey.GetEVkey',
        method: opt.method || 'CgiGetEVkey',
        param: params
      }
    };

    const q = new URLSearchParams();
    q.set('g_tk', '5381');
    q.set('loginUin', opt.loginUin || opt.uin || '0');
    q.set('hostUin', '0');
    q.set('format', 'json');
    q.set('inCharset', 'utf8');
    q.set('outCharset', 'utf-8');
    q.set('notice', '0');
    q.set('platform', 'yqq.json');
    q.set('needNewCode', '0');
    q.set('data', JSON.stringify(payload));
    return q.toString();
  }

  // 从 musicu.fcg 响应里取 midurlinfo[0].ekey
  function extractEkey(resp) {
    const body = resp && resp.req_1 && resp.req_1.data;
    if (!body) {
      const err = new Error(
        '响应结构异常: ' + JSON.stringify(resp).slice(0, 200)
      );
      err.code = 'BAD_RESPONSE';
      throw err;
    }
    if (typeof body.retcode === 'number' && body.retcode !== 0) {
      const err = new Error(
        'QQ 音乐返回 retcode=' + body.retcode +
        (body.msg ? ' (' + String(body.msg).slice(0, 120) + ')' : '')
      );
      err.code = 'RETCODE';
      err.retcode = body.retcode;
      err.msg = body.msg;
      throw err;
    }
    const list = body.midurlinfo || [];
    if (!list.length) {
      const err = new Error(
        '响应里没有 midurlinfo —— 多半是文件名不对或该歌曲不是加密格式' +
        (body.msg ? ' (' + String(body.msg).slice(0, 120) + ')' : '')
      );
      err.code = 'NO_MIDURLINFO';
      throw err;
    }
    const info = list[0];
    const ekey = info.ekey || '';
    if (!ekey) {
      const err = new Error(
        '没拿到 ekey (result=' + (info.result !== undefined ? info.result : '?') +
        ')。可能是: 需要登录态 / 该音质不提供 ekey / 文件名与实际不符'
      );
      err.code = 'NO_EKEY';
      err.result = info.result;
      throw err;
    }
    return {
      ekey: ekey,
      vkey: info.vkey || '',
      filename: info.filename || '',
      songmid: info.songmid || info.mid || '',
      purl: info.purl || ''
    };
  }

  // 取 ekey。
  //   mid   —— 歌曲 mid (musicex footer 里的 mid / songId)
  //   filename —— musicex footer 里的 mediaFilename (如 004ZzMIRh1N8WaT.mgg)
  //   cookie —— 登录 cookie 字符串 (需要 qm_keyst / qqmusic_key 等)
  //   uin   —— QQ 号
  //   authst —— authst 票据 (部分场景必需)
  async function getEkey(opts, fetchImpl) {
    const o = opts || {};
    if (!o.mid) throw new Error('mid 必填');
    if (!o.filename) throw new Error('filename 必填');

    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('当前环境没有 fetch');

    const params = {
      filename: [o.filename],
      guid: o.guid || '10000',
      songmid: [o.mid],
      songtype: [1],          // 必须为 1, 否则只返回 vkey
      uin: o.uin || '0',
      loginflag: 1,
      platform: '20',
      ctx: 1
    };

    const headers = {
      'User-Agent': o.ua || DEFAULT_UA,
      'Referer': 'https://y.qq.com/',
      'Accept': 'application/json, text/plain, */*'
    };
    if (o.cookie) headers['Cookie'] = o.cookie;

    const url = GATEWAY + '?' + buildQuery(params, o);
    const resp = await doFetch(url, { method: 'GET', headers, credentials: 'omit' });
    if (!resp.ok) {
      const err = new Error('musicu.fcg HTTP ' + resp.status);
      err.code = 'HTTP_' + resp.status;
      throw err;
    }
    const json = await resp.json();
    return extractEkey(json);
  }

  // 从 musicex 文件尾部解析出取 ekey 需要的 mid / filename。
  // 布局与站点 modules/qmc.js 的 parseMusicExFooter 一致:
  //   [音频][payload_len u32 LE][version u32 LE]['musicex\0']
  //   payload 内部: [songId u32][mid utf16le cstr 60][mediaFilename utf16le cstr 100]
  const MUSICEX_MAGIC = [0x6d, 0x75, 0x73, 0x69, 0x63, 0x65, 0x78, 0x00];

  function readUtf16leCstr(bytes, offset, length) {
    const raw = bytes.subarray(offset, offset + length);
    let s = '';
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = raw[i] | (raw[i + 1] << 8);
      if (code === 0) break;
      s += String.fromCharCode(code);
    }
    return s;
  }

  function parseMusicExMeta(bytes) {
    if (!bytes || bytes.length < 32) return null;
    const n = bytes.length;
    for (let i = 0; i < 8; i++) {
      if (bytes[n - 8 + i] !== MUSICEX_MAGIC[i]) return null;
    }
    const payloadLen =
      (bytes[n - 16] | (bytes[n - 15] << 8) | (bytes[n - 14] << 16) | (bytes[n - 13] << 24)) >>> 0;
    const version =
      (bytes[n - 12] | (bytes[n - 11] << 8) | (bytes[n - 10] << 16) | (bytes[n - 9] << 24)) >>> 0;
    if (version !== 1) return null;
    if (payloadLen < 16 || payloadLen > n) return null;

    const footerStart = n - payloadLen;
    const innerLen = payloadLen - 16;
    if (innerLen < 12 + 60 + 100) return null;
    const inner = bytes.subarray(footerStart, footerStart + innerLen);

    const songId = (inner[0] | (inner[1] << 8) | (inner[2] << 16) | (inner[3] << 24)) >>> 0;
    const mid = readUtf16leCstr(inner, 12, 60);
    const mediaFilename = readUtf16leCstr(inner, 12 + 60, 100);
    if (!mid || !mediaFilename) return null;

    return { songId: songId, mid: mid, mediaFilename: mediaFilename, footerSize: payloadLen };
  }

  return {
    getEkey: getEkey,
    parseMusicExMeta: parseMusicExMeta,
    buildQuery: buildQuery,
    extractEkey: extractEkey,
    GATEWAY: GATEWAY
  };
});
