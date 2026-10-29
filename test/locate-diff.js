#!/usr/bin/env node
/**
 * locate-diff.js — 定位 JS 解密输出与 Python oracle 期望明文的第一个字节差异
 *
 * 用法: node test/locate-diff.js <case>
 *   case ∈ { dv-map120, dv-rc4, dv-v1embedded, dv-ekeyv2, dv-qtag }
 *
 * 加载方式与 derived-key-harness.js 保持一致 (无 Buffer 的 worker 沙箱)。
 * 按 0x80 段统计差异分布 —— 这是判断「分段算法错」还是「整体算法错」的关键信号。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const XVAL = path.join(ROOT, 'test', 'xval-vectors');
const EXPECTED_DIR = path.join(XVAL, 'expected');

// ---- 与 derived-key-harness.js 相同的沙箱: 模拟 worker, 无 Buffer ----
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
const QMC = S.QMC;

const name = process.argv[2] || 'dv-map120';
const fpath = path.join(XVAL, name + '.bin');
const expPath = path.join(EXPECTED_DIR, name + '.plain');
if (!fs.existsSync(fpath) || !fs.existsSync(expPath)) {
  console.error('缺少向量:', name, '(跑 python3 test/xval-vectors/make_derived.py)');
  process.exit(2);
}

const file = new Uint8Array(fs.readFileSync(fpath));
const expected = fs.readFileSync(expPath);
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 16);

(async () => {
  let result = null, err = null;
  try {
    result = await QMC.decode(file, name + '.bin', () => {}, {});
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  if (err) { console.error('QMC.decode 抛异常:', err); process.exit(4); }

  const got = Buffer.from(result.audio);
  console.log('=== case:', name, '===');
  console.log('oracle : %dB sha=%s', expected.length, sha(expected));
  console.log('js     : %dB sha=%s', got.length, sha(got));
  console.log('');

  if (got.length !== expected.length) {
    console.log('!! 长度不同 (oracle %d vs js %d), 无法逐字节比对', expected.length, got.length);
    process.exit(1);
  }
  if (got.equals(expected)) {
    console.log('✓ 逐字节一致 — 该 case 已通过');
    process.exit(0);
  }

  let first = -1;
  for (let i = 0; i < expected.length; i++) if (expected[i] !== got[i]) { first = i; break; }
  console.log('第一处差异 offset = %d (0x%x)', first, first);
  console.log('  oracle byte = 0x%02x', expected[first]);
  console.log('  js     byte = 0x%02x', got[first]);
  console.log('');

  let diffCount = 0;
  for (let i = 0; i < expected.length; i++) if (expected[i] !== got[i]) diffCount++;
  console.log('总差异字节: %d / %d (%.2f%%)', diffCount, expected.length, diffCount * 100 / expected.length);

  console.log('');
  console.log('按 0x80 段切分的差异分布 (只列有差异的段):');
  const SEG = 0x80;
  let segs = 0;
  for (let s = 0; s < expected.length; s += SEG) {
    const e = Math.min(s + SEG, expected.length);
    let d = 0;
    for (let i = s; i < e; i++) if (expected[i] !== got[i]) d++;
    if (d > 0) {
      segs++;
      if (segs <= 12 || s < first + SEG) {
        console.log('  [%6d..%6d) 差异 %3d/%3d  (%.0f%%)', s, e, d, e - s, d * 100 / (e - s));
      }
    }
  }
  console.log('  (有差异的段数: %d / %d)', segs, Math.ceil(expected.length / SEG));

  console.log('');
  const ctxStart = Math.max(0, first - 16);
  const ctxEnd = Math.min(expected.length, first + 32);
  console.log('差异点上下文 [%d..%d):', ctxStart, ctxEnd);
  for (let i = ctxStart; i < ctxEnd; i += 16) {
    const e = Math.min(i + 16, ctxEnd);
    const o = expected.subarray(i, e).toString('hex').replace(/(..)/g, '$1 ').trim();
    const j = got.subarray(i, e).toString('hex').replace(/(..)/g, '$1 ').trim();
    const mark = (i <= first && first < e) ? '   <<< 首个差异' : '';
    console.log('  %06x  oracle: %s', i, o);
    console.log('         js    : %s%s', j, mark);
  }
})().catch(e => { console.error('crashed:', e); process.exit(3); });
