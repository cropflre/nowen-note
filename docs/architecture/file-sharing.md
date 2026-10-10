# 文件分享与附件运行时访问

## 背景

Nowen Note 的附件存在两种不同生命周期的 URL，不能混用：

1. **运行时附件访问 URL**：`/api/attachments/:id?exp=...&sig=...&scope=...`
   - 用于编辑器、预览、下载等当前会话读取；
   - 默认短期有效，服务端会持续复核用户/分享/发布权限；
   - `exp`、`sig`、`scope` 不属于可持久化或可对外传播的产品链接。
2. **稳定文件分享 URL**：`/api/attachments/:id?share=<opaque-token>`
   - 用于“外链分享”、复制 URL、Markdown、HTML；
   - token 不携带短期签名过期时间，因此不会在附件签名 TTL 到期后自然失效；
   - 每次访问仍会回源复核分享状态和当前 ACL，可即时撤销。

这两个层次必须保持分离：**短期签名负责运行时安全，稳定 token 负责用户可传播的分享身份。**

## 数据模型

`file_shares` 是附件之上的独立 capability，不复用 `shares`（笔记分享）表，避免一个文件分享 token 意外获得整篇笔记的访问能力。

当前字段：

- `id`
- `token`：192-bit 随机 URL-safe token
- `attachmentId`
- `noteId`
- `ownerId`
- `isActive`
- `expiresAt`
- `allowDownload`
- `createdAt` / `updatedAt`

当前阶段保持为内部能力；没有开放 Public SDK，也没有为了单个 Issue 提前加入密码、访问次数统计等未验证需求。

## 创建稳定分享

登录用户通过：

```http
POST /api/attachments/file-share
Content-Type: application/json
Authorization: Bearer <token>

{
  "attachmentId": "...",
  "allowDownload": true,
  "expiresAt": null
}
```

服务端必须先确认：

- 附件和所属笔记仍存在；
- 当前用户对所属笔记拥有读取能力；
- 当前目录策略允许 `reshare`；
- `allowDownload` 不得超过当前目录的下载权限。

同一用户对同一附件已有有效分享时默认复用 token，避免每次复制都制造新分享记录。

## 稳定链接访问

访问：

```text
/api/attachments/:attachmentId?share=<opaque-token>
```

每次请求都必须重新检查：

- token 与 attachmentId 是否绑定；
- `isActive`；
- `expiresAt`；
- 附件是否仍存在；
- 附件是否仍归属分享创建时的 note；
- 分享创建者账号是否仍有效；
- 创建者当前是否仍有 `read + reshare`；
- 显式 `download=1` 是否被 `allowDownload` 允许。

校验完成后继续复用现有附件读取、Range、ETag、对象存储与缓存链路，不新建第二套文件读取实现。

## 撤销语义

```http
DELETE /api/attachments/file-share/:attachmentId
Authorization: Bearer <token>
```

撤销只关闭当前用户为该附件创建的活动分享。

稳定分享验证发生在 ETag / 304 短路之前，因此即使浏览器携带历史 ETag，分享被撤销后也不能通过 `304 Not Modified` 绕过权限检查。

## 前端复制边界

`copyText()` 是附件临时 URL 离开应用的统一安全边界。

当待复制文本中发现 **user scope** 的附件签名 URL 时：

```text
runtime signed URL
→ POST /api/attachments/file-share
→ stable file-share URL
→ clipboard
```

该转换同时覆盖：

- 纯 URL
- Markdown 图片片段
- HTML `<img>` 片段

公开笔记分享的 `share` scope 和笔记本发布的 `publication` scope 不会被静默转换。

如果稳定分享创建失败，复制操作应失败，而不是回退复制一个 12 小时后会失效的签名 URL。

## 后续扩展

只有出现真实需求后再逐步考虑：

- 密码保护
- 最大访问次数 / 访问统计
- 独立 `/f/:token` 漂亮短链
- 文件分享管理中心
- 审计日志
- 正式 Public API / Plugin capability

这些扩展都应复用 `file_shares`，而不是修改附件签名 TTL 或恢复永久裸 UUID 公网访问。
