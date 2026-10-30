# Webhook 自动化

> 当笔记发生变更时自动触发外部通知和工作流。

---

## 什么是 Webhook？

Webhook 是一种「事件驱动」的自动化机制。当 nowen-note 中发生特定事件（如创建笔记、更新笔记）时，自动向你指定的 URL 发送通知。

---

## 支持的事件

| 事件 | 触发时机 |
|---|---|
| `note.created` | 创建新笔记 |
| `note.updated` | 更新笔记内容 |
| `note.deleted` | 删除笔记 |
| `note.trashed` | 笔记移入回收站 |
| `note.trash_emptied` | 清空回收站 |
| `*` | 所有事件 |

---

## 创建 Webhook

1. ⚙️ 设置 → 数据管理 → Webhook
2. 点击「新建 Webhook」
3. 填写配置：
   - **URL**：接收通知的地址
   - **事件**：选择要监听的事件（默认所有）
   - **描述**：备注说明
   - **Secret**：签名密钥（可选，用于验证请求来源）

[截图：Webhook 配置]

---

## Webhook 请求格式

当事件触发时，nowen-note 会向指定 URL 发送 POST 请求：

```json
{
  "event": "note.created",
  "data": {
    "id": "note-id",
    "title": "笔记标题",
    "notebookId": "notebook-id",
    "userId": "user-id",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

请求顶层的 `timestamp` 是带时区的 ISO 8601 投递时间。任务早间简报、晚间总结和到点提醒使用提醒设置中的时区，例如北京时间 `2026-10-08T09:00:00.123+08:00`；对应的 `data.timezone` 为 `Asia/Shanghai`。其他事件保持 UTC（`Z` 后缀）。接收端应按完整时间戳解析，保留时区偏移，避免重复加减 8 小时。

### 请求头

| Header | 说明 |
|---|---|
| `Content-Type` | `application/json` |
| `X-Nowen-Event` | 事件类型 |
| `X-Nowen-Signature` | HMAC 签名（如果设置了 Secret） |

---

## 测试 Webhook

创建后可以点击「测试」按钮发送一个测试事件，验证 URL 是否可达。

---

## 投递记录

在 Webhook 管理页面可以查看每次投递的状态：

- 成功/失败
- 响应状态码
- 响应内容
- 投递时间

---

## 使用场景

| 场景 | 说明 |
|---|---|
| 同步到其他系统 | 笔记更新后自动同步到 Notion/飞书等 |
| 通知推送 | 新建笔记后发送到 Slack/钉钉 |
| 备份触发 | 笔记删除后触发自动备份 |
| 数据分析 | 记录笔记变更日志 |

---

## 验证签名

如果设置了 Secret，Webhook 请求会附带 HMAC-SHA256 签名：

```javascript
const crypto = require('crypto');

function verifySignature(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return signature === expected;
}
```

---

## 下一步

- [OpenAPI 接入指南](./api.md) — REST API
- [数据备份与迁移](./backup-migrate.md) — 备份策略

---

> 本教程基于 nowen-note v1.1.18 编写。
