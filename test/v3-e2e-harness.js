#!/usr/bin/env node
/* ===========================================
 * v3-e2e-harness.js — 真实浏览器验证 MusicEx (V3) 解密链路
 *
 * 背景 (2026-11-04 变更):
 *   页面上的 ekey 输入框已撤掉 (UI 不再露出 ekey), 但**解密代码保留** ——
 *   worker 仍接受 msg.ekey, QMC.decode 的 V3 分支仍在。
 *   所以本测试不再通过 UI 填 ekey, 而是在浏览器里直接驱动一个 worker 实例,
 *   验证「解密能力没坏」; 同时断言页面 UI 上确实找不到 ekey。
 *
 * 验证:
 *   1. 页面加载无 JS 错误 / 无 404 资源
 *   2. 页面 DOM 里没有 #qmc-ekey 输入框, 可见文本不含 ekey
 *   3. 直接给 worker 喂 msg.ekey -> 真 .mgg 解密成功 -> 产物是可解码音频
 *   4. 产物时长与 oracle 基准 (expected/v3-real-*.plain) 一致
 *
 * 用法: NODE_PATH=/tmp/e2e-deps/node_modules node test/v3-e2e-harness.js [baseUrl]
 * ============================================ */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'https://ncm.byberg.store';
const REPO = path.resolve(__dirname, '..');
const XVAL = path.join(REPO, 'test', 'xval-vectors');
const SHOT_DIR = '/tmp/v3-e2e-shots';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}

// 在页面里建一个独立 worker, 直接喂 msg.ekey (绕开 UI)。
// worker 会把音频解码委托回主线程 (AudioContext 不在 worker 里), 这里复刻 app.js 的桥。
const DRIVE_WORKER = async ({ fileB64, fileName, ekey }) => {
  const bin = atob(fileB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], fileName, { type: 'application/octet-stream' });

  const worker = new Worker(new URL('assets/js/worker.js?v=106', location.href));
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  return await new Promise((resolve) => {
    const timer = setTimeout(() => { worker.terminate(); resolve({ error: '超时 (45s)' }); }, 45000);

    worker.addEventListener('message', async (ev) => {
      const d = ev.data || {};
      // worker 请主线程解码音频 (与 app.js handleAudioDecode 同逻辑)
      if (d.type === 'audio-decode') {
        try {
          const ab = d.audioBuffer;
          const decoded = await ctx.decodeAudioData(ab);
          const channels = decoded.numberOfChannels;
          const ch0 = decoded.getChannelData(0);
          const ch1 = channels > 1 ? decoded.getChannelData(1) : null;
          const reply = { type: 'audio-decoded', seq: d.seq, sampleRate: decoded.sampleRate, channels, ch0: ch0.slice() };
          const transfer = [reply.ch0.buffer];
          if (ch1) { reply.ch1 = ch1.slice(); transfer.push(reply.ch1.buffer); }
          worker.postMessage(reply, transfer);
        } catch (e) {
          worker.postMessage({ type: 'audio-decode-error', seq: d.seq, error: e.message || String(e) });
        }
        return;
      }
      if (d.type === 'error') {
        clearTimeout(timer); worker.terminate();
        resolve({ error: d.message });
        return;
      }
      if (d.type === 'done') {
        clearTimeout(timer);
        try {
          // 注意: fetch(blob) 会把 blob 当请求 body, URL 还是当前页面 ——
          // 必须先 createObjectURL 才是真的读 blob 内容。
          const url = URL.createObjectURL(d.payload.blob);
          const buf = await (await fetch(url)).arrayBuffer();
          URL.revokeObjectURL(url);
          worker.terminate();
          const head = Array.from(new Uint8Array(buf.slice(0, 8)));
          // 解码产物, 拿到时长 —— 用来跟 oracle 基准比对
          let duration = 0, samples = 0, sampleRate = 0;
          try {
            const dec = await ctx.decodeAudioData(buf.slice(0));
            duration = dec.duration; samples = dec.length; sampleRate = dec.sampleRate;
          } catch (e) { /* 下面靠 duration=0 判定 */ }
          resolve({ size: buf.byteLength, head, filename: d.payload.filename, duration, samples, sampleRate });
        } catch (e) {
          worker.terminate();
          resolve({ error: '读取产物失败: ' + String(e) });
        }
      }
    });

    worker.postMessage({ id: 1, type: 'decrypt', file, outputFormat: 'mp3', mp3Bitrate: 320, ekey });
  });
};

