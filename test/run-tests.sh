#!/usr/bin/env bash
# ============================================
# run-tests.sh — 音乐解锁项目全量测试
#
#   ./test/run-tests.sh          # 全部 (含 e2e, 需要 playwright)
#   ./test/run-tests.sh --fast   # 只跑离线测试 (秒级, 无需浏览器)
#
# 测试 (V=84 后精简: ekey 链路已整体下线)
#   cipher-harness.js    qmc-mobile 算法往返 (VM 加载 modules, 无浏览器)
#   e2e-harness.js       真实浏览器打真实站点 + 真实 .ncm 文件
#
# 已随 ekey 下线一并移除 (备份在 /tmp/removed-backup):
#   cross-ref-harness.js  db-verify-harness.js  brute-harness.js  ext-harness.js
# ============================================
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
run() {
  echo ""
  echo "=============================================="
  echo "  $1"
  echo "=============================================="
  if node "$2"; then :; else FAIL=1; fi
}

# playwright 装在 /tmp (不污染项目), 用 NODE_PATH 挂上
export NODE_PATH="${NODE_PATH:-/tmp/e2e-deps/node_modules}"

echo "node $(node -v)"

run "1/2 cipher-harness (qmc-mobile 算法往返)" test/cipher-harness.js

if [ "${1:-}" != "--fast" ]; then
  if node -e "require('playwright')" 2>/dev/null; then
    run "2/2 e2e-harness (真浏览器)" test/e2e-harness.js
  else
    echo ""
    echo "⚠️  跳过 e2e: playwright 未安装"
    echo "   装一下: npm i playwright --prefix /tmp/e2e-deps && npx playwright install chromium"
  fi
fi

echo ""
echo "=============================================="
if [ $FAIL -eq 0 ]; then echo "  ✅ 全部通过"; else echo "  ❌ 有失败项"; fi
echo "=============================================="
exit $FAIL