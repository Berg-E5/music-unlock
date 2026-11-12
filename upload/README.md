# ncm-upload —— 安装包上传端点

配合 `install.sh` 用：把本地打包好的安装包传到服务器，供逆向分析。

## 设计

- **一次性令牌**：服务端收完一个文件就把令牌文件删掉，所以令牌用完即焚
- 只接受单一文件，大小上限默认 200MB
- 只监听 `127.0.0.1`，外部访问靠 nginx 反代
- 落在 `/var/lib/ncm-upload/inbox`，该目录不在 nginx 静态根下，不可直接访问
- 文件名做白名单清洗，拒绝路径穿越
- 上传完回一个 sha256，方便确认完整性

## 用法

```bash
# 服务器上签发一次性令牌
/opt/ncm-upload/new-token.sh

# 把它粘到 https://ncm.byberg.store/upload.html 的「访问令牌」框，上传一次后自动失效
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `18100` | 监听端口 |
| `NCM_UPLOAD_INBOX` | `/var/lib/ncm-upload/inbox` | 收件目录 |
| `NCM_UPLOAD_TOKEN_FILE` | `/root/.ncm_upload_token` | 令牌文件（用完即删） |
| `NCM_UPLOAD_MAX_BYTES` | `209715200` | 大小上限 |

## systemd

```ini
[Unit]
Description=ncm.byberg.store 安装包上传端点
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/ncm-upload/server.js
Environment=PORT=18100
Environment=NCM_UPLOAD_INBOX=/var/lib/ncm-upload/inbox
Environment=NCM_UPLOAD_TOKEN_FILE=/root/.ncm_upload_token
Environment=NCM_UPLOAD_MAX_BYTES=209715200
Restart=on-failure
RestartSec=3
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```
