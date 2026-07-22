# Docker 一键部署

> 使用官方 Docker 镜像与 Docker Compose 部署 nowen-note。

---

## 前提

- Linux 服务器（或 macOS/Windows 安装了 Docker）
- Docker Engine 与 Docker Compose V2

---

## 部署步骤

### 克隆部署模板

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
cp .env.example .env
```

### 启动稳定版本

推荐固定版本 Tag，便于审计与回滚：

```bash
NOWEN_IMAGE_TAG=v1.4.1 docker compose up -d
```

未设置 `NOWEN_IMAGE_TAG` 时默认使用 `latest`。

### 访问

浏览器打开 `http://<服务器IP>:3001`。

### 登录

用户名：`admin`，密码：`admin123`

> ⚠️ 首次登录后立即修改密码！

---

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NOWEN_PORT` | `3001` | 宿主机映射端口 |
| `NOWEN_IMAGE_TAG` | `latest` | 官方镜像 Tag，生产建议固定为 `vX.Y.Z` |
| `DB_PATH` | `/app/data/nowen-note.db` | 容器内数据库路径 |
| `NOWEN_INSTANCE_ID` | `nowen-note` | 同一 Docker Engine 上的受管实例标识 |
| `NOWEN_UPDATER_TOKEN` | 空 | Docker 在线升级代理密钥；空表示默认关闭 |

数据保存在命名卷 `nowen-note-data`。生产环境建议把 `BACKUP_DIR` 挂载到独立物理卷。

---

## 常用操作

```bash
docker compose logs -f nowen-note
docker compose restart nowen-note
docker compose down

# 手动升级到确定版本
NOWEN_IMAGE_TAG=v1.4.2 docker compose pull nowen-note
NOWEN_IMAGE_TAG=v1.4.2 docker compose up -d --no-deps nowen-note
```

### 本地源码构建

默认 Compose 不再现场构建镜像。开发或离线构建使用覆盖文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

本地构建实例不支持管理界面在线替换，应重新拉取源码并执行上述构建命令。

---

## 可选：启用管理界面在线升级

该能力默认关闭。主应用不会挂载 Docker Socket，只有独立 updater 容器拥有受限控制权限。

```bash
openssl rand -hex 32
# 把输出写入 .env：NOWEN_UPDATER_TOKEN=<随机值>
docker compose --profile updater up -d
```

启用后，管理员可在「设置 → 关于 → 版本信息」中执行预检、完整备份、升级和失败镜像回滚。详细安全边界见 [Docker 在线升级](../docker-online-update.md)。

---

## 反向代理

Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name note.example.com;
    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

不要为 `nowen-note-updater` 配置反向代理或宿主机端口。

---

## 常见问题

### Q：端口被占用？

在 `.env` 设置 `NOWEN_PORT=其他端口` 后重新启动。

### Q：启动后白屏？

```bash
docker compose logs --tail=200 nowen-note
```

### Q：为什么没有“立即升级”按钮？

只有官方镜像 Compose 部署、管理员账号、数据库 Schema 就绪、最新稳定版本可用且 updater profile 已连接时才展示可执行按钮。其他部署会显示手动升级或 NAS 应用中心指引。

---

## 下一步

- [NAS 部署教程](./nas-deploy.md)
- [数据备份与迁移](./backup-migrate.md)
- [Docker 在线升级](../docker-online-update.md)
