#!/usr/bin/env bash
# ============================================================
#  音乐解锁 — 一键安装 (纯静态站)
#
#  用法:
#     sudo ./install.sh --domain music.example.com
#     sudo ./install.sh -d music.example.com --root /srv/music --webserver nginx
#
#  说明: 本项目没有后端, 全部逻辑在浏览器里跑。
#  安装 = 拷文件 + 写 web server 配置 + (可选)申请证书。
# ============================================================
set -euo pipefail

# ---------- 默认值 ----------
DOMAIN=""
WEBROOT=""
WEBSERVER=""            # nginx / caddy / apache / none
DOCROOT="/var/www/music-unlock"
RUN_AS="www-data"
FORCE=0
NO_TLS=0
SITE_USER=""             # Apache 需要
CERTBOT=0

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'; CYA=$'\033[0;36m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { printf '%s\n' "${GRN}  ✓${RST} $*"; }
info() { printf '%s\n' "${CYA}  →${RST} $*"; }
warn() { printf '%s\n' "${YLW}  !${RST} $*"; }
die()  { printf '%s\n' "${RED}  ✗ $*${RST}" >&2; exit 1; }
hdr()  { printf '\n%s\n' "${CYA}── $* ─────────────────────────────${RST}"; }

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--domain)    DOMAIN="${2:-}"; shift 2 ;;
    -r|--root)      DOCROOT="${2:-}"; shift 2 ;;
    -w|--webserver) WEBSERVER="${2:-}"; shift 2 ;;
    -u|--user)      SITE_USER="${2:-}"; shift 2 ;;
    --no-tls)       NO_TLS=1; shift ;;
    -f|--force)     FORCE=1; shift ;;
    -h|--help)      usage ;;
    *) die "未知参数: $1  (用 --help 看用法)" ;;
  esac
done

# ---------- 环境检查 ----------
hdr "环境检查"

[[ $EUID -eq 0 ]] || die "需要 root 权限 (用 sudo 重跑)"

# Debian/Ubuntu 把 web server 装在 /usr/sbin, 默认不在 PATH 里
case ":$PATH:" in
  *":/usr/sbin:"*) ;;
  *) export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin";;
esac

if [[ -z "$DOMAIN" ]]; then
  # 交互式询问, 非交互则报错
  if [[ -t 0 ]]; then
    read -r -p "  域名 (如 music.example.com): " DOMAIN
  else
    die "缺少域名。用 --domain music.example.com 指定"
  fi
fi

# 域名合法性: 只允许字母数字点和连字符
if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  die "域名含非法字符: $DOMAIN"
fi

info "域名      = $DOMAIN"

# 定位源码目录 (脚本所在处)
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SRC/index.html" ]] || die "在 $SRC 找不到 index.html — 这不是项目根目录"
info "源码目录  = $SRC"

# ---------- 自动探测 web server ----------
if [[ -z "$WEBSERVER" ]]; then
  for c in nginx caddy apache2 httpd; do
    if command -v "$c" >/dev/null 2>&1; then WEBSERVER="$c"; break; fi
  done
  WEBSERVER="${WEBSERVER:-none}"
fi
info "Web 服务器= $WEBSERVER"

# ---------- 复制文件 ----------
hdr "部署文件"

mkdir -p "$DOCROOT"

# 要拷贝的内容 — 前端静态资源
ITEMS=(index.html assets modules qqmusic-frida.zip)

# 清理上一版残留 (只删我们自己放的目录)
if [[ $FORCE -eq 1 ]]; then
  warn "--force: 清理 $DOCROOT 里的旧 assets/ modules/"
  rm -rf "${DOCROOT:?}/assets" "${DOCROOT:?}/modules"
fi

for it in "${ITEMS[@]}"; do
  [[ -e "$SRC/$it" ]] || die "源码里缺少: $it"
done

for it in "${ITEMS[@]}"; do
  cp -r "$SRC/$it" "$DOCROOT/"
  ok "$it"
done

