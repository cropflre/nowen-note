# Migration Hub P2 — 浏览器组件验收

日期：2026-10-29。浏览器：Chromium 153.0.8010.12；视口高度 900px，宽度分别为 320px、1280px，浅色及深色主题，启用 `prefers-reduced-motion: reduce`。

运行真实 `MigrationHub` → `McpConnectionPanel` 的 migration 分支 → `MigrationConnectionSetup`，复用真实配置生成、校验和 API 请求代码。Playwright 拦截 API 并提供合成笔记本、空任务历史及迁移能力；使用全新的浏览器上下文和合成登录值，不访问真实账户、私人笔记、Token 或 MCP 网关。此记录证明组件与请求边界，不证明任何 AI 宿主、物理设备或生产网络已验收。

## 步骤与结果

四组尺寸/主题均通过，数值记录见 [browser-validation.json](browser-validation.json)：

1. 打开“让 AI 帮我迁移”与客户端接入设置；缺少目标或本机启动路径时禁用复制。填入合成目录与绝对路径后可以复制 Codex TOML，包含具体目录、`read-write` 与 `MCP_INCLUDE_DESCENDANTS=true`，复制内容不包含当前页面登录值。
2. 点击“检查接入准备”，仅向当前 Nowen origin 发送带合成登录 Authorization 的 `GET /api/migrations/capabilities`；显示能力检查的真实边界，并可展开合成来源与不支持字段。
3. 切换 Claude Code 与 HTTP；网关 URL 包含合成用户名/密码时禁止复制，不生成配置，也不将凭据复制到说明文案。去除 URL 中凭据后可复制 `type: http` 的 JSON，使用独立 `NOWEN_MCP_HTTP_TOKEN` 引用。
4. 输入远端网关地址后再次诊断，仍只读取当前 Nowen 能力。四组均未产生任何其他 origin 请求、业务写请求或浏览器 `pageerror`。
5. 切换豆包工作后显示“通用模板，需在客户端核对”，没有将其标记为已验证宿主。
6. 窄屏深色组让能力请求保持未响应，实际等待 8 秒后由 AbortController 中止；显示超时并恢复检查按钮，没有显示成功状态。

四组文档与 body 宽度均不超过视口。代码块在自身容器内滚动，复制和检查按钮会换行，窄屏不依赖 hover。人工查看了窄屏深色 Codex 与桌面浅色 HTTP 截图，布局、对比度及文本正常。

| 状态 | 320px 浅色 | 320px 深色 | 1280px 浅色 | 1280px 深色 |
|---|---|---|---|---|
| Codex 本机配置及能力目录 | [截图](light-320-codex.png) | [截图](dark-320-codex.png) | [截图](light-1280-codex.png) | [截图](dark-1280-codex.png) |
| Claude Code HTTP 配置 | [截图](light-320-http.png) | [截图](dark-320-http.png) | [截图](light-1280-http.png) | [截图](dark-1280-http.png) |

模拟环境说明：首次直接访问临时 `.html` 时，现有 API base 推断将页面文件名视为反代 prefix，导致 mock 未命中；随后改为在根导航返回 Vite 转换后的同一组件壳，四组全部重跑通过。该问题来自测试壳，不作为产品缺陷或生产反代验收结论。临时前端壳已删除，仅本次启动的 5219 Vite 已停止。
