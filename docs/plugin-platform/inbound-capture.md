# 入站 Webhook 与网页采集

Plugin API V2 可执行扩展可以声明 `contributes.inboundWebhooks`；声明式扩展不能注册 HTTP 入口。

```json
{
  "inboundWebhooks": [{
    "id": "receiver", "path": "receiver", "action": "receive",
    "methods": ["GET", "POST"], "maxBodyBytes": 262144,
    "backgroundAction": "save"
  }]
}
```

`id` 和单段 `path` 在一个插件内唯一。`action` 必须存在，`backgroundAction` 可选，且必须声明 `execution: "background"`。最大原始请求体为 256KB；序列化后的 Action input 同时受现有 256KB IPC 参数预算限制（XML 引号等转义会占用额外空间）。

已登录用户使用 `POST /api/plugins/:id/inbound-webhooks/:hookId` 创建或轮换自己的入口，返回一次性的 `path`；`GET /api/plugins/:id/inbound-webhooks` 只返回当前用户已配置的 hookId；`DELETE` 撤销自己的入口。数据库仅持久化 256-bit 随机令牌的 SHA-256。随机 URL 绑定生成者及其 tokenVersion、当时的完整 Contribution；插件更新改变声明后需重新生成。插件卸载清理入站后台工作流。

外部请求访问 `/api/plugin-inbound/:pluginId/:path/:token`，无需 JWT。Host 每个地址每分钟允许 60 次请求；先校验令牌、用户和插件状态，再限制读取请求体及 Action 执行。Action 拿到 `{method, query, headers, body}`；query/header 各最多 8KB，headers 只包含 Content-Type 和签名/事件相关白名单，Cookie、Authorization、X-User-Id 不转交。请求路径与挑战参数不进入普通 HTTP 访问日志；独立审计仅记录 pluginId、hookId、executionId 和状态。

Action 返回 `{status, contentType, body}`。只允许 `text/plain`、`text/xml`、`application/xml`、`application/json`，最多 64KB，不允许重定向、任意响应头或 HTML；响应带 no-store 和 nosniff。交互执行 3.5 秒后取消，返回 504。第三方协议签名验证属于插件职责。

需要后台处理时，已验证 Action 还可以返回 `enqueue: {key, input}`（key 最多 200 字符，input 最多 128KB）。Host 只调用 Manifest 的 `backgroundAction`，以入口所有者身份持久化 Automation 事件和单步骤工作流任务，再返回应答。相同地址与 key 复用同一事件/任务；后台结果和失败沿用 Automation。入口轮换与撤销移除关联任务。已有插件权限、Node 风险确认、生命周期、Runner 隔离及执行预算保持适用。

网页采集接口见 [capture.importUrl](./article-capture.md)。

## 插件设置与密钥操作

`nowen.settings.get()` 返回当前执行用户的 Manifest 设置（secret 设置只显示是否配置）。`secrets:use` 可调用以下受限操作，connection 必须在当前插件 Manifest 中声明，密钥仅从当前执行用户的加密记录读取：

- `secrets.digest({connection, algorithm: "sha1" | "sha256", parts, sort?})`：将密钥加入字符串 parts，可按插件要求排序后摘要，返回十六进制。
- `secrets.crypt({connection, operation: "encrypt" | "decrypt", data})`：32-byte Base64 连接密钥的 AES-256-CBC 基元，IV 使用密钥前 16 字节，不自动填充；输入/输出是 Base64，输入必须是非空 16-byte 整数倍。协议报文封装、填充验证和签名均由插件完成。该兼容基元用于既有协议，新协议应使用认证加密。

示例及配置步骤见 [微信公众号采集](../../examples/plugins/wechat-capture/README.md)。
