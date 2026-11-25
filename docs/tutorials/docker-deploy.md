# Docker 一键部署

> 使用官方 Docker 镜像与 Docker Compose 部署 nowen-note。

---

## 前提

- Linux 服务器（或 macOS/Windows 安装了 Docker）
- Docker Engine 与 Docker Compose V2

## Docker 内置 MCP（包含此功能的新镜像）

镜像内置可选的 Streamable HTTP MCP，与 Web/API 共用端口 `3001`，默认关闭。
无需在宿主机安装 Node.js、npm 或另一个 MCP 容器。

进入「设置 → 连接 AI 助手」，只需三步：

1. 从助手下拉框中选择正在使用的助手。支持国内的 WorkBuddy、CodeBuddy Code、TRAE 国内版、Qoder、Kimi Code、Qwen Code，以及 Claude Code、Cursor、Codex。
2. 默认已选「全部笔记」，直接点击「连接」；也可以取消不希望 AI 访问的笔记本。
3. Cursor、TRAE 国内版点击对应的「一键添加」；其余助手点击「复制给助手」，将内容粘贴给所选 Agent 完成接入。

地址、笔记增删改查授权、默认永久的有效期（可填写天数）和连通性检测自动处理，无需手填密钥、请求头或 JSON。
有效期留空为永久，也可填写正整数天数；已有连接需断开后重新连接来调整有效期。
AI 可查看、新建和修改所选笔记本中的笔记，删除前应先预览并征得用户确认，删除后移入回收站；共享只读笔记仍不可修改。
管理员点击「连接」会开启服务与编辑功能；普通用户遇到功能未开启时，需要管理员先完成连接。已有只读连接需断开后重新连接。
「全部笔记」选中当前可授权的全部笔记本；取消某个笔记本会排除其中的笔记，以后新增笔记本需重新连接时选中。
检测会实际初始化 MCP、获取工具列表并调用笔记本列表，不会把 HTTP 健康检查当成接入成功。
AI 客户端完成配置后可能需要确认或重载；请让它列出笔记本来验证接入。
已授权助手直接显示名称，点击「断开」即可撤销访问。复制内容包含专属访问授权，请勿公开分享。

界面仍只有「选助手 → 选笔记本 → 连接」，国内与其他助手放在同一个下拉框中，无需了解各客户端的配置差异。
客户端配置已按官方文档适配，但尚未逐个进行真实安装验收。这里的 Kimi Code、Qwen Code 指支持 MCP 的 Agent 工具，不表示普通 Kimi、通义网页聊天可直接连接；普通豆包、DeepSeek 网页聊天也不在已确认接入范围内。

独立 MCP 部署仍可使用。以下为开发者配置示例，不需要普通用户手动填写：

```json
{
  "mcpServers": {
    "nowen-note": {
      "type": "streamable-http",
      "url": "https://note.example.com/mcp",
      "headers": { "Authorization": "Bearer nkn_REPLACE_WITH_PERSONAL_TOKEN" }
    }
  }
}
```

公网访问使用 HTTPS。反向代理需同时转发 `/mcp` 与原有 `/api`，保留公开 `Host`，
并允许 `Authorization`、`Content-Type`、`Accept`、`MCP-Protocol-Version` 请求头。
无需新增端口映射。HTTP 地址仅用于可信局域网或本机测试，不能保护传输中的 Token。

快速连接按所选笔记本的实际权限授予笔记增删改查能力，共享只读笔记仅授予读取权限；写入仍须满足服务写入策略、Token scopes
及笔记本写权限。内置模式禁止读取服务器本地文件；插件执行、Webhook 创建、
工作流运行及备份创建等高风险工具保持关闭。Token 不能管理服务开关或创建、扩张自己的授权。

开关和地址存储在现有数据库，Token 沿用已有哈希存储与授权表。保留 `/app/data` 数据卷升级、
重建容器即可保留配置；服务端不额外保存一份明文 API Token。关闭服务后，新 MCP 请求
和后续内部 API 调用立即拒绝；已经提交的写入不会因关闭服务而回滚。

