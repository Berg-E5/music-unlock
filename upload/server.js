#!/usr/bin/env node
// 音乐解密软件安装包上传端点
//
// 用途: Berg 把本地的音乐解密软件安装包传上来, 供 REA 逆向分析。
// 设计:
//   - 一次性 token 认证, 用完即焚
//   - 只接受单一文件, 限制大小 (默认 200MB)
//   - 落在 /var/lib/ncm-upload/inbox, 该目录不在 nginx 静态根下, 不可直接访问
//   - 文件名做白名单清洗, 拒绝路径穿越
//   - 上传完回一个 sha256, 方便确认完整性

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 18100);
const INBOX = process.env.NCM_UPLOAD_INBOX || '/var/lib/ncm-upload/inbox';
const TOKEN_FILE = process.env.NCM_UPLOAD_TOKEN_FILE || '/root/.ncm_upload_token';
const MAX_BYTES = Number(process.env.NCM_UPLOAD_MAX_BYTES || 200 * 1024 * 1024);

// 允许的扩展名 —— 安装包常见形态
const ALLOWED_EXT = new Set([
  '.exe', '.msi', '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz',
  '.dmg', '.pkg', '.apk', '.appimage', '.deb', '.rpm', '.jar', '.war',
  '.bin', '.dat', '.pak',
]);

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

// 清洗文件名: 只保留 basename, 去掉路径分隔符和控制字符
function sanitizeFilename(raw) {
  const base = path.basename(String(raw || '').replace(/\\/g, '/'));
  // 去掉控制字符和路径分隔符, 保留可读性
  const cleaned = base.replace(/[\x00-\x1f\x7f/]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 200);
}

function extAllowed(name) {
  const e = path.extname(name).toLowerCase();
  if (!e) return true; // 无扩展名也放行, 后面再由人工判断
  return ALLOWED_EXT.has(e);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathOnly = url.pathname;

  // 健康检查
  if (req.method === 'GET' && pathOnly === '/health') {
    return json(res, 200, { ok: true, tokenPresent: !!readToken() });
  }

  if (req.method !== 'POST' || pathOnly !== '/upload') {
    return json(res, 404, { error: 'not found' });
  }

  // ── 认证 ──
  const expect = readToken();
  if (!expect) {
    // 令牌是「用完即焚」: 收完一个文件就被删掉, 所以文件不存在是常态。
    // 旧提示写 "token not configured on server", 看不出是没用过还是已过期。
    console.warn(`[${new Date().toISOString()}] 令牌缺失 (未签发或已用过), 拒绝上传`);
    return json(res, 503, {
      error: 'no active token',
      hint: '令牌用完即焚。在服务器上跑 /opt/ncm-upload/new-token.sh 重新签发。'
    });
  }
  const got =
    req.headers['x-upload-token'] ||
    url.searchParams.get('token') ||
    '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(expect);
  const tokenOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!tokenOk) {
    console.warn(`[${new Date().toISOString()}] 拒绝: token 不匹配 from ${req.socket.remoteAddress}`);
    return json(res, 401, { error: 'bad token' });
  }

  // ── 请求头校验 ──
  const lenHeader = req.headers['content-length'];
  if (!lenHeader) {
    return json(res, 411, { error: 'content-length required' });
  }
  const total = Number(lenHeader);
  if (!Number.isFinite(total) || total <= 0) {
    return json(res, 400, { error: 'empty body' });
  }
  if (total > MAX_BYTES) {
    return json(res, 413, { error: `too large: ${total} > ${MAX_BYTES}` });
  }

  const rawName = decodeURIComponent(url.searchParams.get('name') || '');
  const filename = sanitizeFilename(rawName);
  if (!filename) {
    return json(res, 400, { error: 'bad filename' });
  }
  if (!extAllowed(filename)) {
    return json(res, 415, { error: `extension not allowed: ${path.extname(filename)}` });
  }

  // 落盘: 同一目录, 文件名加时间戳前缀避免覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalName = `${stamp}__${filename}`;
  const dest = path.join(INBOX, finalName);

  const hash = crypto.createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(dest, { mode: 0o600 });

  let aborted = false;
  const fail = (code, msg) => {
    if (aborted) return;
    aborted = true;
    console.warn(`[${new Date().toISOString()}] 上传失败: ${msg}`);
    try { out.destroy(); } catch (e) {}
    try { fs.unlinkSync(dest); } catch (e) {}
    json(res, code, { error: msg });
  };

  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BYTES) {
      fail(413, 'body exceeds limit');
      req.destroy();
      return;
    }
    hash.update(chunk);
  });

  req.on('error', (e) => fail(400, `stream error: ${e.message}`));

  req.pipe(out);

  out.on('error', (e) => fail(500, `write error: ${e.message}`));

  out.on('close', () => {
    if (aborted) return;
    if (received !== total) {
      fail(400, `size mismatch: got ${received}, expected ${total}`);
      return;
    }
    const sha256 = hash.digest('hex');
    console.log(`[${new Date().toISOString()}] 收到 ${finalName} (${received} bytes) sha256=${sha256}`);
    // token 一次性: 用完即焚
    try { fs.unlinkSync(TOKEN_FILE); } catch (e) {}
    json(res, 200, {
      ok: true,
      filename: finalName,
      bytes: received,
      sha256,
      storedAt: dest,
      tokenConsumed: true,
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ncm-upload listening on http://127.0.0.1:${PORT} (max ${MAX_BYTES} bytes)`);
  console.log(readToken()
    ? '令牌已就绪'
    : '当前无有效令牌 (用完即焚)。签发: /opt/ncm-upload/new-token.sh');
});