# 权限
if id "$RUN_AS" >/dev/null 2>&1; then
  chown -R "$RUN_AS:$RUN_AS" "$DOCROOT" 2>/dev/null || true
fi
chmod -R a+rX "$DOCROOT"
ok "权限已设置 ($(stat -c '%A %U:%G' "$DOCROOT"))"

# ---------- 写配置 ----------
hdr "配置 $WEBSERVER"

CONF_WROTE=""
TLS_SCHEME="s"       # 有证书用 https; --no-tls 时置空

case "$WEBSERVER" in
nginx)
    command -v nginx >/dev/null 2>&1 || die "未安装 nginx"
    CONF_DIR=""
    for d in /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/sites-available; do
      [[ -d "$d" ]] && { CONF_DIR="$d"; break; }
    done
    [[ -n "$CONF_DIR" ]] || die "找不到 nginx 配置目录"
    CONF="${CONF_DIR}/music-unlock-${DOMAIN}.conf"
    [[ -f "$CONF" ]] && { [[ $FORCE -eq 1 ]] || die "$CONF 已存在 (用 --force 覆盖)"; }

    # http2 语法分两代: nginx >= 1.25.1 用 `http2 on;`, 更早的用 `listen ... http2`
    LISTEN_SSL_EXTRA=""
    HTTP2_LINE=""
    NGINX_VER="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    if [[ -n "${NGINX_VER:-}" ]]; then
      info "nginx 版本 $NGINX_VER"
      _maj="${NGINX_VER%%.*}"; _rest="${NGINX_VER#*.}"; _min="${_rest%%.*}"
      if (( _maj > 1 )) || (( _maj == 1 && _min >= 25 )); then
        HTTP2_LINE="    http2 on;"
      else
        LISTEN_SSL_EXTRA=" http2"
      fi
    else
      LISTEN_SSL_EXTRA=" http2"
      warn "读不到 nginx 版本, 用兼容写法"
    fi

    # CSP 是关键: worker-src / script-src 决定 worker 里的 importScripts 能不能跑
    # ⚠ nginx 语义坑: 只要 location 里出现了任何一个 add_header,
    #   server 级的所有 add_header 都会被**丢弃**(不是合并)。
    #   所以每个 location 都必须自己重复一遍 CSP, 否则子路径下 CSP 失效 → 页面白屏。
    # 无任何外部 CDN 依赖: jszip 等库都已本地化, 所以 script-src 不用放开第三方
    CSP="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'self'; form-action 'self'"

    if [[ $NO_TLS -eq 1 ]]; then
      # 没证书时绝不能引 ssl_certificate — nginx 会因找不到 pem 直接起不来
      cat > "$CONF" <<NGINXCONF
# 音乐解锁 — 由 install.sh 于 $(date +%Y-%m-%d) 生成 (HTTP, 未启用 TLS)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $DOCROOT;
    index index.html;

    add_header Content-Security-Policy "$CSP" always;
    add_header X-Content-Type-Options "nosniff" always;

    location ~* \.(html|js|css)\$ {
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Cache-Control "no-cache, must-revalidate";
        try_files \$uri =404;
    }
    location ~* \.(mp3|flac|ogg|wav|m4a|png|jpg|svg|woff2?|ico|zip)\$ {
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Cache-Control "public, max-age=2592000";
        try_files \$uri =404;
    }
    location = /qqmusic-frida.zip {
        default_type application/zip;
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Disposition "attachment; filename=\"qqmusic-frida.zip\"";
    }
    location / {
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        try_files \$uri \$uri/ =404;
    }
}
NGINXCONF
      ok "已写 $CONF (HTTP 模式, 未启用 TLS)"
      TLS_SCHEME=""
    else
      cat > "$CONF" <<NGINXCONF
# 音乐解锁 — 由 install.sh 于 $(date +%Y-%m-%d) 生成
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $DOCROOT;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl${LISTEN_SSL_EXTRA};
    listen [::]:443 ssl${LISTEN_SSL_EXTRA};
