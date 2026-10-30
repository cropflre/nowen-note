# HTTPS 部署与验收

Nowen Note 服务端提供 HTTP，默认端口为 `3001`。HTTPS 由反向代理处理：客户端通过 HTTPS 连接代理，代理通过本机或容器网络访问 Nowen Note。

| 环境 | 推荐方案 |
| --- | --- |
| 新建 Docker Compose 部署 | 使用配套 Caddy 覆盖文件，自动申请和续期证书 |
| 已有 Nginx / Lucky / NAS 反代 | 复用现有证书和入口，转发整个站点 |
| 仅局域网，未准备可信证书 | 保留现有 HTTP 部署；需要 HTTPS 时先解决证书信任 |

## 配套 Caddy 模板

### 前提

- Docker Engine 和 Docker Compose **2.24.4 或更新版本**，可用 `docker compose version` 检查。覆盖文件使用 `!reset` 清除原有端口映射，旧版 NAS Compose 请升级，或使用 NAS 已有反代。
- 一个公网域名，例如 `note.example.com`。A / AAAA 记录应指向实际可访问的服务器；不要保留指向不可达 IPv6 地址的 AAAA 记录。
- 宿主机 TCP `80`、TCP `443` 空闲，防火墙与路由器转发允许公网访问。模板还发布 UDP `443` 供 HTTP/3 使用；只允许 TCP 时仍可使用 HTTPS。
- 容器能够连接证书颁发机构申请和续期证书。无法开放公网验证端口时，需要另行配置 DNS 验证及相应 Caddy DNS 插件，配套模板不包含该配置。

已有 NAS / Lucky / Nginx 占用 80/443 时，使用下文的现有反代方案，无需再启动 Caddy。

### 首次部署

在仓库根目录复制 `.env.example` 为 `.env`（已有 `.env` 请直接编辑），加入：

```dotenv
NOWEN_DOMAIN=note.example.com
# 可选：固定已发布的应用镜像版本
NOWEN_IMAGE_TAG=v1.5.1
```

`NOWEN_DOMAIN` 只填写域名，不包含 `https://`、端口或路径。模板会将 `PUBLIC_WEB_ORIGIN` 设置为 `https://<NOWEN_DOMAIN>`；该变量用于生成公开链接，并不负责开启 TLS。

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
docker compose -f docker-compose.yml -f docker-compose.https.yml logs --tail=100 caddy
```

证书就绪后，浏览器及桌面 / Android 客户端填写 `https://note.example.com`，无需追加 `/api`。首次登录后修改默认管理员密码。

模板将整个站点转发到 `nowen-note:3001`，保留请求路径，支持 WebSocket 和 SSE 流式响应。应用的宿主机端口映射被移除，`NOWEN_PORT` 在此模式下不生效；容器内健康检查及可选 updater 仍使用内部 HTTP。

应用数据继续使用基础 Compose 的数据卷。Caddy 的证书及 ACME 账户保存在 `nowen-caddy-data` 卷，运行配置保存在 `nowen-caddy-config` 卷；重建容器时保留这些卷。

如果管理员此前在设置中指定了公开分享地址或文件直链地址，请同时改为正确的 HTTPS 地址，或清空该手动设置以使用环境变量；显式的管理员设置优先于环境变量。设置了独立 `FILE_PUBLIC_ORIGIN` 的用户需确认该文件域名也已提供 HTTPS。

### 已有实例切换

1. 先完成完整备份，确认原数据库与附件的持久化挂载。
2. 在**原部署目录、原 Compose 项目名**下使用覆盖文件；原来使用了 `-p` 或 `COMPOSE_PROJECT_NAME` 时继续保留，不要在新目录创建同名空实例。保留原来的自定义数据挂载文件。
3. 设置 `NOWEN_DOMAIN`，执行上面的检查和启动命令。应用容器可能被重建，期间有短暂中断。
4. 确认证书、登录及原笔记正常后，将客户端服务器地址改为 HTTPS 域名。原来的 `http://IP:3001` 地址在该模板下不再提供服务。

### 日常操作

所有命令都使用相同的两个 Compose 文件，避免普通 `docker compose up -d` 重新发布应用 HTTP 端口。

```bash
# 查看状态和日志
docker compose -f docker-compose.yml -f docker-compose.https.yml ps
docker compose -f docker-compose.yml -f docker-compose.https.yml logs --tail=100 caddy nowen-note

# 先备份并在 .env 中确定目标镜像版本，再升级应用
docker compose -f docker-compose.yml -f docker-compose.https.yml pull nowen-note
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-deps nowen-note

# 停止服务，保留数据和证书卷
docker compose -f docker-compose.yml -f docker-compose.https.yml down
```

