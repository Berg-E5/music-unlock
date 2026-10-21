#!/usr/bin/env bash
# ============================================================
#  音乐解锁 — 卸载
#
#  用法:
#     sudo ./uninstall.sh --domain music.example.com
#     sudo ./uninstall.sh -d music.example.com --purge   # 连文件一起删
# ============================================================
set -euo pipefail

DOMAIN=""
DOCROOT="/var/www/music-unlock"
PURGE=0
FORCE=0

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'; CYA=$'\033[0;36m'; RST=$'\033[0m'
ok()   { printf '%s\n' "${GRN}  ✓${RST} $*"; }
info() { printf '%s\n' "${CYA}  →${RST} $*"; }
warn() { printf '%s\n' "${YLW}  !${RST} $*"; }
die()  { printf '%s\n' "${RED}  ✗ $*${RST}" >&2; exit 1; }
hdr()  { printf '\n%s\n' "${CYA}── $* ─────────────────────────────${RST}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--domain) DOMAIN="${2:-}"; shift 2 ;;
    -r|--root)   DOCROOT="${2:-}"; shift 2 ;;
    --purge)     PURGE=1; shift ;;
    -f|--force)  FORCE=1; shift ;;
    -h|--help)   sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "需要 root 权限"

# Debian/Ubuntu 把 web server 装在 /usr/sbin
case ":$PATH:" in
  *":/usr/sbin:"*) ;;
  *) export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin";;
esac

[[ -n "$DOMAIN" ]] || die "缺少域名。用 --domain 指定"

hdr "卸载 $DOMAIN"

# ---------- 移除站点配置 ----------
removed_conf=0
for dir in /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/apache2/sites-enabled /etc/httpd/conf.d; do
  for f in "$dir/music-unlock-${DOMAIN}.conf" "$dir/music-unlock-${DOMAIN}.conf"; do
    if [[ -f "$f" ]]; then
      rm -f "$f" && ok "已删 $f" && removed_conf=1
    fi
  done
  if [[ -d "$dir" ]]; then
    # apache 的 sites-enabled 是软链
    find "$dir" -maxdepth 1 -name "music-unlock-${DOMAIN}.conf" 2>/dev/null | while read -r l; do
      rm -f "$l" && ok "已删 $l" && removed_conf=1
    done
  fi
done

if [[ $removed_conf -eq 1 ]]; then
  for svc in nginx apache2 httpd caddy; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
      case "$svc" in
        nginx) nginx -t >/dev/null 2>&1 && systemctl reload nginx && ok "nginx 已重载" \
                 || { warn "nginx 配置校验失败, 未重载 (请手动 nginx -t)"; } ;;
        *)     systemctl reload "$svc" && ok "$svc 已重载" ;;
      esac
    fi
  done
else
  info "没找到站点配置文件 (可能本来就没装)"
fi

# ---------- Caddyfile 清理 ----------
CADDYFILE=/etc/caddy/Caddyfile
if [[ -f "$CADDYFILE" ]] && grep -q "^[[:space:]]*${DOMAIN}[[:space:]]*{" "$CADDYFILE"; then
  warn "Caddyfile 里有 $DOMAIN 的手工配置块, 请自行删除:"
  grep -n -A20 "^[[:space:]]*${DOMAIN}[[:space:]]*{" "$CADDYFILE" | head -25
fi

# ---------- 证书 ----------
if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  if command -v certbot >/dev/null 2>&1; then
    if [[ $FORCE -eq 1 ]]; then
      certbot delete --cert-name "$DOMAIN" --non-interactive >/dev/null 2>&1 \
        && ok "证书已吊销" || warn "证书吊销失败"
    else
      info "证书还在: /etc/letsencrypt/live/$DOMAIN  (要吊销加 --force)"
    fi
  fi
fi

# ---------- 文件 ----------
if [[ $PURGE -eq 1 ]]; then
  # 安全检查: 只删我们自己建的目录
  case "$DOCROOT" in
    /var/www/*|/srv/*|/opt/*) ;;
    *) die "拒绝删除非标准路径: $DOCROOT" ;;
  esac
  if [[ -d "$DOCROOT" ]]; then
    rm -rf "${DOCROOT:?}"
    ok "已删除 $DOCROOT"
  else
    info "$DOCROOT 不存在"
  fi
else
  info "文件保留在 $DOCROOT (要删加 --purge)"
fi

hdr "卸载完成"
cat <<DONE
  已移除: 站点配置 + (可选) 证书 + (可选) 文件
  剩下:   DNS 记录仍指向本机的话, 访问会 404 或打到默认站点
          建议去 DNS 服务商删掉 $DOMAIN 的 A/AAAA 记录
DONE