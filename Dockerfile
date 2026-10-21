# ============================================================
#  音乐解锁 — 容器镜像
#
#  两阶段构建:
#    builder  拉齐静态资源, 跑一遍语法自检
#    runtime  nginx:alpine + 站点文件 + 正确的 CSP 头
#
#  构建:
#    docker build -t music-unlock .
#  运行:
#    docker run -d -p 8080:8080 --name music-unlock music-unlock
#    → http://localhost:8080
# ============================================================

# ---------- 阶段 1: 构建 ----------
FROM node:20-alpine AS builder

WORKDIR /app

# 先只拷 manifest, 让依赖层能被缓存
COPY package.json* ./

# 无 npm 依赖也要能构建 (纯静态项目), 有则安装
RUN if [ -f package.json ] && grep -q '"dependencies"' package.json; then \
      npm ci --omit=dev; \
    else \
      echo "纯静态项目, 无需安装依赖"; \
    fi

# 拷站点文件
COPY index.html ./
COPY assets ./assets
COPY modules ./modules

# ---------- 构建期自检 ----------
# 单独一个脚本, 本地也能跑: sh docker/verify.sh
# 目的是在推镜像**之前**把会让线上白屏的问题挑出来
COPY docker/verify.sh /app/verify.sh
RUN chmod +x verify.sh && sh verify.sh && rm verify.sh

# ---------- 阶段 2: 运行时 ----------
FROM nginx:1.27-alpine AS runtime

# nginx 官方镜像自带的默认站点会抢 80 端口, 删掉
RUN rm -f /etc/nginx/conf.d/default.conf

# 站点文件
COPY --from=builder /app /usr/share/nginx/html

# 站点配置模板 + 入口脚本
# 不用 nginx 自带的 envsubst: 它没法写条件块 (有没有证书 → ssl on/off)
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/entrypoint.sh /docker-entrypoint-music.d/entrypoint.sh
RUN chmod +x /docker-entrypoint-music.d/entrypoint.sh

# ---------- 默认环境 ----------
# HTTPS: 挂载证书并设 TLS_CERT / TLS_KEY 即自动启用
ENV SERVER_NAME=localhost \
    LISTEN_PORT=8080 \
    CSP="default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; media-src 'self' blob: data:; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'self'; form-action 'self'" \
    TLS_CERT="" \
    TLS_KEY=""

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${LISTEN_PORT}/index.html || exit 1

STOPSIGNAL SIGQUIT

ENTRYPOINT ["/docker-entrypoint-music.d/entrypoint.sh"]