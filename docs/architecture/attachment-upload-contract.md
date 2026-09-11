# Attachment Upload Contract

> Issue #780：修复媒体上传大小限制前后端不一致，以及“附件上传完成”被误当成“正文插入成功”的问题。

## 目标

附件上传必须有两个清晰、可复用的产品契约：

1. **Attachment Upload Policy**：服务端是文件大小上限的唯一权威来源，前端不得维护另一套业务上限。
2. **Media Commit Lifecycle**：附件写入存储只是中间态，只有对应附件标记已经进入编辑器正文后，UI 才能显示最终成功。

## 1. Attachment Upload Policy

后端实际限制仍由：

```text
MAX_ATTACHMENT_SIZE_MB
```

控制，默认 `100 MiB`，最大可配置 `10240 MiB`。

`index.hardened.ts` 会加载：

```text
backend/src/runtime/attachment-upload-policy.ts
```

该 runtime 在 `/api/attachments` 挂载前注册：

```text
GET /api/attachment-upload-policy
```

响应示例：

```json
{
  "maxAttachmentSizeBytes": 524288000,
  "maxAttachmentSizeMiB": 500
}
```

前端通过 `attachmentUploadPolicy.ts` 读取并缓存该值，因此部署者从 `100` 调整到 `500` 后不需要重新编译前端。

### 失败降级

如果策略接口因为旧服务端、网络或认证状态暂时不可用，前端会保留 `100 MiB` 作为展示 fallback，但它**不是权威拒绝条件**。

原因：服务器可能已经配置为 `500 MiB`。策略获取失败时本地直接按 `100 MiB` 拒绝，会再次制造前后端能力不一致。

这种场景最终仍由真正的附件 POST 决定是否允许上传。

## 2. 统一上传边界

`attachmentUploadPolicyBridge.ts` 在应用启动时包装 `api.attachments.upload`。

因此以下入口自动共享同一限制：

- 富文本编辑器
- Markdown 编辑器
- 拖拽
- 粘贴
- 移动端媒体选择面板
- 其它复用 `api.attachments.upload` 的导入/附件流程

业务组件不应再自行写：

```ts
if (file.size > 100 * 1024 * 1024) ...
```

或：

```ts
if (file.size > 1024 * 1024 * 1024) ...
```

作为产品级上传上限。

## 3. 413 Contract

历史 `attachments-core` 仍负责真正的 `File.size` 服务端强制校验。

runtime 会把历史 413 响应标准化成：

```json
{
  "code": "ATTACHMENT_TOO_LARGE",
  "maxSizeBytes": 104857600,
  "actualSizeBytes": 104857601,
  "error": "文件大小超过服务器允许的 100 MiB"
}
```

canonical `/api/attachments` multipart 请求会附加：

```text
__uploadSize=<File.size>
```

作为错误元数据提示。该值**不参与服务端授权或大小判定**；真正的限制仍由后端收到的 `File.size` 决定，不能信任客户端 hint 绕过限制。该 query 仅用于标准附件上传，不会扩散到 task attachments 或其它 multipart API。

`UploadRequestError` 会保留：

```text
code = ATTACHMENT_TOO_LARGE
status = 413
maxSizeBytes
actualSizeBytes
retryable = false
```

所以 UI 和未来其它客户端可以使用结构化信息，而不是解析中文错误字符串。

## 4. Media Commit Lifecycle

旧链路：

```text
uploadMediaAttachment
    ↓
附件 POST 成功
    ↓
emit success   ← 过早
    ↓
Tiptap / Markdown 尝试插入节点
```

这会把两个不同完成状态混为一谈。

新链路：

```text
start
  ↓
附件 POST
  ↓
返回 MediaUploadResult
  ↓
调用方沿用现有编辑器插入流程
  ↓
mediaInsertionCommit 检查附件 marker
  ├─ 找到 → success
  └─ 超时 → error（附件仍保留在附件库）
```

### 为什么不重写两个编辑器

Tiptap 和 Markdown 已经有各自稳定的插入逻辑。#780 不应该为了统一状态而复制第三套插入实现。

`mediaInsertionCommit.ts` 只确认结果是否跨过“编辑器正文边界”：

- Tiptap：匹配带该 attachment id 的 `<video src>` / 媒体节点；
- Markdown：匹配 CodeMirror 正文中的持久化附件 URL；
- 同时兼容带短期签名参数的运行时附件 URL。

未确认插入时生命周期返回：

```text
视频已上传，但插入正文失败。点击“重试失败项”会复用已上传文件重新插入，也可从附件库手动插入。
```

此时 `mediaUploadService` 会在当前页面会话中暂存该 `MediaUploadResult`。用户点击现有“重试失败项”后，编辑器重新执行插入流程，但**不会再次 POST 同一个视频**；确认正文出现对应 attachment marker 后才清除暂存并进入最终 success。

这样同时解决两个问题：

```text
假成功 → 不再发生
插入失败后反复重试 → 不再制造重复附件/更多孤儿文件
```

如果页面已经离开，内存恢复缓存自然释放；附件本体仍保留在附件库，用户仍可以手动重新插入。

## 5. 大文件 timeout

本能力不会回退 #768 已建立的动态上传 deadline。

文件大小限制解决的是：

```text
Can upload?
```

timeout 解决的是：

```text
How long should this valid upload be allowed to run?
```

两者是独立能力。

几百 MiB / GiB 级文件未来如果需要更高可靠性，应单独设计分片上传与断点续传，不应继续无限提高单请求 timeout。

## 6. 回归边界

至少覆盖：

```text
99 MiB
100 MiB
100 MiB + 1 byte
MAX_ATTACHMENT_SIZE_MB=500
structured 413
runtime upload-size hint
upload-size hint only for /api/attachments
Tiptap inserted marker
Markdown inserted marker
uploaded-but-not-inserted
retry insertion without duplicate upload
large-file dynamic timeout
```

## 7. 后续演进

当真实需求出现时，可以继续演进：

```text
Attachment Upload Policy
        ↓
Upload Session
        ↓
Chunked Upload
        ↓
Resume / Retry
        ↓
Integrity Check
        ↓
Commit Attachment
```

当前 #780 只建立上传限制契约和媒体 commit lifecycle，不提前设计分片协议或 Public Plugin API。