$HTTP2_LINE
    server_name $DOMAIN;

    root $DOCROOT;
    index index.html;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Content-Security-Policy "$CSP" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # HTML/JS/CSS 不缓存 (改了立刻生效); 媒体和 zip 长缓存
    location ~* \.(html|js|css)\$ {
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Cache-Control "no-cache, must-revalidate";
        try_files \$uri =404;
    }
    location ~* \.(mp3|flac|ogg|wav|m4a|png|jpg|svg|woff2?|ico|zip)\$ {
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Cache-Control "public, max-age=2592000";
        try_files \$uri =404;
    }
    location = /qqmusic-frida.zip {
        default_type application/zip;
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Content-Disposition "attachment; filename=\"qqmusic-frida.zip\"";
    }
    location / {
        add_header Content-Security-Policy "$CSP" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        try_files \$uri \$uri/ =404;
    }
}
NGINXCONF
      ok "已写 $CONF"

      if command -v certbot >/dev/null 2>&1; then
        info "检测到 certbot, 尝试申请证书"
        if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
             --register-unsafely-without-email --redirect 2>&1 | tail -5; then
          ok "证书已申请"
        else
          warn "certbot 失败 — 配置已写好但 nginx 会因缺证书起不来"
          warn "手工补证书后重跑:  certbot --nginx -d $DOMAIN"
        fi
      else
        warn "未安装 certbot — 配置引用了 /etc/letsencrypt/live/$DOMAIN/"
        warn "装 certbot 后重跑本脚本, 或手工放证书到该路径"
      fi
    fi

    info "校验并重载 nginx"
    nginx -t
    # reload 对一个"装了但没启动"的 nginx 是无效的 (云镜像 / 容器很常见),
    # 而且 reload 失败时 systemctl 可能仍返回 0, 后面那个 || 就不触发了。
    # 统一 enable + restart: 保证一定在跑, 重启机器后也会自动拉起。
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl restart nginx
    systemctl is-active --quiet nginx || die "nginx 启动失败"
    ok "nginx 已重启并确认在运行"
    CONF_WROTE="$CONF"
    ;;

  caddy)
    command -v caddy >/dev/null 2>&1 || die "未安装 caddy"
    CONF=/etc/caddy/Caddyfile
    [[ -f "$CONF" ]] || die "找不到 $CONF"
    # ⚠ nginx 语义坑: 只要 location 里出现了任何一个 add_header,
    #   server 级的所有 add_header 都会被**丢弃**(不是合并)。
    #   所以每个 location 都必须自己重复一遍 CSP, 否则子路径下 CSP 失效 → 页面白屏。
    # 无任何外部 CDN 依赖: jszip 等库都已本地化, 所以 script-src 不用放开第三方
    CSP="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'self'; form-action 'self'"
    if grep -qE "^[[:space:]]*${DOMAIN//./\\.}[[:space:]]*\{" "$CONF"; then
      warn "Caddyfile 里已有 $DOMAIN 的配置块, 跳过写入"
    else
      cat >> "$CONF" <<CADDY

$DOMAIN {
    root $DOCROOT
    file_server
    encode gzip
    header {
        Content-Security-Policy "$CSP"
        X-Content-Type-Options "nosniff"
    }
    header /qqmusic-frida.zip Content-Disposition "attachment"
}
CADDY
      ok "已追加到 $CONF"
      caddy validate --config "$CONF"
      systemctl reload caddy
      ok "caddy 已重载 (证书自动签发, 稍等 30 秒)"
    fi
    CONF_WROTE="$CONF"
    ;;

  apache2|apache|httpd)
    command -v "$WEBSERVER" >/dev/null 2>&1 || die "未安装 $WEBSERVER"
    AP="/etc/apache2/sites-available"
    [[ -d "$AP" ]] || AP="/etc/httpd/conf.d"
    [[ -d "$AP" ]] || die "找不到 apache 配置目录"
    CONF="${AP}/music-unlock-${DOMAIN}.conf"
    if [[ $FORCE -eq 1 ]]; then rm -f "$CONF"; fi

    [[ -n "$SITE_USER" ]] || SITE_USER="$RUN_AS"
    # ⚠ nginx 语义坑: 只要 location 里出现了任何一个 add_header,
    #   server 级的所有 add_header 都会被**丢弃**(不是合并)。
    #   所以每个 location 都必须自己重复一遍 CSP, 否则子路径下 CSP 失效 → 页面白屏。
    # 无任何外部 CDN 依赖: jszip 等库都已本地化, 所以 script-src 不用放开第三方
    CSP="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'self'; form-action 'self'"
    cat > "$CONF" <<APCONF
