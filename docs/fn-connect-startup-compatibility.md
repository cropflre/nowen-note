# FN ID 远程启动兼容 / FN ID remote startup

## 反馈与证据 / Report and evidence

同一部 Android 15 手机、同一个飞牛 App 内，FRP 入口正常，FN ID → Docker → Nowen Note 入口显示 `BOOT_TIMEOUT`。诊断的 Chrome 153 内核与基础功能正常，仅记录页面启动 12 秒未就绪。

The same Android 15 FN App opens the FRP endpoint successfully but times out through FN ID → Docker → Nowen Note. The reported Chrome 153 runtime supports the checked primitives; the only captured failure is the 12-second readiness deadline.

已确认的代码问题是：慢启动被直接显示为失败；登录检查的 AbortSignal 不覆盖后续独立的 Token 刷新，刷新和 JSON 读取都可能无限等待。尚未捕获失败 FN ID 会话的 Network 记录，不能将中继限速、路径改写或登录刷新挂起认定为该用户的最终根因。

Confirmed code gaps: slow startup is presented as failure, and the auth check's AbortSignal does not bound its separate token refresh or JSON read. Without the failing FN ID session's network trace, relay throttling, path rewriting and stalled refresh remain hypotheses.

## 本次修改 / Changes

- 12 秒继续显示加载与刷新/复制诊断操作；60 秒后报告超时。真实脚本/渲染异常立即显示，并且不会被定时器覆盖。任何时刻首屏就绪，都可以自动移除启动卡片。
- 登录续期包含网络和响应读取的 8 秒超时；中止不可靠时也能结束等待，迟到响应不会写回凭据。超时保留凭据，可重新尝试；服务端明确拒绝续期仍清理失效凭据。
- 诊断增加 `resources` / `runtime` / `rendering` / `authentication` / `ready` 阶段，以及复制时的耗时和最近 20 个 JS/CSS 资源的 URL、耗时、传输大小和可用的响应状态；移除 URL 查询与片段，不收集 API URL、请求头或正文。

At 12s the page keeps loading with recovery actions; at 60s it reports timeout. Real runtime failures stay visible, and late readiness can recover automatically. Refresh and body reads have an 8s bound with no late persistence; timeouts preserve credentials, while definitive authentication rejection still clears them. Diagnostics include startup phase and sanitized JS/CSS resource timings.

不改变 JWT、ACL、代理证书验证、笔记存储或同步队列；不绕过 FN Connect 的访问认证。与数据一致性有关的边界是 DCC-006：本次超时不写回迟到认证结果，也不清理其他业务数据。

JWT/ACL, certificate validation, note storage and sync queues remain unchanged. FN Connect authentication is not bypassed. The relevant DCC-006 boundary is that timed-out authentication results cannot persist late or clear business data.

## 验证 / Validation

```sh
cd frontend
npm run test:run -- src/lib/__tests__/remoteWebStartup.test.ts src/lib/__tests__/authSession.test.ts src/lib/__tests__/iosWebKitStartupContract.test.ts src/lib/__tests__/runtimePrelude.test.ts src/lib/__tests__/startupChunkingContract.test.ts
npm run build:web
# Start npm run preview -- --host 127.0.0.1 --port 4173 --strictPort before browser tests.
npx playwright test e2e/fn-connect-startup.spec.ts --browser=chromium --reporter=line
```

浏览器回归模拟飞牛 App User-Agent 与手机视口，延迟生产入口模块跨过 12 秒，再恢复网络资源，断言登录页自动出现；另覆盖模块加载失败的真实错误提示。这是模拟浏览器证据，不能代替飞牛 App 真机验收。

Browser regression uses the reported FN App User-Agent and a mobile viewport, delays the production entry module past 12s, then checks automatic recovery to login. A separate case covers actual module failure. This simulation does not replace FN App device acceptance.

升级包含本修复的服务端 Web/Docker 产物后，在同一手机、同一网络分别验证 FN ID 和 FRP 的首次打开、刷新、登录与过期登录态恢复。若 FN ID 仍失败，复制完整诊断并保留该次资源/API 请求的状态与耗时；不要清空应用数据作为常规排查步骤。

After deploying the updated Web/Docker artifact, verify FN ID and FRP cold start, reload, login and expired-session recovery on the same device/network. If FN ID still fails, collect diagnostics and resource/API statuses and durations without clearing app data.