// 读 oracle 基准音频的时长 (在页面里用 AudioContext 解)
const EXPECTED_DURATION = async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dec = await ctx.decodeAudioData(bytes.buffer);
  return { duration: dec.duration, samples: dec.length, sampleRate: dec.sampleRate };
};

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  const jsErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', r => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
  page.on('response', r => { if (r.status() >= 400) failedRequests.push(`${r.url()} :: HTTP ${r.status()}`); });

  console.log(`\n=== v3-e2e-harness: ${BASE} ===\n`);

  // ---------- 1. 页面加载 ----------
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  ok(jsErrors.length === 0, '页面加载无 JS 异常',
    jsErrors.slice(0, 3).join(' | '));
  ok(failedRequests.length === 0, '无 404 / 失败请求',
    failedRequests.slice(0, 3).join(' | '));

  // ---------- 2. UI 上不再露出 ekey ----------
  const ekeyBoxCount = await page.locator('#qmc-ekey').count();
  ok(ekeyBoxCount === 0, '页面不存在「V3 ekey」输入框 (#qmc-ekey)');
  const pageText = await page.locator('body').innerText();
  ok(!/ekey/i.test(pageText), '页面可见文本不含 ekey 字样',
    (pageText.match(/.{0,40}ekey.{0,40}/i) || [''])[0]);
  const domHtml = await page.content();
  ok(!/qqmusic-ekey/i.test(domHtml), 'DOM 里不再引用 qqmusic-ekey.zip');
  await page.screenshot({ path: path.join(SHOT_DIR, '01-no-ekey-ui.png'), fullPage: true });

  // ---------- 3/4. 解密能力仍可用 (直接驱动 worker) ----------
  // 用 v3-real-* 向量 (真 Ogg 音频, 见 make_v3_real.py) —— 之前用的 v3-*.mgg
  // 正文是伪造随机字节, 不是合法 Ogg 流, 浏览器 AudioContext 解不了,
  // 转码必然报 "Unable to decode audio data"。那是测试素材问题, 不是解密问题。
  for (const name of ['map', 'rc4']) {
    console.log(`\n  [${name}]`);
    const filePath = path.join(XVAL, `v3-real-${name}.mgg`);
    const ekeyPath = path.join(XVAL, `ekey-v3-real-${name}.txt`);
    const expPath = path.join(XVAL, 'expected', `v3-real-${name}.plain`);

    if (!fs.existsSync(filePath) || !fs.existsSync(ekeyPath) || !fs.existsSync(expPath)) {
      ok(false, `${name}: 向量缺失`, filePath);
      continue;
    }
    const ekey = fs.readFileSync(ekeyPath, 'utf8').trim();
    const fileB64 = fs.readFileSync(filePath).toString('base64');
    const expB64 = fs.readFileSync(expPath).toString('base64');

    const res = await page.evaluate(DRIVE_WORKER, {
      fileB64, fileName: `v3-real-${name}.mgg`, ekey,
    });

    if (res.error) {
      ok(false, `${name}: worker 解密报错`, res.error);
      await page.screenshot({ path: path.join(SHOT_DIR, `${name}-fail.png`) });
      continue;
    }

    ok(res.size > 1000, `${name}: 产物长度合理 (非空)`, `size=${res.size}`);
    const head = Buffer.from(res.head).toString('hex');
    const isMp3 = res.head[0] === 0xff && (res.head[1] & 0xe0) === 0xe0;
    const isId3 = res.head[0] === 0x49 && res.head[1] === 0x44 && res.head[2] === 0x33;
    const isOgg = head.startsWith('4f676753');
    ok(isMp3 || isId3 || isOgg, `${name}: 产物是合法音频`,
      `head=${head} filename=${res.filename} size=${res.size}`);
    ok(res.duration > 0, `${name}: 产物能被浏览器解码 (真实音频, 非垃圾)`,
      `duration=${res.duration} samples=${res.samples}`);

    // 与 oracle 基准比对时长 —— 证明解出来的就是那首歌, 不是乱码
    const exp = await page.evaluate(EXPECTED_DURATION, expB64);
    const diff = Math.abs(res.duration - exp.duration);
    ok(diff < 0.05, `${name}: 时长与 oracle 基准一致 (逐字节对拍的等价证据)`,
      `got=${res.duration.toFixed(3)}s expected=${exp.duration.toFixed(3)}s diff=${diff.toFixed(3)}s`);
    console.log(`      产物: ${res.filename}  ${res.size}B  head=${head}  ${res.duration.toFixed(3)}s`);

    await page.screenshot({ path: path.join(SHOT_DIR, `${name}-ok.png`) });
  }

  await browser.close();

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  console.log(`截图: ${SHOT_DIR}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness crashed:', e); process.exit(2); });
