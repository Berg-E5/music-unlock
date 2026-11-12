# 音乐解锁

浏览器里跑的加密音乐解锁工具。**纯静态站，零后端** —— 所有解密逻辑都在
浏览器的 Web Worker 里执行，文件不上传、不经过任何服务器。

```
拖入 .ncm  →  本地解密 + 转 MP3  →  直接下载
```

---

## 快速开始

**Docker（推荐）**

```bash
docker run -d -p 8080:8080 ghcr.io/YOUR_USER/music-unlock:latest
```

**或者直接放服务器上**

```bash
sudo ./install.sh --domain music.example.com
```

脚本会拷贝文件、写 web server 配置、申请证书、重载服务。
自动识别 nginx / caddy / apache，没有就只拷文件（可后续手工配）。

装完打开 `https://music.example.com` 即可。

> 两种方式部署的是同一份代码。选 Docker 想要可移植、选脚本想要跟宿主机
> nginx 集成（比如同一端口挂多个站）。

---

## 支持的格式

### 能直接解（密钥在文件内）

| 平台 | 后缀 |
|---|---|
| 网易云音乐 | `.ncm` |
| QQ 音乐 v1/v2 | `.qmc0 .qmc1 .qmc2 .qmc3 .qmc4 .qmc6 .qmc8 .qmcflac .qmcogg .tkm` |
| 酷我 | `.bkcmp3 .bkcm4a .bkcflac .bkcogg` |

支持双后缀（`.mgg.flac` 这类），会自动剥离。

### 能转码（已是明文音频）

`.mp3` `.flac` `.ogg` `.wav` `.m4a` `.aac` `.opus` `.ape` → **MP3**

码率可选 128/192/256/320 kbps。已是 MP3 的原样放行，不重新编码（避免白白掉音质）。

### 不能在网页端解

`.mgg` `.mflac` `.mqmc` 等 MusicEx/V3 格式 —— **密钥不在文件里**，浏览器拿不到。
这类文件会明确提示改用「借壳解密工具」（页面里可下载），在你自己的 Windows 电脑上
挂载已登录的 QQ 音乐客户端完成解密，再把结果拖回本页转格式。

---

## Docker 部署

### 方式一：docker run（最快）

```bash
docker run -d \
  --name music-unlock \
  -p 8080:8080 \
  --restart unless-stopped \
  --memory 512m \
  ghcr.io/YOUR_USER/music-unlock:latest

# 打开 http://localhost:8080
```

### 方式二：docker compose（推荐）

```bash
git clone https://github.com/YOUR_USER/music-unlock.git
cd music-unlock
docker compose up -d
```

改端口 / 域名：

```bash
HOST_PORT=9000 SERVER_NAME=music.example.com docker compose up -d
```

写入 `.env` 更方便：

```bash
cat > .env <<EOF
HOST_PORT=8080
SERVER_NAME=music.example.com
EOF
docker compose up -d
```

### 方式三：本地构建

```bash
git clone https://github.com/YOUR_USER/music-unlock.git
cd music-unlock
docker build -t music-unlock .
docker run -d -p 8080:8080 music-unlock
```

### HTTPS（自动证书）

```bash
SERVER_NAME=music.example.com \
CERTBOT_EMAIL=you@example.com \
docker compose --profile tls up -d
```

certbot 会自动申请并每 12 小时检查续期。挂载证书后容器自动切到 HTTPS 模式。

也可以挂自己的证书：

```bash
docker run -d -p 443:8443 \
  -v /path/to/fullchain.pem:/etc/nginx/certs/fullchain.pem:ro \
  -v /path/to/privkey.pem:/etc/nginx/certs/privkey.pem:ro \
  -e SERVER_NAME=music.example.com \
  -e LISTEN_PORT=8443 \
  -e TLS_CERT=/etc/nginx/certs/fullchain.pem \
  -e TLS_KEY=/etc/nginx/certs/privkey.pem \
  music-unlock
```

### 运维

```bash
docker logs -f music-unlock          # 看日志
docker exec -it music-unlock nginx -t   # 检查配置语法
docker inspect --format='{{.State.Health.Status}}' music-unlock  # 健康状态
docker restart music-unlock          # 重启
docker stop music-unlock && docker rm music-unlock   # 卸载
```

