#!/usr/bin/env node
/* ===========================================
 * derived-key-harness.js — ekey 解密链路回归测试
 *
 * 覆盖 modules/qmc.js 的 ekey 路径:
 *   QmcDecryptKey(ekey) -> master key -> makeCipherFromKey -> Map/RC4
 *
 * 这条链路对应站的宣传语「QQ 音乐 v1/v2, 密钥在文件内, 直接可解」。
 * 它有四个独立缺陷, 全部由本测试钉死:
 *
 *   1. CU.base64Decode 环境判定永远 false
 *      → 走进 Node 分支 → BufferUtil.from 不存在 → 任何环境都抛错
 *   2. CU.teaDecryptBlock 用 32 轮, Rust/Oracle 是 16 轮 (tc_tea)
 *      → TEA 解出垃圾 → "zero check failed"
 *   3. QmcMapCipher 用旧 unlock-music 的 getMask(offset) 公式,
 *      Rust/Oracle 是 keyCompress + transform
 *   4. QmcRC4Cipher 的分段/跳字节逻辑与 Rust/Oracle 不同
 *
 * 测试向量: test/xval-vectors/dv-*.bin (由 make_derived.py 用
 * Python oracle qmc_ref.py 造), 基准明文在 test/xval-vectors/expected/
 *
 * 用法: node test/derived-key-harness.js
 * ============================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const XVAL = path.join(ROOT, 'test', 'xval-vectors');
const EXPECTED_DIR = path.join(XVAL, 'expected');

// ---------- 加载 modules 到 sandbox (模拟 worker 环境: 无 Buffer) ----------
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

async function main() {

console.log('\n=== derived-key-harness: ekey 解密链路 ===\n');

// ---------- A. CU.base64Decode ----------
console.log('A. CU.base64Decode');
{
  // "EBESExQVFhcYGQ==" = base64(0x10 0x11 0x12 0x13 0x14 0x15 0x16 0x17 0x18 0x19)
  // 注意: 之前这里写的是 "EBESExQVFhd3xf" (14 字符) —— 长度不是 4 的倍数, 根本不是
  // 合法 base64, Buffer.from 宽松解码会截断出垃圾字节, 于是误报成实现 bug。
  const EXPECT = Buffer.from([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19]);
  let got = null, err = null;
  try { got = CU.base64Decode('EBESExQVFhcYGQ=='); } catch (e) { err = e.message; }
  ok(err === null, 'base64Decode 不抛异常', err || '');
  ok(got && eqBytes(got, EXPECT), 'base64Decode 结果正确',
    got ? `got=${Buffer.from(got).toString('hex')} want=${EXPECT.toString('hex')}` : 'null');

  // 边界: 空串
  let empty = null, eerr = null;
  try { empty = CU.base64Decode(''); } catch (e) { eerr = e.message; }
  ok(eerr === null && empty && empty.length === 0, 'base64Decode("") 返回空数组', eerr || '');
}

// ---------- B. TEA 轮数 + zero check ----------
console.log('\nB. TEA CBC (16 轮 tc_tea)');
{
  // 注意: 之前这里用「16 字节全零密文」当输入, 但那根本不是合法的 TEA-CBC 密文
  // (header[1] + salt[2] + body + zero[7]), zero 校验当然过不了 -> 误报成实现 bug。
  // 正确做法: 用 oracle 造合法密文 (test/xval-vectors/make_tea_vectors.py),
  // 断言能原样还原 body。详见 test/tea-check.js 的 20 组对拍。
  const key = new Uint8Array(16).fill(0x5A);
  const cipher = new Uint8Array(16).fill(0x00);
  let err = null;
  try { CU.teaDecryptCBC(cipher, key); } catch (e) { err = e.message; }
  ok(err !== null && /zero check|invalid/i.test(err),
    '非法密文 (全零) 被 zero check 拒绝 (不是静默返回垃圾)',
    err || '没有抛异常 —— 非法输入被当成合法密文解了');
}

// ---------- C/D. 端到端: 生产入口 QMC.decode() ----------
console.log('\nC. QMC.decode() 端到端 (vs Python oracle 基准)');

const VECTORS = [
  // name,        说明
  ['dv-v1embedded', 'PC v1 Legacy (尾 4B = payload_len LE)'],
  ['dv-qtag',       'Android QTag (尾 4B = payload_len BE)'],
  ['dv-map120',     'Map cipher, master 120B'],
  ['dv-rc4',        'RC4 cipher, master 512B'],
  ['dv-ekeyv2',     'EKey V2 (双层 TEA)'],
];

for (const [name, desc] of VECTORS) {
  console.log(`\n  [${name}] ${desc}`);
  const fpath = path.join(XVAL, `${name}.bin`);
  const expPath = path.join(EXPECTED_DIR, `${name}.plain`);
  if (!fs.existsSync(fpath) || !fs.existsSync(expPath)) {
    console.log('    ! SKIP: 缺向量 (跑 python3 test/xval-vectors/make_derived.py)');
    skip++;
    continue;
  }

  const file = new Uint8Array(fs.readFileSync(fpath));
  const exp = fs.readFileSync(expPath);

  // 注意: QMC.detect(filename) 是按后缀匹配, detectCipherType 是内部函数未导出。
  // 这里只能通过 decode() 的行为间接验证格式识别 —— 所以不单独断言 detect。

  // 生产入口
  let result = null, err = null;
  try {
    result = await QMC.decode(file, `${name}.bin`, () => {}, {});
  } catch (e) {
    err = e.message;
  }
  ok(err === null, `${name}: decode() 不抛异常`, err || '');
  if (!result) continue;

  ok(result.audio && result.audio.length === exp.length,
    `${name}: 明文长度与 oracle 一致`,
    `got ${result.audio ? result.audio.length : 'null'} want ${exp.length}`);
  ok(result.audio && Buffer.from(result.audio.slice(0, 4)).toString('hex') === '4f676753',
    `${name}: 明文头是 OggS`,
    result.audio ? Buffer.from(result.audio.slice(0, 8)).toString('hex') : '');
  ok(eqBytes(result.audio, exp), `${name}: 与 Python oracle 逐字节一致`,
    `oracle ${exp.length}B sha=${sha(exp).slice(0, 16)}\n      js     ${result.audio.length}B sha=${sha(result.audio).slice(0, 16)}`);
}

// ============================================================
console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('harness crashed:', e); process.exit(2); });
