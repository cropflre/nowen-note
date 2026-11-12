# Docker 内置 MCP 验收（2026-11-12）

初始实现与验证分支：`codex/docker-built-in-mcp`，基于 `f21d8b648`。目标提交分支：`release/v1.6.0`；本记录不代表已发布。
架构说明：[Docker 内置 MCP](../architecture/docker-embedded-mcp.md)；用户操作：[部署教程](../tutorials/docker-deploy.md#docker-内置-mcp包含此功能的新镜像)。

## 自动化检查

| 检查 | 结果 |
| --- | --- |
| `npm test --prefix packages/nowen-mcp` | 35 项通过，覆盖原有 stdio、独立 HTTP、工具和启动诊断 |
| 后端 `tests/mcp-embedded.test.ts` | DCC-006 集成用例通过；并发身份、授权拒绝、默认只读、吊销、过期、禁用、Host/Origin、请求大小、配置重开 |
| 后端 `api-token-resource-scope`、`mcp-knowledge-tree-p0`、`mcp-automation-p2` | 21 项通过 |
| 设置页 `McpConnectionPanel`、`MigrationConnectionSetup` | 16 项通过；启停、失败保留状态、非管理员、旧镜像、复制地址/配置、真实协议检测、切换时中止旧检测 |
| 后端 TypeScript / 前端 TypeScript 与生产构建 | 通过；最终 Docker 构建再次完成前后端编译 |
| `node scripts/data-consistency-contract.mjs --verify` | 12 条不变量、330 条测试引用映射通过；不以映射代替上述行为测试 |
| `git diff --check` | 通过 |

本机 SQLite 原生依赖为 Electron ABI，后端测试使用 `ELECTRON_RUN_AS_NODE=1` 配合 Electron 的 `--import tsx --test --test-force-exit` 执行，未重建共享原生依赖。

## 真实 Docker 与 SDK 验收

本地镜像 `nowen-note:mcp-test`，Linux arm64：

```text
sha256:61ec055b284692dc45eac788d0044b004e6fe6eaf4adcf3fb9b6ddf398c7a5b9
```

使用独立测试容器、人工生成的笔记与 Token、专用数据卷，端口仅映射到 `127.0.0.1:33397`。
通过实际 HTTP 登录和现有 REST API 准备数据，使用 MCP SDK 的 `Client` 与 `StreamableHTTPClientTransport` 连接 `/mcp`，未模拟协议响应。

- 新数据卷默认关闭，未启用时返回 `404 MCP_DISABLED`。
- 启用后 SDK 初始化、通知、工具列表和笔记工具调用成功；不需要宿主机 MCP 服务。
- 两个限制到不同笔记本的 Token 并发执行 10 次列表请求，各自只见授权数据。
- 直接读取未授权笔记失败；服务只读时拒绝写入，开启写入后仍拒绝只读 Token。
- 服务写入开关与 Token 写权限均具备时，更新标题成功，可从 REST 重新读取确认。
- 删除测试容器，保留专用数据卷并从镜像重新创建后，服务地址、开关、写入开关、Token 授权、标题与正文保持完整，原 Token 可重新连接并读取。
- 吊销后新请求立即返回 401；关闭后立即返回 404。
- 检查容器日志，没有 PAT 明文或测试笔记正文。
- 验收完成后已删除本次创建的测试容器和专用数据卷，保留本地测试镜像；未接触既有部署或用户私人笔记。

临时证据：`/tmp/nowen-mcp-docker-acceptance-verified.log`、`/tmp/nowen-note-mcp-image-release-check.log`。
完整镜像第一次构建遇到 Alpine 软件源 TLS 下载错误，重试成功；未降低 TLS 校验。

## 验收边界

浏览器权限门禁拒绝打开本地验收页面，本轮未完成页面目视检查或截图；没有换用其他浏览器、原始 CDP 或间接方式绕过。
组件行为与生产编译已验证，不能据此声称真实浏览器、移动设备或每种 AI 客户端都已验收。
本次镜像运行验证为 arm64，未执行 amd64 镜像运行验收或公网 TLS 反向代理验收。
仅支持 OAuth 的客户端不在本次 Bearer Header 接入范围内。