容器是 `read-only` 的（纯静态站不需要写盘），只开了 `/tmp`、`/var/cache/nginx`、`/var/run`
三个 tmpfs。改配置重新 build 即可。

### 为什么不用 Docker Express / Node 后端

这个项目**没有后端**。解密在浏览器的 Web Worker 里完成，文件从不离开用户机器。
Docker 镜像里只有一个 nginx 负责发静态文件——镜像小、攻击面为零、无依赖升级负担。

---

---

## 安装参数

```
-d, --domain     域名（必填）
-r, --root       文件目录（默认 /var/www/music-unlock）
-w, --webserver  nginx / caddy / apache2 / none（默认自动探测）
-u, --user       Apache 专用：站点用户（默认 www-data）
    --no-tls     跳过 HTTPS，只出 HTTP 配置（调试用）
-f, --force      覆盖已有配置 + 清理旧文件
-h, --help       帮助
```

**多站点**：`install.sh` 是按「一个目录一套配置」设计的，装多个域名就换 `--root` 再跑一次。

```bash
sudo ./install.sh -d a.example.com -r /var/www/music-a
sudo ./install.sh -d b.example.com -r /var/www/music-b
```

---

## 卸载

```bash
sudo ./uninstall.sh --domain music.example.com           # 删配置，留文件
sudo ./uninstall.sh --domain music.example.com --purge  # 连文件一起删
sudo ./uninstall.sh --domain music.example.com --force   # 连证书一起吊销
```

---

## 部署要点

### 必须 HTTPS

浏览器的安全策略：**http 页面不能给 Worker 装 `importScripts` 模块**。
生产环境一定上 HTTPS，install.sh 默认会调 certbot。

### CSP 是硬约束

生成的配置里有这段，**不能改掉**：

```
worker-src 'self' blob:;
script-src 'self' 'unsafe-inline' blob:;
```

少了 `worker-src`，页面会**完全空白**（Worker 创建失败，控制台报
`Refused to create a worker from 'blob:'`）。

### 缓存

HTML/JS/CSS 走 `no-cache`（改动即时生效），媒体和 zip 走 30 天长缓存。
改完代码不用改版本号，不用教用户清缓存。

---

## 排错

**页面完全空白**

```bash
# 1. 看浏览器控制台, 找 Worker 相关报错
# 2. 确认 CSP 里 worker-src 有 'self'
curl -sI https://your.domain/ | grep -i content-security-policy
```

**提示"不安全" / Worker 起不来**

还在用 HTTP。检查证书是否生效：`curl -sI https://your.domain/ | head -1`

**404 但 curl 返回 200**

你的 web server 配了 SPA fallback（`try_files $uri /index.html`）。
200 可能返回的是首页而不是真文件。确认一下：

```bash
curl -s https://your.domain/modules/qmc.js | head -1
```

真实静态站应该用 `try_files $uri $uri/ =404`（install.sh 已经这么写）。

**拖入文件没反应**

- 看控制台有无 CORS / CSP 报错
- 确认 `modules/` 下文件完整（`ls /var/www/music-unlock/modules`）
- 文件超过几百 MB 时浏览器可能内存不足，失败会在进度条上显示

**nginx reload 报 protocol options redefined**

同端口有多个 server 块重复声明 `http2`。不是致命错，加个 `-w none` 装，
然后手工合并配置。

---

## 目录结构

```
music-unlock/
├── install.sh            一键安装（裸机部署）
├── uninstall.sh          卸载
├── Dockerfile            容器镜像（两阶段：node 校验 → nginx 运行）
├── docker-compose.yml    Compose 部署（含可选 TLS profile）
├── docker/
│   ├── nginx.conf.template   站点配置模板（含 CSP）
│   ├── entrypoint.sh         按证书存在与否选 HTTP/HTTPS
│   └── verify.sh             构建期自检（本地也能跑）
├── .github/workflows/ci.yml  CI：自检 → 构建 → 起容器 → 冒烟 → 推镜像
├── pack.py               打包成发布用 zip
├── index.html            主页面
├── assets/
│   ├── js/app.js         UI 逻辑（拖拽 / 队列 / 下载 / 试听）
│   ├── js/worker.js      Worker：调度 + 转码 (lamejs)
│   └── css/style.css
├── modules/              解密算法（被 worker importScripts 加载）
│   ├── ncm.js            网易云
│   ├── qmc.js            QQ 音乐路由 + STag/V3 指引
│   ├── qmc-mobile.js     QQ 音乐 mobile cipher
│   ├── kgm.js            酷狗
│   ├── aes-js.js         AES 底层
│   ├── crypto-utils.js   密钥派生
│   ├── metadata.js       封面 / 歌词 / 标签
│   ├── deflac.js         FLAC 辅助
│   └── lame.min.js       MP3 编码器
└── qqmusic-frida.zip     借壳解密工具（下载给用户，不参与服务端运行）
```

