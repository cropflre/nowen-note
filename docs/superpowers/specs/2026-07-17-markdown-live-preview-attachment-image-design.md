# Markdown 实时预览附件图片修复设计

## 背景

Markdown 的完整预览模式可以显示受保护的附件图片，但 CodeMirror 实时预览会直接请求未签名的 `/api/attachments/<id>`，后端返回 `401 SIGNATURE_REQUIRED`。

## 根因

实时预览通过 `MarkdownPreview` 渲染在 CodeMirror 的 `contenteditable` 区域内。附件访问桥为了避免把短期签名 URL 写入编辑器正文，会跳过整个可编辑 DOM；因此实时预览中的 `<img>` 没有被替换为已有的签名 URL。完整预览位于普通 DOM，不受该跳过规则影响。

## 方案

在 `MarkdownPreview` 的图片渲染组件中调用现有 `resolveAttachmentUrl()`，渲染时将附件裸链解析为当前有效的签名 URL。远程图片、`data:` 和 `blob:` 地址继续遵循现有解析规则。

不修改 Markdown 源文，不放宽附件访问桥对可编辑正文的保护，也不扩展到视频或音频。

## 数据流

1. Markdown 解析得到图片 `src`。
2. `PreviewImage` 调用 `resolveAttachmentUrl(src)`。
3. 本地附件 URL 根据已注册的附件访问映射转换为签名 URL。
4. `<img>` 使用解析后的 URL 加载；点击查看同样使用该 URL。
5. Markdown 文本仍保留稳定的 `/api/attachments/<id>`。

## 测试

为 `MarkdownPreview` 增加回归测试：先注册附件签名映射，再渲染包含附件图片的 Markdown，断言 `<img>` 的 `src` 包含有效签名，同时确认原始 Markdown 未被修改。运行相关预览测试和前端构建。

## 成功标准

- 实时预览中的本地附件图片不再以未签名 URL 发起请求。
- 完整预览模式行为保持正常。
- Markdown 源文和持久化内容不包含短期签名参数。
- 相关测试和前端构建通过。
