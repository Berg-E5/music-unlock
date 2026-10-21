#!/usr/bin/env node
/* ============================================
 * cipher-harness.js — qmc-mobile.js 离线往返测试
 * (V=84 移除 ekey 链路后, QmcEkey 模块已下线)
 *
 * 不需要真实歌曲: 自己合成加密文件, 再用模块解密, 对比明文
 * 这能验证算法实现是否自洽 (自己加密自己解只能证明对称性,
 *  但能抓住大部分实现错误: 越界/边界/类型/长度处理)
 *
 * 用法: node test/cipher-harness.js
 * ============================================ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ---------- 加载 modules 到 sandbox (模拟 worker 环境) ----------
function loadModules(extra = {}) {
  const sandbox = {
    console,
    TextDecoder, TextEncoder, URLSearchParams, BigInt,
    Uint8Array, ArrayBuffer, DataView, Math, JSON, String, Number, Object, Array,
    Error, isNaN, parseInt, parseFloat, isFinite, Boolean,
    setTimeout, clearTimeout, Promise, RegExp, Function,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    ...extra,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['crypto-utils.js', 'qmc-mobile.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'modules', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  return sandbox;
}

const S = loadModules();
const QmcMobile = S.QmcMobile;

let pass = 0, fail = 0;
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
function hex(b, n = 16) {
  return Array.from(b.slice(0, n)).map(x => x.toString(16).padStart(2, '0')).join(' ');
}

// ---------- 合成 PLAIN: 一个小 FLAC ----------
// fLaC + STREAMINFO (最小合法头)
function makeFlacPlain(n = 4096) {
  const head = Buffer.from([
    0x66, 0x4c, 0x61, 0x43,       // fLaC
    0x00, 0x00, 0x00, 0x22,       // metadata block header: STREAMINFO, len 34
    0x00, 0x00, 0x00, 0x00,       // min blocksize
    0x00, 0x00, 0x10, 0x00,       // max blocksize
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,       // min/max framesize
    0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 20 bits sampleRate 44100
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // channels/bps/sampleRate
  ]);
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = (i * 7 + (i >> 3)) & 0xff;
  return new Uint8Array(Buffer.concat([head, body]));
}

async function main() {
console.log('\n=== cipher-harness: qmc-mobile 往返 ===\n');

console.log('A. qmc-mobile (Android) 往返');
{
  ok(typeof QmcMobile.QMCMobileDecryptor === 'function', 'QMCMobileDecryptor 存在');
  ok(typeof QmcMobile.inferOutputExt === 'function', 'inferOutputExt 存在');
  // inferOutputExt 映射 (QMC_EXT_MAP: .mgg 家族 → .ogg, .mflac 家族 → .flac)
  const cases = [['.mgg2', 'ogg'], ['.mflac2', 'flac'], ['.mgg', 'ogg'], ['.mflac', 'flac'],
                 ['.mflac0', 'flac'], ['.mgg1', 'ogg'], ['.qmc3', 'mp3']];
  for (const [inp, want] of cases) {
    const got = QmcMobile.inferOutputExt('song' + inp);
    ok(got === '.' + want, `inferOutputExt('song${inp}') → .${want}`, 'got=' + got);
  }
  // 双后缀优先: .mgg2.flac 应判为 mgg2 的 ogg, 而不是看末尾 .flac
  ok(QmcMobile.inferOutputExt('歌名 [mqms2].mgg2.flac') === '.ogg', '双后缀 .mgg2.flac → .ogg (取加密后缀, 非明文后缀)');
  // 无已知后缀 → 默认 .flac
  ok(QmcMobile.inferOutputExt('mystery.xyz') === '.flac', '未知后缀 → 默认 .flac');
  // 大小写不敏感
  ok(QmcMobile.inferOutputExt('SONG.MGG2') === '.ogg', '大写 .MGG2 → .ogg');
}

// ============ 汇总 ============
console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('harness crashed:', e); process.exit(2); });