#!/usr/bin/env node
/* quick DOM dump — 打印页面关键区域文本, 作为 e2e 的可视证据 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.argv[2] || 'https://ncm.byberg.store';

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await (await b.newContext()).newPage();
  await p.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  const dump = async (label) => {
    const t = await p.evaluate(() => ({
      extStatus: (document.getElementById('ext-status') || {}).innerText || '(none)',
      ekeyStatus: (document.getElementById('ekey-status') || {}).innerText || '(none)',
      queue: (document.getElementById('list') || {}).innerText || '(empty)',
      done: (document.getElementById('done-list') || {}).innerText || '(empty)',
      doneCount: (document.getElementById('done-count') || {}).innerText || '?',
    }));
    console.log(`\n===== ${label} =====`);
    for (const [k, v] of Object.entries(t)) console.log(`  ${k}: ${String(v).replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  };

  await dump('初始状态');

  // 真实 ncm
  const ncm = '/root/.openclaw/media/inbound/薛之谦_-_平庸_Live---204753d5-c907-4156-a0a4-a6e01274893e.ncm';
  if (fs.existsSync(ncm)) {
    await p.setInputFiles('#file-input', ncm);
    await p.waitForTimeout(8000);
    await dump('NCM 解密后');
  }

  await b.close();
})();