# 音乐解锁 — 由 install.sh 于 $(date +%Y-%m-%d) 生成
<VirtualHost *:80>
    ServerName $DOMAIN
    DocumentRoot $DOCROOT

    <Directory $DOCROOT>
        Options -Indexes +FollowSymLinks
        AllowOverride None
        Require all granted
    </Directory>

    # Web Worker 需要这些头, 缺了整个站会白屏
    <IfModule mod_headers.c>
        Header always set Content-Security-Policy "$CSP"
        Header always set X-Content-Type-Options "nosniff"
    </IfModule>

    ErrorLog \${APACHE_LOG_DIR}/music-unlock-error.log
    CustomLog \${APACHE_LOG_DIR}/music-unlock-access.log combined
</VirtualHost>
APCONF
    ok "已写 $CONF"

    if command -v a2ensite >/dev/null 2>&1; then
      a2ensite "music-unlock-${DOMAIN}" >/dev/null && ok "站点已 enable"
    fi
    systemctl reload "$WEBSERVER" || systemctl restart "$WEBSERVER"
    ok "$WEBSERVER 已重载"
    warn "Apache 未自动配 HTTPS — 建议: certbot --apache -d $DOMAIN"
    CONF_WROTE="$CONF"
    ;;

  none)
    TLS_SCHEME=""
    warn "未检测到 web server — 只拷了文件, 请手工配置"
    warn "务必带上 CSP 头 (worker-src 'self' blob:), 否则页面会白屏"
    ;;
esac
# ---------- 自检 ----------
hdr "自检"

fail=0
chk() {
  if eval "$2" >/dev/null 2>&1; then ok "$1"; else warn "$1 (未通过)"; fail=$((fail+1)); fi
}
chk "index.html 已部署"      "test -f '$DOCROOT/index.html'"
chk "assets/ 已部署"         "test -d '$DOCROOT/assets'"
chk "modules/ 已部署"        "test -d '$DOCROOT/modules'"
chk "借壳解密 zip 已部署"    "test -f '$DOCROOT/qqmusic-frida.zip'"
chk "worker 依赖的模块齐全"  "grep -q 'qmc.js' '$DOCROOT/assets/js/worker.js'"
chk "代码里没有残留旧域名"   "! grep -rq 'ncm\.byberg\.store' '$DOCROOT/index.html' '$DOCROOT/assets' '$DOCROOT/modules' 2>/dev/null"

if [[ $fail -gt 0 ]]; then
  warn "$fail 项自检未通过, 请人工确认后再上线"
fi

# ---------- 完成 ----------
hdr "安装完成"

cat <<DONE
  站点地址   http${TLS_SCHEME}://$DOMAIN
  文件目录   $DOCROOT
  配置文件   ${CONF_WROTE:-(未写 — 纯文件部署, 需手工配 web server)}
  Web 服务器 $WEBSERVER

  验证步骤:
    1) DNS 指向本机了吗      dig +short $DOMAIN
    2) 打开站点               拖一个 .ncm 或 .ogg 进去, 应出 MP3
    3) 拖 .mgg / .mflac       应提示用「借壳解密工具」(页面里可下载)

  出问题先看这三条:
    · 页面完全空白  → CSP 挡住了 worker。配置里必须有
                      worker-src 'self' blob: 且 script-src 含 'self'
    · 提示"不安全" → 必须 HTTPS。浏览器不给 http 页面装 worker 模块
    · 404          → docroot 指错, 或用了 SPA fallback (检查返回的是不是首页)

  卸载:  ./uninstall.sh --domain $DOMAIN
DONE
