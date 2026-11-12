#!/usr/bin/env bash
# ============================================================
#  签发一次性上传令牌
#
#  ncm-upload 的令牌是「用完即焚」设计: 服务端收完一个文件就把
#  令牌文件删掉。所以令牌不存在不是故障, 是正常状态 —— 但报错
#  信息写的是 "token not configured on server", 看不出是哪个意思。
#
#  用法:
#      /opt/ncm-upload/new-token.sh
#  输出令牌, 直接粘到 https://ncm.byberg.store/upload.html
# ============================================================
set -euo pipefail

TOKEN_FILE="${NCM_UPLOAD_TOKEN_FILE:-/root/.ncm_upload_token}"
INBOX="${NCM_UPLOAD_INBOX:-/var/lib/ncm-upload/inbox}"

if [[ ! -d "$INBOX" ]]; then
  mkdir -p "$INBOX"
  chmod 700 "$INBOX"
fi

# 32 字节随机, 十六进制
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

install -m 600 /dev/null "$TOKEN_FILE"
printf '%s' "$TOKEN" > "$TOKEN_FILE"

echo "令牌已签发: $TOKEN"
echo "文件: $TOKEN_FILE"
echo
echo "粘到 https://ncm.byberg.store/upload.html 的「访问令牌」框, 上传一次后自动失效。"
