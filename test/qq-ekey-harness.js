#!/usr/bin/env node
/*
 * qq-ekey-harness.js — modules/qq-ekey.js 离线测试
 *
 *   1. parseMusicExMeta: 从真实 musicex 测试向量解析 mid / mediaFilename
 *   2. buildQuery: 请求信封结构检查 (GET 而非 POST, songtype=1, module/method 正确)
 *   3. extractEkey: 响应解析 (成功路径 + 各种错误路径)
 *
 * 全部离线, 不发网络请求。
 */

const fs = require('fs');
const path = require('path');

const MOD = path.join(__dirname, '..', 'modules');
const VEC = path.join(__dirname, 'xval-vectors');

const QQEkey = require(path.join(MOD, 'qq-ekey.js'));

let passed = 0, failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

// ─────────────────────────────────────────────────────────────
// 1. parseMusicExMeta
// ─────────────────────────────────────────────────────────────
section('1. parseMusicExMeta (真实 musicex 向量)');

const v3Path = path.join(VEC, 'v3-real-map.mgg');
if (fs.existsSync(v3Path)) {
  const buf = fs.readFileSync(v3Path);
  const meta = QQEkey.parseMusicExMeta(new Uint8Array(buf));

  check('能解析出 meta', meta !== null);
  if (meta) {
    check('mid 非空', typeof meta.mid === 'string' && meta.mid.length > 0, JSON.stringify(meta.mid));
    check('mediaFilename 非空', typeof meta.mediaFilename === 'string' && meta.mediaFilename.length > 0,
      JSON.stringify(meta.mediaFilename));
    check('mediaFilename 是加密扩展名',
      /\.(mgg|mflac|mmp4|qmc0|qmcflac|qmcogg)$/i.test(meta.mediaFilename), meta.mediaFilename);
    check('footerSize 合理 (>=16, <文件长)',
      meta.footerSize >= 16 && meta.footerSize < buf.length, String(meta.footerSize));

    // 与已知的正确值对照 (从站点 qmc.js parseMusicExFooter 得到)
    check('mid 与 oracle 一致 (0039MnYb0FzMPN)', meta.mid === '0039MnYb0FzMPN', meta.mid);
    check('mediaFilename 与 oracle 一致 (004ZzMIRh1N8WaT.mgg)',
      meta.mediaFilename === '004ZzMIRh1N8WaT.mgg', meta.mediaFilename);
  }
} else {
  console.log('  (跳过: 找不到 ' + v3Path + ')');
}

// 非 musicex 文件应返回 null
{
  const junk = new Uint8Array(64);
  junk.fill(0xAB);
  check('非 musicex 文件返回 null', QQEkey.parseMusicExMeta(junk) === null);
}

// ─────────────────────────────────────────────────────────────
// 2. buildQuery
// ─────────────────────────────────────────────────────────────
section('2. buildQuery (请求信封)');

{
  const q = QQEkey.buildQuery(
    { filename: ['004ZzMIRh1N8WaT.mgg'], guid: '10000', songmid: ['0039MnYb0FzMPN'],
      songtype: [1], uin: '0', loginflag: 1, platform: '20', ctx: 1 },
    { uin: '0' }
  );
  const parsed = new URLSearchParams(q);
  const data = JSON.parse(parsed.get('data'));

  check('query 含 data', parsed.has('data'));
  check('query 含 format=json', parsed.get('format') === 'json');
  check('query 含 platform=yqq.json', parsed.get('platform') === 'yqq.json');
  check('query 含 loginUin', parsed.has('loginUin'));
  check('query 含 needNewCode', parsed.has('needNewCode'));

  check('comm 存在', !!data.comm);
  check('comm.ct = 24', data.comm.ct === 24);
  check('comm.cv = 4747474', data.comm.cv === 4747474);
  check('comm.format = json', data.comm.format === 'json');

  check('req_1 存在', !!data.req_1);
  check('module = music.vkey.GetEVkey', data.req_1.module === 'music.vkey.GetEVkey', data.req_1.module);
  check('method = CgiGetEVkey', data.req_1.method === 'CgiGetEVkey', data.req_1.method);

  check('param.filename 是数组', Array.isArray(data.req_1.param.filename));
  check('param.songmid 是数组', Array.isArray(data.req_1.param.songmid));
  check('param.songtype = [1] (必须 1, 否则不返回 ekey)',
    Array.isArray(data.req_1.param.songtype) && data.req_1.param.songtype[0] === 1,
    JSON.stringify(data.req_1.param.songtype));
  check('param.platform = 20', data.req_1.param.platform === '20');
  check('param.loginflag = 1', data.req_1.param.loginflag === 1);
  check('param.ctx = 1', data.req_1.param.ctx === 1);
}

// authst / tmeLoginType 透传
{
  const q = QQEkey.buildQuery({ songmid: ['x'], filename: ['y.mgg'], songtype: [1] },
    { uin: '123', authst: 'AUTHST_TOKEN', tmeLoginType: 3 });
  const data = JSON.parse(new URLSearchParams(q).get('data'));
  check('authst 透传到 comm', data.comm.authst === 'AUTHST_TOKEN');
  check('tmeLoginType 透传到 comm', data.comm.tmeLoginType === 3);
  check('uin 透传到 comm', String(data.comm.uin) === '123');
}

