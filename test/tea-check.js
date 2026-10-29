#!/usr/bin/env node
/**
 * tea-check.js — JS teaDecryptCBC 与 Python oracle 逐字节对拍
 *
 * 做法: 用 Python oracle 生成「合法」的 TEA-CBC 密文 (header + salt + body + zero pad),
 * 交给 JS 的 CU.teaDecryptCBC 解, 看能不能还原出原始 body。
 *
 * 用法:
 *   node test/tea-check.js            # 用内置的确定性向量
 *   python3 test/xval-vectors/make_tea_vectors.py   # (可选) 重新生成
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VEC = path.join(ROOT, 'test', 'xval-vectors');

// ---- 加载 CU ----
function loadCU() {
  const sandbox = {
    console, TextDecoder, TextEncoder, URLSearchParams, BigInt,
    Uint8Array, ArrayBuffer, DataView, Math, JSON, String, Number, Object, Array,
    Error, isNaN, parseInt, parseFloat, isFinite, Boolean,
    setTimeout, clearTimeout, Promise, RegExp, Function,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'modules', 'crypto-utils.js'), 'utf8'),
    sandbox, { filename: 'crypto-utils.js' });
  return sandbox.CU;
}

const CU = loadCU();

// ---- 读 oracle 生成的向量 ----
const vecPath = path.join(VEC, 'tea-vectors.json');
if (!fs.existsSync(vecPath)) {
  console.error('缺少 tea-vectors.json, 先跑:');
  console.error('  python3 test/xval-vectors/make_tea_vectors.py');
  process.exit(2);
}
const vectors = JSON.parse(fs.readFileSync(vecPath, 'utf8'));

let pass = 0, fail = 0;
for (const v of vectors) {
  const cipher = Buffer.from(v.cipher, 'base64');
  const key = Buffer.from(v.key, 'base64');
  const want = Buffer.from(v.plain, 'base64');

  let got = null, err = null;
  try {
    got = Buffer.from(CU.teaDecryptCBC(new Uint8Array(cipher), new Uint8Array(key)));
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }

  const label = v.name;
  if (err) {
    fail++;
    console.log('  ✗ ' + label.padEnd(22) + ' 抛异常: ' + err);
  } else if (got.equals(want)) {
    pass++;
    console.log('  ✓ ' + label.padEnd(22) + got.length + 'B 逐字节一致');
  } else {
    fail++;
    console.log('  ✗ ' + label.padEnd(22) + '不一致');
    console.log('      want ' + want.length + 'B ' + want.subarray(0, 16).toString('hex'));
    console.log('      got  ' + got.length + 'B ' + got.subarray(0, 16).toString('hex'));
  }
}

console.log('');
console.log('=== TEA 对拍: %d passed, %d failed ===', pass, fail);
process.exit(fail ? 1 : 0);
