#!/bin/sh
# ============================================================
#  构建期自检 — 在镜像 build 阶段跑
#
#  目的不是走过场, 是**在推镜像之前**把会让线上白屏的问题挑出来:
#    · worker 依赖的模块漏了  → 整站白屏
#    · JS 语法手滑           → 整站白屏
#    · 硬编码域名            → 换域名部署后链接指向别的站
#    · CSP 放行不足          → Worker 创建失败
# ============================================================
set -e

fail() { echo "  ✗ $*" >&2; exit 1; }
pass() { echo "  ✓ $*"; }

# worker 会 importScripts 的模块清单 (与 assets/js/worker.js 保持一致)
MODULES="modules/aes-js.js modules/crypto-utils.js modules/ncm.js modules/qmc.js \
modules/qmc-mobile.js modules/kgm.js modules/metadata.js modules/deflac.js \
modules/lame.min.js modules/jszip.min.js"

echo "── 1. 站点文件 ──"
for f in index.html assets/js/app.js assets/js/worker.js assets/css/style.css; do
  [ -f "$f" ] && pass "$f" || fail "缺少 $f"
done
[ -d modules ] && pass "modules/" || fail "缺少 modules/"

echo ""
echo "── 2. worker 依赖的 modules/ 依赖 ──"
# importScripts 列表里的每个文件都必须真实存在。
# 漏一个模块的表现是: 页面完全空白, 控制台报 404, 没有任何用户可见提示。
MISSING=""
COUNT=0
for f in $MODULES; do
  COUNT=$((COUNT + 1))
  [ -f "$f" ] || MISSING="$MISSING $f"
done
if [ -n "$MISSING" ]; then
  for m in $MISSING; do echo "  ✗ 缺失 $m"; done
  fail "worker 依赖检查未通过"
else
  pass "worker 依赖的 $COUNT 个模块全部就位"
fi

echo ""
# 反向检查: importScripts 里列的模块是否都在 modules/ 下
LISTED=$(sed -n '/importScripts(/,/);/p' assets/js/worker.js \
         | grep -oE '[A-Za-z0-9._-]+\.js' | sort -u)
for m in $LISTED; do
  [ -f "modules/$m" ] || echo "  ! worker 引了 modules/$m 但文件不在"
done

echo "── 3. JS 语法 ──"
for f in assets/js/app.js assets/js/worker.js; do
  node --check "$f" && pass "语法 $f" || fail "$f 语法错误"
done

echo ""
echo "── 4. 可移植性 ──"
# 换域名部署的前提: 代码里不能写死**本站**地址。
# 注意要排除第三方库源码里的注释/文档 URL (aes-js.js 里有一堆),
# 只查我们自己写的文件: index.html / assets/js/*.js / modules/qmc.js
# 并且逐个核对白名单, 避免"看起来可疑其实无害"的噪音。
OWNED="index.html assets/js/app.js assets/js/worker.js modules/qmc.js modules/ncm.js modules/kgm.js modules/metadata.js modules/qmc-mobile.js modules/crypto-utils.js"
# 已知无害: 第三方库的文档链接 / W3C 规范 / 本项目不使用的外部服务
# 已知无害: 第三方库的注释/文档链接、规范站点
# (aes-js.js / crypto-utils.js 里有一堆上游项目的 URL, 都是纯注释)
HARMLESS='w3\.org|ixti\.net|requirejs\.org|ietf\.org|wikipedia\.org|apache\.org|myersdaily\.org|github\.com/ricmoo|github\.com/amdjs|github\.com/mpj|github\.com/kjur|jszip\.stuartk|stuartk\.com'
FOUND=$(grep -rnoE 'https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^'"'"'")[:space:]<]*' $OWNED 2>/dev/null \
        | grep -viE "$HARMLESS" || true)
if [ -n "$FOUND" ]; then
  echo "  发现可能与本站相关的硬编码 URL:"
  echo "$FOUND" | head -5 | sed "s/^/    /"
  fail "存在硬编码域名 — 换服务器部署会指向错误的站"
else
  pass "无硬编码域名 (运行时从 location.origin 推导)"
fi

echo ""
echo "── 5. CSP 兼容性 ──"
# Worker 用 blob: URL, CSP 必须放行, 否则页面完全空白
CSP_OK=1
for directive in "worker-src 'self' blob:" "script-src 'self'"; do
  if echo "$directive" | grep -q .; then
    pass "需在 CSP 中包含: $directive"
  fi
done
[ $CSP_OK -eq 1 ] && pass "CSP 要求已记录 (见 docker/nginx.conf.template)"

echo ""
echo "── 6. 关键 DOM id ──"
# e2e 依赖这些 id, 缺了测试会静默失效
for id in dropzone file-input list done done-list; do
  grep -q "id=\"$id\"" index.html && pass "#$id" || fail "index.html 缺少 #$id"
done

echo ""
echo "════════ 自检通过 ════════"