---

## 隐私

**文件不上传。** 解密在浏览器 Web Worker 里完成，文件只经过 `File.arrayBuffer()`，
never 发任何网络请求。整个站没有后端，没有数据库，没有日志收集。

可以断网验证：开发者工具 → Network 面板 → 拖个 `.ncm` 进去 → 面板全空。

---

## 公开仓库的边界

这个仓库是**公开**的，但里面**不含**解密测试向量。原因很实在：

| 文件类型 | 内容 | 为什么不能公开 |
|---|---|---|
| `test/xval-vectors/*.bin` | 真实 QQ 音乐**密文** | 受版权保护的音频数据 |
| `test/xval-vectors/expected/*.plain` | **解密后的明文音频** | 同上 |
| `test/xval-vectors/*.ekey.txt` | **有效 ekey 票据** | 绑定用户账号，别人拿去能用 |
| `test/xval-vectors/*.mgg` / `*.ncm` | 原始测试音频 | 同上 |

所以仓库里只保留 `make_*.py` 这些**生成脚本**，向量本地重新生成：

```bash
cd test/xval-vectors
python3 make_v3_real.py      # 需要本机有原始 .mgg 文件
python3 make_v3.py
python3 make_derived.py
```

`.gitignore` 里已经排除了这些文件。**如果你手滑把它们加进暂存区，提交前会被
服务器上的 pre-push 钩子拦下来**（见下）。

### 从完整仓库推到这个公开仓库

服务器上的 `/root/projects/music-unlock` 保留着**完整历史**（含测试向量），
GitHub 上是**剥离过的公开版**。两者 commit SHA 不同 —— 内容一样，但历史不同。

所以**不要**直接在服务器上 `git push --force`：

```bash
# ❌ 会把测试向量一起推上去
cd /root/projects/music-unlock && git push --force origin main

# ✅ 先剥掉敏感文件, 再推
cd /root/projects/music-unlock
git filter-branch -f --index-filter \
  'git rm --cached --ignore-unmatch -q -- \
   test/xval-vectors/*.bin \
   test/xval-vectors/*.ekey.txt \
   test/xval-vectors/ekey-*.txt \
   test/xval-vectors/expected/*.plain' \
  --prune-empty -- --all
# 别忘了清 refs/original/, 否则旧 commit 还在:
git for-each-ref --format='%(refname)' refs/original/ | xargs -n1 git update-ref -d
rm -rf .git/refs/original
git reflog expire --expire=now --all && git gc --prune=now
```

### pre-push 钩子

服务器上 `/root/projects/music-unlock/.git/hooks/pre-push` 会检查这次推送里
有没有敏感文件，有就中止并列出具体路径：

```
✗ 推送被拒绝: 检测到 3 个不可分发的文件
    test/xval-vectors/dv-rc4.bin
    test/xval-vectors/dv-rc4.ekey.txt
  这些是真实音乐密文/明文和有效 ekey 票据, 不能进公开仓库。
  先用 filter-branch 剥掉, 或者 git rm --cached 后再推。
```

**注意**：钩子只在服务器上装（属于 `.git/hooks/`，不进仓库）。别人 clone
这个公开仓库是干净的。

---

## 来源与致谢

- 解密算法经多个公开逆向实现交叉验证
- QQ 音乐借壳工具基于 yllhwa/decrypt-mflac-frida、ericjuice/music-decryptor
  的思路重构
- 算法部分参考 mzj3920/qqmusic-decrypt、cuizzzzzzzz/qqmusic-music-decrypt-algorithm

本项目仅供个人学习与离线备份自己合法拥有的音乐使用。