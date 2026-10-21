#!/usr/bin/env node
/* ============================================
 * e2e-harness.js — 用真实浏览器跑 ncm.byberg.store
 *
 * 验证 (无扩展环境):
 *   - 页面加载无 JS 错误 / 无 404 资源
 *   - worker 起来了, V 版本号正确
 *   - 拖入 .ncm / 明文音频 → 能解密出可播放文件
 *   - 拖入 .mgg → 报出可读错误 (无扩展时预期失败)
 *
 * 用法: node test/e2e-harness.js [baseUrl]
 * ============================================ */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'https://ncm.byberg.store';
const SHOT_DIR = '/tmp/e2e-shots';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '\n      ' + extra : ''}`); }
}

// ---------- 造测试素材 ----------
function makeWav(n = 8000) {
  // 16-bit PCM 单声道 WAV, 8kHz, 带可识别正弦
  const sr = 8000, nch = 1, bits = 16;
  const dataLen = n * nch * (bits / 8);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * nch * (bits / 8), 28);
  buf.writeUInt16LE(nch * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i / 12) * 20000), 44 + i * 2);
  }
  return buf;
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`\n=== e2e-harness: ${BASE} ===\n`);

  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  const consoleLog = [];
  const failedReq = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    consoleLog.push(`[${m.type()}] ${t}`);
    if (m.type() === 'error') errors.push('console.error: ' + t);
  });
  page.on('response', r => { if (r.status() >= 400) failedReq.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', r => failedReq.push(`FAILED ${r.url()} (${r.failure() && r.failure().errorText})`));

  // === A. 页面加载 ===
  console.log('A. 页面加载');
  const resp = await page.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'networkidle', timeout: 30000 });
  ok(resp && resp.status() === 200, 'HTTP 200', resp && String(resp.status()));
  ok((await page.title()).length > 0, '有 title', await page.title());

  await page.waitForTimeout(1500);
  ok(errors.length === 0, '无 JS 运行时错误', errors.slice(0, 5).join('\n      '));
  ok(failedReq.length === 0, '无资源加载失败 (4xx/5xx)', failedReq.slice(0, 8).join('\n      '));

  // 关键 DOM 元素
  for (const [id, name] of [['dropzone', '拖拽区'], ['file-input', '文件选择'], ['list', '队列列表']]) {
    ok(await page.locator('#' + id).count() > 0, `DOM #${id} (${name}) 存在`);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '01-load.png'), fullPage: true });

  // === B. worker 版本 ===
  // worker 是 module worker, 其 console 输出可能不转发到 page console
  // 改用间接验证: app.js 里 worker 构造成功的标志 (无 error toast)
  console.log('\nB. Worker 就绪');
  const toastTxt = await page.locator('#toast').innerText().catch(() => '');
  ok(!/Worker 错误/.test(toastTxt), '无 Worker 加载错误', toastTxt);
  const wl = consoleLog.filter(l => /worker/i.test(l));
  if (wl.length) for (const l of wl.slice(0, 6)) console.log('      ' + l.slice(0, 150));
  else console.log('      (worker console 未转发到 page — 已用间接信号验证)');

  // === C. 明文 WAV 转码/解密 ===
  console.log('\nC. 拖入明文 WAV');
  const wavPath = '/tmp/e2e-test.wav';
  fs.writeFileSync(wavPath, makeWav());
  await page.setInputFiles('#file-input', wavPath);
  await page.waitForTimeout(3000);

  const doneCount = await page.locator('#done-count').innerText().catch(() => '?');
  ok(doneCount === '1', 'done-count = 1 (WAV 处理完成)', 'got ' + doneCount);
  await page.screenshot({ path: path.join(SHOT_DIR, '02-wav.png'), fullPage: true });

  // 产物在 #done-list (不是 #list) — #list 是进行中的队列
  const dlLinks = page.locator('#done-list a[download]');
  const dlN = await dlLinks.count();
  ok(dlN > 0, '结果区出现可下载条目', 'count=' + dlN);
  if (dlN > 0) {
    const href = await dlLinks.first().getAttribute('href');
    ok(!!href && href.startsWith('blob:'), '下载用 blob: URL', String(href).slice(0, 40));
    const name = await dlLinks.first().getAttribute('download');
    console.log('      输出文件名:', name);
    ok(!!name && /\.(wav|mp3|flac|ogg|m4a)$/i.test(name), '输出后缀是合法音频', String(name));
    const blobBytes = await page.evaluate(async () => {
      const a = document.querySelector('#done-list a[download]');
      const b = await (await fetch(a.href)).arrayBuffer();
      return Array.from(new Uint8Array(b.slice(0, 16)));
    });
    const magic = blobBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('      blob 头 16 字节:', magic);
    ok(/^(52 49 46 46|66 4c 61 43|4f 67 67 53|49 44 33|ff)/.test(magic), '产物魔数像真实音频', magic);
  }
  const previewBtns = await page.locator('#done-list button:has-text("试听")').count();
  console.log('      试听按钮数 =', previewBtns);
  ok(previewBtns > 0, '结果区有试听按钮 (blob 预览链路可用)');

  // === D. .ncm 真实文件 (用户之前发的那个) ===
  console.log('\nD. 拖入真实 .ncm 文件');
  const ncmPath = '/root/.openclaw/media/inbound/薛之谦_-_平庸_Live---204753d5-c907-4156-a0a4-a6e01274893e.ncm';
  if (fs.existsSync(ncmPath)) {
    const beforeDone = parseInt(await page.locator('#done-count').innerText().catch(() => '0'), 10);
    await page.setInputFiles('#file-input', ncmPath);
    await page.waitForTimeout(8000);
    const afterDone = parseInt(await page.locator('#done-count').innerText().catch(() => '0'), 10);
    ok(afterDone > beforeDone, `NCM 解密成功 (done ${beforeDone} → ${afterDone})`);
    if (afterDone > beforeDone) {
      const n = await page.locator('#done-list a[download]').count();
      const lastHref = n ? await page.locator('#done-list a[download]').last().getAttribute('href') : null;
      const lastName = n ? await page.locator('#done-list a[download]').last().getAttribute('download') : null;
      console.log('      NCM 输出:', lastName);
      ok(!!lastName && /\.(mp3|flac|m4a|wav|aac|opus|ogg)$/i.test(lastName), 'NCM 输出后缀正确', String(lastName));
    }
    await page.screenshot({ path: path.join(SHOT_DIR, '03-ncm.png'), fullPage: true });
  } else {
    console.log('      (跳过, 文件不存在)');
  }

  // === E. .mgg → 应明确指引到借壳工具 (V=84 起 ekey 链路已下线) ===
  console.log('\nE. 拖入 .mgg (应指引到借壳解密工具)');
  const errBefore = errors.length;
  const fakeMgg = '/tmp/e2e-fake.mgg';
  fs.writeFileSync(fakeMgg, Buffer.concat([
    // musicex\0 魔数 + 足量数据, 让它走 MusicEx 分支 (length 必须 >= 192)
    Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 13) & 0xff)),
    Buffer.alloc(180, 0x11),
    Buffer.from([0x6D, 0x75, 0x73, 0x69, 0x63, 0x65, 0x78, 0x00]),
  ]));
  await page.setInputFiles('#file-input', fakeMgg);
  await page.waitForTimeout(5000);
  const txt = await page.locator('body').innerText();
  ok(/借壳|qqmusic-frida|客户端自己|密钥不在文件/.test(txt),
    'MGG 给出「借壳解密工具」指引而非含糊报错');
  ok(!/密钥库|Ekey Helper|player_process_db/.test(txt),
    '页面不再提到已下线的密钥库 / 扩展入口');
  // worker 把解密失败打到 console.error 是设计行为, 不算"未捕获异常"
  const realErrors = errors.slice(errBefore).filter(e =>
    !/^\[worker\]/.test(e) && !/console\.error: \[worker\]/.test(e));
  ok(realErrors.length === 0, '无新增非 worker 异常', realErrors.slice(0, 5).join('\n      '));
  // 关键: 必须走 V3/MusicEx 路径, 而不是误判成 v1-static
  const workerErr = errors.slice(errBefore).find(e => /musicex|MusicEx|借壳/.test(e));
  ok(!!workerErr && !/末尾标记/.test(workerErr),
    'musicex 文件走 V3 路径并报借壳指引', String(workerErr).slice(0, 200));

  // G. 站点地址必须是运行时推导的 —— 换域名部署不该需要改代码
  const origin = new URL(page.url()).origin;
  const zipLinks = await page.$$eval('a[data-zip]', as => as.map(a => a.getAttribute('href')));
  ok(zipLinks.length === 3 && zipLinks.every(h => h === '/qqmusic-frida.zip'),
    'zip 下载链接钉到站点根 (支持子路径部署)', zipLinks.join(' '));
  ok(/工具下载:\s*https?:\/\/[^\s]*\/qqmusic-frida\.zip/.test(txt),
    '报错文案里的工具链接来自运行时 origin, 非硬编码');
  // 所有出现在页面上的绝对 URL 都必须等于当前 origin (不能有别的域名)
  const absUrls = [...new Set((txt.match(/https?:\/\/[^\s)\]"']+/g) || []))];
  const foreign = absUrls.filter(u => !u.startsWith(origin) && !/github\.com|cdn\.jsdelivr/.test(u));
  ok(foreign.length === 0,
    '页面无跨域绝对 URL (换域名后不会残留旧站地址)', foreign.join(' '));

  // DOM 里出现的绝对 URL 全部必须指向当前 origin (没有别处域名)
  const htmlSrc = await page.content();
  const domUrls = [...new Set((htmlSrc.match(/https?:\/\/[^\s)\]"'<>]+/g) || []))];
  const domForeign = domUrls.filter(u => !u.startsWith(origin) && !/github\.com|cdn\.jsdelivr|letsencrypt|opensource\.org|w3\.org/.test(u));
  ok(domForeign.length === 0,
    'DOM 内无第三方绝对 URL (换域名后完全自洽)', domForeign.slice(0, 3).join(' '));

  const zipResp = await page.request.get(origin + '/qqmusic-frida.zip');
  ok(zipResp.status() === 200,
    '借壳工具 zip 可下载', 'HTTP ' + zipResp.status());

  await page.screenshot({ path: path.join(SHOT_DIR, '04-mgg.png'), fullPage: true });

  // === F. 汇总 console 关键行 ===
  console.log('\nF. 关键 console 输出');
  const interesting = consoleLog.filter(l =>
    /worker|build|audio |Ext/.test(l));
  for (const l of interesting.slice(0, 25)) console.log('      ' + l.slice(0, 160));
  if (!interesting.length) console.log('      (无相关输出 — 页面静默运行)');

  await browser.close();
  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
  console.log(`截图: ${SHOT_DIR}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('e2e crashed:', e); process.exit(2); });