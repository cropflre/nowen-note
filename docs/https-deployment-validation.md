# HTTPS 部署模板本地验证记录

验证日期：2026-10-11。本文记录本次工作区的本地结果，新增模板尚未发布；真实部署验收清单见 [HTTPS 部署与验收](./https-deployment.md#验收)。

## 配置与回归

| 项目 | 结果 |
| --- | --- |
| Compose 2.24.4 合并配置 | 4 项测试通过：取消主应用端口映射、保留原数据卷和 updater 隔离、拒绝空域名、普通 HTTP 部署保持兼容 |
| 原有 Docker 健康检查回归 | 2 项测试通过 |
| Caddy 2.11.7 配置 | 官方 `caddy adapt` 和 `caddy validate` 通过；解析结果指向 `nowen-note:3001` |
| Nginx HTTPS 示例 | 将教程中的代码块放入 `http` 上下文，仅将证书路径替换为临时测试证书；Nginx 1.30.5 `nginx -t` 通过 |

Compose CLI 和 Caddy 使用官方发布的 Windows 二进制，分别核对官方 SHA256 / SHA512 校验值；Nginx 使用 nginx.org 发布的 Windows 包。

回归入口：

```bash
npm run test:docker-https
npm run test:docker-healthcheck
NOWEN_DOMAIN=note.example.com caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile
```

`test:docker-https` 默认调用已安装的 `docker compose`，仅解析配置，不创建容器、卷或网络；无 Docker CLI 时可用 `NOWEN_TEST_COMPOSE_BIN` 指定独立 Compose 可执行文件。测试使用临时项目目录及空 `.env`，不读取部署实例的凭据。

## 本地 HTTPS 运行检查

后端通过仓库 Electron 的 Node 模式运行当前 `backend/src/index.hardened.ts`；数据库、附件和后台写入目录全部放在独立系统临时目录。静态页面使用现有 `frontend/dist` 构建产物。

Caddy 使用部署 Caddyfile 的测试副本：主机名换成 `https-smoke.localhost`，上游换成本机独立后端端口，HTTP / HTTPS 使用临时高端口。证书由 Caddy 内部 CA 签发，测试客户端显式信任该 CA，保持证书校验开启；通过 `skip_install_trust` 避免修改系统信任库。另加一条仅用于延迟 SSE 协议夹具的路由。

11 项运行检查通过：

1. 隔离的源码后端启动成功。
2. 显式信任临时 CA 后，HTTPS `/api/health` 正常。
3. HTTP 308 跳转保留路径与查询参数。
4. 生产静态首页经 HTTPS 返回 HTML。
5. 登录并创建测试 Markdown 笔记。
6. 保存后重读正文一致，已认证 WSS 连接收到笔记变更通知。
7. multipart 图片上传、签名预览及 HTTPS 文件分享下载成功，下载字节与上传一致。
8. 未携带登录凭据的客户端可按公开分享权限读取测试笔记。
9. 延迟 1.5 秒结束的 SSE 夹具首帧在 3 ms 内到达，后续帧完整收到。
10. 重启 Caddy 后 CA 和叶证书保持一致。
11. 重启源码后端后，测试笔记正文和图片仍能读取。

测试结束后已停止临时进程。此工作区的原始检查结果保存在未跟踪的 `data/https-validation/result.json`；数据库、临时证书和服务日志位于该文件记录的系统临时目录，均为合成测试数据。

## 尚未验证的范围

- 当前验证未使用 Docker 引擎，未启动或构建实际 Docker 容器；容器 DNS、挂载与网络运行仍需 Docker 环境验证。
- 未使用真实公网域名申请或续期 ACME 证书；本地 CA 的证书持久化不等于公网续期验证。
- 未执行安装版桌面 / Android 客户端或浏览器编辑器界面的人工验收；运行检查使用 HTTP / WSS API 客户端。
- SSE 通过延迟协议夹具验证代理及时转发，未调用真实 AI 服务。
- Nginx 仅完成配置检查，未运行其代理业务链路。
- 未查询 CI，也未发布镜像或安装包。
