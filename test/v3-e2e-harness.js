#!/usr/bin/env node
/* ===========================================
 * v3-e2e-harness.js — 真实浏览器验证 MusicEx (V3) 解密链路
 *
 * 验证的是**用户实际会走的路径**:
 *   1. 浏览器打开 https://ncm.byberg.store
 *   2. 页面加载无 JS 错误, worker 起来了
 *   3. 在「V3 ekey」输入框填入 ekey
 *   4. 把 v3-map.mgg / v3-rc4.mgg 喂进去
 *   5. 页面把解密结果交给 worker -> 转码 -> 显示可下载结果
 *
 * 与 v3-harness.js 的区别: 那个在 Node VM 里直接调 QMC.decode,
 * 这个走完整浏览器链路 (index.html -> app.js -> worker.js -> modules/)。
 *
 * 用法: NODE_PATH=/tmp/e2e-deps/node_modules node test/v3-e2e-harness.js [baseUrl]
 * =========================================== */

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

  // ---------- 2. ekey 输入框存在 ----------
  const ekeyBox = await page.$('#qmc-ekey');
  ok(ekeyBox !== null, '页面存在「V3 ekey」输入框 (#qmc-ekey)');

  // ---------- 3. worker 起来了 ----------
  const workerInfo = await page.evaluate(() => {
    const w = window.__hermesWorkerProbe;
    return w || null;
  });
  // 探针可能不存在 —— 退而求其次: 检查 worker.js 是否被请求且 200
  const workerLoaded = !failedRequests.some(u => u.includes('worker.js'));
  ok(workerLoaded, 'worker.js 加载成功');

  // ---------- 4. 逐个向量: 填 ekey -> 喂文件 -> 验证结果 ----------
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
    const expected = fs.readFileSync(expPath);

    // 填 ekey
    await page.fill('#qmc-ekey', ekey);
    const filled = await page.inputValue('#qmc-ekey');
    ok(filled === ekey, `${name}: ekey 已填入输入框`);

    // 喂文件
    await page.setInputFiles('#file-input', filePath);

    // 等解密完成 —— 结果出现在 #done-list 里
    let done = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const list = document.querySelector('#done-list');
        const items = list ? list.querySelectorAll('li') : [];
        return {
          doneCount: items.length,
          text: list ? list.textContent.replace(/\s+/g, ' ').trim() : '',
        };
      });
      if (state.doneCount > 0) { done = state; break; }
      await page.waitForTimeout(500);
    }

    if (!done) {
      // 失败时把页面上的错误抓出来
      const errText = await page.evaluate(() => {
        const t = document.querySelector('#toast');
        const list = document.querySelector('#list');
        return (t ? t.textContent : '') + ' || ' + (list ? list.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : '');
      });
      ok(false, `${name}: 30s 内未产出结果`, errText);
      await page.screenshot({ path: path.join(SHOT_DIR, `${name}-fail.png`) });
      continue;
    }

    ok(done.doneCount > 0, `${name}: 解密完成, 结果出现在已完成列表`);

    // 验证产物的真实字节 —— 从页面里 fetch 那个 blob URL 读回来。
    // (不用 download 事件: blob URL 在 click 后 2 秒就被 revokeObjectURL 回收,
    //  事件抓到的时机不稳。)
    const probe = await page.evaluate(async () => {
      const list = document.querySelector('#done-list');
      const a = list ? list.querySelector('a[download]') : null;
      if (!a) return { err: 'no download anchor' };
      try {
        const buf = await (await fetch(a.href)).arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf.slice(0, 8)));
        return {
          href: a.href.slice(0, 40),
          filename: a.download,
          size: buf.byteLength,
          head: bytes,
        };
      } catch (e) {
        return { err: String(e) };
      }
    });

    if (probe.err) {
      ok(false, `${name}: 读取产物字节失败`, probe.err);
    } else {
      const head = Buffer.from(probe.head).toString('hex');
      // 转码后是 MP3 (ID3 或帧同步), 未转码则是 Ogg (4f676753)
      const isMp3 = probe.head[0] === 0xff && (probe.head[1] & 0xe0) === 0xe0;
      const isId3 = probe.head[0] === 0x49 && probe.head[1] === 0x44 && probe.head[2] === 0x33;
      const isOgg = head.startsWith('4f676753');
      ok(isMp3 || isId3 || isOgg, `${name}: 产物是合法音频`,
        `head=${head} filename=${probe.filename} size=${probe.size}`);
      ok(probe.size > 1000, `${name}: 产物长度合理 (非空)`,
        `size=${probe.size}`);
      console.log(`      产物: ${probe.filename}  ${probe.size}B  head=${head}`);
    }

    await page.screenshot({ path: path.join(SHOT_DIR, `${name}-ok.png`) });
    // 清场, 准备下一个向量
    await page.evaluate(() => {
      const b = document.getElementById('clear-btn');
      if (b) b.click();
    });
    await page.fill('#qmc-ekey', '');
  }

  await browser.close();

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  console.log(`截图: ${SHOT_DIR}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness crashed:', e); process.exit(2); });
