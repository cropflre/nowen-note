# Task Digest / 每日任务简报

这是 Nowen Note v1.5.1 的只读任务摘要示例插件。插件只申请 `tasks:read`，不能修改任务，也不会自行处理 Webhook 凭据。

## 安装与运行

在仓库根目录安装插件 CLI 依赖后：

```sh
cd examples/plugins/task-digest
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

在「设置 → 插件」安装生成的插件包并启用，授权「读取任务」，即可从插件动作中执行 `summary`。

输入示例：

```json
{"mode":"morning","timezoneOffsetMinutes":480}
```

`mode` 支持 `morning` / `evening`；时区偏移单位为分钟（北京 480）。仅统计当前用户的个人任务，不读取其他用户或共享工作区任务。

## 早晚 Webhook 和到点推送

持续推送在「设置 → 自动化 → 每日任务简报」配置，由 Nowen 服务端负责：

1. 设定早间/晚间的启用状态、时间和 IANA 时区（例如 `Asia/Shanghai`）。
2. 设置「任务到点提醒」以便对带具体 `dueAt` 的任务在到期分钟收到消息。
3. 填写公网 HTTPS Webhook 接收地址并绑定。仅订阅 `task.digest.morning`、`task.digest.evening`、`task.due`。
4. 点击「预览」确认统计内容，再发送测试 Webhook。
5. 查看 Webhook 投递日志核对响应。Docker/NAS 等常驻服务部署更适合全天候提醒。

目前输出为通用 JSON（事件名、日期、统计、任务概要），接收端需要按目标平台要求转换消息格式。Webhook URL 如包含口令，请仅在可信服务中使用并保护其访问权限。此版本未内置飞书、企业微信的专用报文转换；可通过自建转发服务或后续通知适配器接入。

## 设计边界

- 插件 `summary` 提供手动调用；服务端的早晚推送不依赖插件是否安装。
- 默认发送与当前用户有关的**个人任务**，不包含完整笔记或附件。
- 日报时区由服务端处理；本地插件简报使用固定分钟偏移，夏令时地区请优先使用服务端 IANA 时区设置。
- 此目录为源码示例，未代表已签名或上架插件市场。
- 外部 Agent 可使用 `tasks:read/write` Token 调用 MCP 个人任务工具，写操作仍需用户确认。