故障排查：`404 MCP_DISABLED` 表示未启用；`401` 表示 Token 无效、过期、吊销或账号禁用；
`403 INVALID_HOST/INVALID_ORIGIN` 需核对对外地址与代理头；工具返回 `MCP_READ_ONLY` 表示
服务仍为只读。`GET /mcp` 返回 `405` 是正常行为，本实现使用无会话的 POST 请求，不提供常驻 SSE 订阅。
「后端健康」不等于 MCP 已可用，请使用 MCP 连接检测。仅支持 OAuth 的客户端还不能直接连接。

旧镜像没有内置运行时；现有独立 MCP 服务和 stdio 方式继续可用。

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

Docker 新部署可使用 [配套 Caddy HTTPS 模板](../https-deployment.md)，自动申请和续期证书。已有 Lucky / NAS 反代的配置要求与验收步骤也见该文档。

以下为已有 Nginx 的 HTTPS 示例，`map` 和 `server` 放在 Nginx 的 `http` 上下文中。先通过现有证书工具申请证书，替换域名、证书路径和实际后端端口，并配置证书续期：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name note.example.com;
    return 308 https://note.example.com$request_uri;
}

server {
    listen 443 ssl;
    server_name note.example.com;
    ssl_certificate /etc/nginx/certs/note.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/note.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 应用默认允许 100 MB，预留 multipart 开销；应用调整上限时同步调整。
    client_max_body_size 110m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

此例假定 Nginx 运行在宿主机；Nginx 在容器内时应改用其能访问的后端地址。为应用配置 `PUBLIC_WEB_ORIGIN=https://note.example.com`，并确认管理员手动公开地址没有保留旧值。仅设置公开地址不会开启 HTTPS。

客户端会先探测标准 `/api`、`/ws` 路径；如果反向代理把请求改写成
`/public/api`、`/publicapi`（WebSocket 对应 `/public/ws`、`/publicws`），
会自动识别并缓存本次连接使用的路径。服务器地址仍填写用户实际访问的根地址，
无需把 `/api` 或 `/public` 手动追加到地址中。

Lucky 等 NAS 反向代理仍建议把站点根路径完整转发到 `nowen-note:3001`，并开启
WebSocket Upgrade。自动兼容用于承接已有的 `/public` 重写配置；如果连接诊断显示
“API 正常但 WebSocket 不可用”，请检查代理是否转发 `Upgrade` 和 `Connection` 请求头。

不要为 `nowen-note-updater` 配置反向代理或宿主机端口。

---

## 常见问题

### Q：端口被占用？

在 `.env` 设置 `NOWEN_PORT=其他端口` 后重新启动。

### Q：启动后白屏？

```bash
docker compose logs --tail=200 nowen-note
```

### Q：Embedding 已生成，但问答一直使用 BM25？

先在容器内检查向量扩展（使用内存数据库，不修改笔记数据）：

```bash
docker compose exec nowen-note node backend/scripts/smoke-sqlite-vec.cjs
```

成功时输出 `extension load, vec0 and KNN passed`，表示扩展加载、向量建表和近邻查询都通过。新版 Docker 构建会编译适配 Alpine musl 的扩展，并执行同一检查；检查失败会阻止镜像构建完成。

旧镜像若出现 `sqlite-vec load failed` 或 `vec0.so.so`，请更新到包含此修复的镜像（源码部署则重新构建）。修复后首次启动会从已有 `note_embeddings` 恢复向量索引，无需重新调用 embedding API。上述检查只验证扩展，实际恢复数量请查看启动日志中的 `[vec-store] restored` 或向量重建日志。

### Q：为什么没有“立即升级”按钮？

只有官方镜像 Compose 部署、管理员账号、数据库 Schema 就绪、最新稳定版本可用且 updater profile 已连接时才展示可执行按钮。其他部署会显示手动升级或 NAS 应用中心指引。

---

## 下一步

- [NAS 部署教程](./nas-deploy.md)
- [数据备份与迁移](./backup-migrate.md)
- [Docker 在线升级](../docker-online-update.md)