需要管理界面在线升级时，按 [Docker 在线升级](./docker-online-update.md) 设置 `NOWEN_UPDATER_TOKEN`，并使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml --profile updater up -d
```

Caddy 不连接 updater 的内部网络，也不挂载 Docker Socket。不要为 updater 配置公网入口。

如需恢复原 HTTP 部署，可在原项目中执行 `docker compose -f docker-compose.yml -f docker-compose.https.yml stop caddy`，然后 `docker compose -f docker-compose.yml up -d`；再同步调整客户端及公开地址。

## 使用现有反向代理

### Lucky / NAS 内置反代

在现有代理中为域名申请或选择有效证书，并按以下规则配置：

| 项目 | 配置 |
| --- | --- |
| 外部入口 | `https://note.example.com`，通常监听 443 |
| 后端协议 | HTTP |
| 后端地址 | NAS / 服务器可达的 IP 和实际映射端口，例如 `http://192.168.1.10:3001` |
| 路径 | 转发整个站点根路径 `/`，不主动追加 `/api` 或改写路径 |
| WebSocket | 开启 Upgrade 支持 |
| 流式响应 | 关闭响应缓冲，允许 SSE / 长连接 |
| 请求头 | 保留原始 Host，正确设置 `X-Forwarded-Proto`、`X-Forwarded-Host` |
| 附件上传 | 代理上传上限应覆盖应用的 `MAX_ATTACHMENT_SIZE_MB` 及 multipart 开销 |

代理与 Nowen Note 在同一 Docker 网络时，可以使用 `http://nowen-note:3001`。代理在另一个容器时，`127.0.0.1` 指向代理自身，不能据此访问宿主机或 Nowen Note。

为应用设置 `PUBLIC_WEB_ORIGIN=https://note.example.com` 并重建容器；在管理员设置中已有手动公开地址时也需更新。仅需本机反代访问时，可将应用映射绑定到 `127.0.0.1:3001:3001`；NAS 上代理位于其他容器或设备时，应限制映射端口只允许代理来源访问。

### 已有 Nginx

完整 HTTPS 示例见 [Docker 教程的反向代理配置](./tutorials/docker-deploy.md#反向代理)。示例使用已经申请好的证书，证书申请和续期应由已有证书工具或 NAS 负责。

客户端会兼容已有的 `/public/api`、`/publicapi` 及对应 WebSocket 改写，但新配置优先直接转发站点根路径。

## 验收

使用自己部署的真实域名完成以下检查，浏览器信任有效证书后再测试业务：

| 检查项 | 通过标准 |
| --- | --- |
| HTTP / HTTPS | HTTP 跳转到 HTTPS，证书域名匹配且无信任错误；`/api/health` 正常 |
| 登录与正文 | 能登录、读取原笔记，编辑后重新打开内容一致 |
| 实时同步 | 第二个客户端能收到编辑；连接诊断中的 WebSocket 可用 |
| 附件 | 在测试笔记中上传图片 / 文件，刷新后可预览和下载；无 mixed content 错误 |
| 分享与文件直链 | 生成正确的 HTTPS 域名链接，独立浏览器能按分享权限访问 |
| 流式响应 | 启用 AI 或其他 SSE 功能时，内容逐步显示，不等结束后一次返回 |
| 重建与持久化 | 重建 Caddy 后原证书与 ACME 账户仍在，应用重启后测试笔记和附件仍在 |

不要仅凭首页能打开就判断 HTTPS 部署完整通过。公网证书签发、续期以及 Android / 桌面客户端的证书信任，需要在实际部署环境中验证。

当前模板的配置回归、本地 HTTPS 运行结果及尚未验证的范围见 [本地验证记录](./https-deployment-validation.md)。

## 常见问题

- **提示 `NOWEN_DOMAIN` 缺失**：在当前 Compose 使用的 `.env` 中填写域名，再执行 `config --quiet`。
- **提示不认识 `!reset`**：升级 Docker Compose 到 2.24.4+，不要直接删除 `!reset`，否则原 3001 映射可能仍然保留。
- **证书申请失败**：检查 A / AAAA、路由器端口转发、防火墙、80/443 占用和容器出站网络；查看 Caddy 日志。申请成功前无需反复删除证书卷。
- **只有局域网 IP**：自签证书或内部 CA 需要在每个客户端建立信任，启用 HTTPS 不会自动让手机或桌面客户端信任证书。不要通过关闭证书校验解决。
- **API 正常但同步不可用**：检查 WebSocket Upgrade 和代理长连接设置。
- **分享链接仍为 HTTP 或旧域名**：检查管理员手动公开地址、`PUBLIC_WEB_ORIGIN` 和独立 `FILE_PUBLIC_ORIGIN`；HTTPS 模板自动配置不覆盖管理员显式设置。

参考：[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Caddy 反向代理与流式响应](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Compose 合并与端口重置](https://docs.docker.com/reference/compose-file/merge/)。
