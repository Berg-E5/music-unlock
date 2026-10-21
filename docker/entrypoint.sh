#!/bin/sh
# ============================================================
#  容器入口 — 依据证书是否存在决定 HTTP 还是 HTTPS
#
#  为什么不用纯 envsubst:
#    nginx 模板里没法写条件块 (listen ssl on/off、ssl_certificate 有没有)。
#    所以这里在启动时判断证书文件, 拼出最终配置。
# ============================================================
set -e

TEMPLATE=/etc/nginx/templates/default.conf.template
OUT=/etc/nginx/conf.d/default.conf
CONF_DIR=/etc/nginx/conf.d

SERVER_NAME="${SERVER_NAME:-localhost}"
LISTEN_PORT="${LISTEN_PORT:-8080}"
CSP="${CSP:-default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'self'; form-action 'self'}"

TLS_CERT="${TLS_CERT:-}"
TLS_KEY="${TLS_KEY:-}"

# 先删掉 entrypoint 可能生成的半成品, 避免重复 server 块
rm -f "$OUT"

if [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ] && [ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ]; then
  echo "[entrypoint] 检测到证书 → 启用 HTTPS ($TLS_CERT)"
  TLS_BLOCK="listen ${LISTEN_PORT} ssl;
    listen [::]:${LISTEN_PORT} ssl;
    ssl_certificate     ${TLS_CERT};
    ssl_certificate_key ${TLS_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    # HTTP 跳转 HTTPS
    error_page 497 https://\$host:\$server_port\$request_uri;"
else
  if [ -n "$TLS_CERT" ]; then
    echo "[entrypoint] ! 指定了证书但文件不存在, 降级为 HTTP"
    echo "[entrypoint]   期待: $TLS_CERT"
  fi
  echo "[entrypoint] HTTP 模式 → http://\$host:$LISTEN_PORT"
  TLS_BLOCK="listen ${LISTEN_PORT};
    listen [::]:${LISTEN_PORT};"
fi

# envsubst 只替换我们指定的变量, nginx 内置变量 ($uri/$host) 原样保留
export SERVER_NAME LISTEN_PORT CSP TLS_BLOCK

envsubst '${SERVER_NAME} ${LISTEN_PORT} ${CSP} ${TLS_BLOCK}' \
  < "$TEMPLATE" > "$OUT"

echo "[entrypoint] 配置已生成: $OUT"

# nginx 自检 — 配置写错的话在这里就炸, 而不是等到容器起不来
nginx -t

exec nginx -g 'daemon off;'