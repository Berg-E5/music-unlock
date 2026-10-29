#!/usr/bin/env node
/* ===========================================
 * v3-harness.js — MusicEx (V3) 解密链路测试
 *
 * 背景:
 *   V3 / MusicEx 是 PC 客户端 19.57+ / Windows 22.x+ 的格式。
 *   footer 只有元数据 (song_id / quality / media_mid / media_filename),
 *   **不含密钥** —— ekey 必须另外从 QQ 音乐 API 取。
 *   但密码学与 V2 完全同源: 同一条 QMC2 cipher (Map / RC4),
 *   差别只在 key 的来源。
 *
 * 本测试验证:
 *   A. CU.base64Decode 能正常解码 (回归: 曾经在任何环境都抛错)
 *   B. QMC.parseMusicExFooter 能解析 footer, 取出 mid / filename
 *   C. QMC.decode(file, name, tick, {ekey}) 能解出明文
 *   D. 结果与 Python oracle (test/xval-vectors/qmc_ref.py) 逐字节一致
 *
 * 测试向量:
 *   test/xval-vectors/v3-{map,rc4}.mgg   由 make_v3.py 用 oracle 造
 *   test/xval-vectors/ekey-{map,rc4}.txt 对应的 V1 EKey
 *   基准明文由 oracle_probe.py 生成 (oracle 自身解出的结果)
 *
 * 用法: node test/v3-harness.js
 * ============================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const XVAL = path.join(ROOT, 'test', 'xval-vectors');
const EXPECTED_DIR = process.env.QMC_V3_EXPECTED
  || path.join(ROOT, 'test', 'xval-vectors', 'expected');

// ---------- 加载 modules 到 sandbox (模拟 worker 环境) ----------
function loadModules() {
  const sandbox = {
    console,
    TextDecoder, TextEncoder, URLSearchParams, BigInt,
    Uint8Array, ArrayBuffer, DataView, Math, JSON, String, Number, Object, Array,
    Error, isNaN, parseInt, parseFloat, isFinite, Boolean,
    setTimeout, clearTimeout, Promise, RegExp, Function,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['crypto-utils.js', 'qmc.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'modules', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  return sandbox;
}

const S = loadModules();
const CU = S.CU;
const QMC = S.QMC;

let pass = 0, fail = 0, skip = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}
function eqBytes(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function sha(b) { return crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'); }

// ============================================================
console.log('\n=== v3-harness: MusicEx (V3) 解密链路 ===\n');

// ---------- A. base64Decode 回归 ----------
console.log('A. CU.base64Decode');
{
  // 已知: "EBESExQVFhd3xf" 是 header8 = 0x10..0x17 的 base64
  const EXPECT = Buffer.from([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19]);
  let got = null, err = null;
  try { got = CU.base64Decode('EBESExQVFhd3xf'); } catch (e) { err = e.message; }
  ok(err === null, 'base64Decode 不抛异常', err || '');
  ok(got && eqBytes(got, EXPECT), 'base64Decode 结果正确',
    got ? `got=${Buffer.from(got).toString('hex')} want=${EXPECT.toString('hex')}` : 'null');
}

// ---------- B/C/D. 逐个向量 ----------
const VECTORS = [
  { name: 'map', expectMid: '0039MnYb0FzMPN', expectFile: '004ZzMIRh1N8WaT.mgg' },
  { name: 'rc4', expectMid: '0039MnYb0FzMPN', expectFile: '004ZzMIRh1N8WaT.mgg' },
];

async function main() {

for (const v of VECTORS) {
  console.log(`\nB/C/D. 向量 ${v.name}`);
  const fpath = path.join(XVAL, `v3-${v.name}.mgg`);
  const epath = path.join(XVAL, `ekey-${v.name}.txt`);
  const expPath = path.join(EXPECTED_DIR, `v3-${v.name}.plain`);

  if (!fs.existsSync(fpath) || !fs.existsSync(epath)) {
    console.log(`  ! SKIP: 缺少向量 ${fpath} (跑 python3 test/xval-vectors/make_v3.py 生成)`);
    skip++;
    continue;
  }

  const file = new Uint8Array(fs.readFileSync(fpath));
  const ekey = fs.readFileSync(epath, 'utf8').trim();

  // --- B. footer 解析 ---
  const footer = QMC.parseMusicExFooter ? QMC.parseMusicExFooter(file) : null;
  ok(footer !== null, `${v.name}: parseMusicExFooter 返回非 null`);
  if (footer) {
    ok(footer.type === 'v3-musicex', `${v.name}: footer.type === 'v3-musicex'`, `got ${footer.type}`);
    ok(footer.mid === v.expectMid, `${v.name}: footer.mid 正确`, `got ${JSON.stringify(footer.mid)} want ${v.expectMid}`);
    ok(footer.mediaFilename === v.expectFile, `${v.name}: footer.mediaFilename 正确`,
      `got ${JSON.stringify(footer.mediaFilename)} want ${v.expectFile}`);
    ok(footer.footerSize === 192, `${v.name}: footer.footerSize === 192`, `got ${footer.footerSize}`);
    ok(footer.audioSize === file.length - 192, `${v.name}: footer.audioSize === 文件长 - 192`,
      `got ${footer.audioSize} want ${file.length - 192}`);
  }

  // --- C. decode() 接受 opts.ekey ---
  let result = null, err = null;
  try {
    result = await QMC.decode(file, `v3-${v.name}.mgg`, () => {}, { ekey });
  } catch (e) {
    err = e.message;
  }
  ok(err === null, `${v.name}: decode({ekey}) 不抛异常`, err || '');
  if (!result) continue;

  ok(result.audio && result.audio.length === file.length - 192,
    `${v.name}: 明文长度 === 文件长 - 192`,
    `got ${result.audio ? result.audio.length : 'null'} want ${file.length - 192}`);
  ok(result.audio && Buffer.from(result.audio.slice(0, 4)).toString('hex') === '4f676753',
    `${v.name}: 明文头是 OggS`,
    result.audio ? Buffer.from(result.audio.slice(0, 8)).toString('hex') : '');

  // --- D. 与 oracle 逐字节对拍 ---
  if (!fs.existsSync(expPath)) {
    console.log(`  ! SKIP 对拍: 缺 oracle 基准 ${expPath}`);
    console.log(`      生成: python3 test/xval-vectors/../../... (见 qmc_ref.decrypt_qmc_file)`);
    skip++;
  } else {
    const exp = fs.readFileSync(expPath);
    ok(eqBytes(result.audio, exp), `${v.name}: 与 Python oracle 逐字节一致`,
      `oracle ${exp.length}B sha=${sha(exp).slice(0, 16)}\n      js     ${result.audio.length}B sha=${sha(result.audio).slice(0, 16)}`);
  }
}

// ---------- E. 无 ekey 时的报错要可操作 ----------
console.log('\nE. 缺 ekey 时的报错');
{
  const fpath = path.join(XVAL, 'v3-map.mgg');
  if (!fs.existsSync(fpath)) {
    console.log('  ! SKIP: 缺少向量');
    skip++;
  } else {
    const file = new Uint8Array(fs.readFileSync(fpath));
    let msg = null;
    try { await QMC.decode(file, 'v3-map.mgg', () => {}, {}); } catch (e) { msg = e.message; }
    ok(msg !== null, '缺 ekey 时抛错 (而不是静默失败)');
    if (msg) {
      ok(!/浏览器无法获得/.test(msg),
        '报错不再声称「浏览器无法获得」(这句是错的: ekey 可由用户提供)',
        `msg=${JSON.stringify(msg.slice(0, 120))}`);
      ok(/ekey|EKey|密钥/i.test(msg), '报错提到 ekey / 密钥', `msg=${JSON.stringify(msg.slice(0, 120))}`);
    }
  }
}

// ============================================================
console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('harness crashed:', e); process.exit(2); });