// ─────────────────────────────────────────────────────────────
// 3. extractEkey
// ─────────────────────────────────────────────────────────────
section('3. extractEkey (响应解析)');

{
  // 成功路径
  const ok = {
    req_1: { data: {
      retcode: 0, msg: '',
      midurlinfo: [{
        ekey: 'BASE64_EKEY_VALUE', vkey: 'VKEY', filename: '004ZzMIRh1N8WaT.mgg',
        songmid: '0039MnYb0FzMPN', purl: '', result: 0
      }]
    } }
  };
  let got = null, threw = null;
  try { got = QQEkey.extractEkey(ok); } catch (e) { threw = e; }
  check('成功路径不抛异常', threw === null, threw && threw.message);
  if (got) {
    check('ekey 正确', got.ekey === 'BASE64_EKEY_VALUE');
    check('vkey 正确', got.vkey === 'VKEY');
    check('filename 正确', got.filename === '004ZzMIRh1N8WaT.mgg');
    check('songmid 正确', got.songmid === '0039MnYb0FzMPN');
  }
}

// retcode != 0
{
  let threw = null;
  try {
    QQEkey.extractEkey({ req_1: { data: { retcode: 2001, msg: 'login required' } } });
  } catch (e) { threw = e; }
  check('retcode!=0 抛异常', threw !== null);
  check('异常码 = RETCODE', threw && threw.code === 'RETCODE', threw && threw.code);
  check('异常信息含 retcode', threw && /retcode=2001/.test(threw.message), threw && threw.message);
}

// midurlinfo 为空
{
  let threw = null;
  try { QQEkey.extractEkey({ req_1: { data: { retcode: 0, midurlinfo: [] } } }); }
  catch (e) { threw = e; }
  check('midurlinfo 空 → 抛异常', threw !== null);
  check('异常码 = NO_MIDURLINFO', threw && threw.code === 'NO_MIDURLINFO', threw && threw.code);
}

// ekey 为空字符串 (服务器返回了但没给)
{
  let threw = null;
  try {
    QQEkey.extractEkey({ req_1: { data: { retcode: 0, midurlinfo: [{ ekey: '', result: 101404 }] } } });
  } catch (e) { threw = e; }
  check('ekey 为空 → 抛异常', threw !== null);
  check('异常码 = NO_EKEY', threw && threw.code === 'NO_EKEY', threw && threw.code);
  check('异常带 result', threw && threw.result === 101404, threw && String(threw.result));
}

// 响应结构完全不对
{
  let threw = null;
  try { QQEkey.extractEkey({ code: 500001 }); } catch (e) { threw = e; }
  check('响应无 req_1 → 抛异常', threw !== null);
  check('异常码 = BAD_RESPONSE', threw && threw.code === 'BAD_RESPONSE', threw && threw.code);
}

// ─────────────────────────────────────────────────────────────
// 4. getEkey 用 mock fetch 验证 GET 语义
// ─────────────────────────────────────────────────────────────
section('4. getEkey (mock fetch — 验证 GET 与参数)');

(async () => {
  let captured = null;
  const mockFetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        req_1: { data: { retcode: 0, midurlinfo: [{ ekey: 'EKEY_OK', vkey: 'V', filename: 'f.mgg' }] } }
      })
    };
  };

  let res = null, err = null;
  try {
    res = await QQEkey.getEkey(
      { mid: '0039MnYb0FzMPN', filename: '004ZzMIRh1N8WaT.mgg', cookie: 'qm_keyst=X', uin: '123' },
      mockFetch
    );
  } catch (e) { err = e; }

  check('getEkey 不抛异常', err === null, err && err.message);
  check('返回 ekey', res && res.ekey === 'EKEY_OK');

  check('用 GET 不是 POST', captured && captured.init.method === 'GET',
    captured && captured.init.method);
  check('url 指向 musicu.fcg', captured && /u6\.y\.qq\.com\/cgi-bin\/musicu\.fcg/.test(captured.url));
  check('JSON 放 query string (data=)', captured && /[?&]data=/.test(captured.url));
  check('带 Cookie 头', captured && captured.init.headers.Cookie === 'qm_keyst=X');
  check('带 Referer', captured && captured.init.headers.Referer === 'https://y.qq.com/');

  // 缺参数应报错
  let threw = null;
  try { await QQEkey.getEkey({ filename: 'x.mgg' }, mockFetch); } catch (e) { threw = e; }
  check('缺 mid → 抛异常', threw !== null && /mid/.test(threw.message));

  threw = null;
  try { await QQEkey.getEkey({ mid: 'x' }, mockFetch); } catch (e) { threw = e; }
  check('缺 filename → 抛异常', threw !== null && /filename/.test(threw.message));

  console.log('\n=== 结果: ' + passed + ' passed, ' + failed + ' failed ===\n');
  process.exit(failed ? 1 : 0);
})();
