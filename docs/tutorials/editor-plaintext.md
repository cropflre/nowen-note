# 纯文本笔记（TXT） / Plain text notes

> 开发分支新增功能（#835），随包含此功能的客户端和服务端版本交付。

在目录树或笔记列表的「新建」菜单中选择「纯文本文档（TXT）」。笔记标签栏的加号菜单也提供这个入口。

界面只包含标题、文字编辑区和「导出 TXT」。输入或粘贴的 `#`、`**`、HTML、JSON、空行和空白按文字保存，不生成 Markdown 块标识，不执行 HTML，不提取文字中的图片地址。将富文本粘贴到编辑区时使用剪贴板的纯文本。

正文自动保存，并复用现有草稿、权限和离线同步流程。导出 TXT 使用编辑区的最新内容，生成 UTF-8 `.txt` 文件；Android 使用系统文件保存入口。Nowen 备份包保留纯文本格式和正文，恢复时仍为 TXT。

TXT 当前没有格式工具栏、预览、块引用、加密区域、模板或格式转换。Markdown 和富文本笔记保留原有行为。多端使用前，应将客户端与服务端一起升级到包含 TXT 支持的版本；旧客户端不能正确选择纯文本编辑器。

Create a **Plain text document (TXT)** from the tree, note list or tab bar. The editor contains a title, a text area and **Export TXT**. Markdown symbols, HTML, JSON and whitespace remain literal text. Pasting uses plain clipboard text. Autosave, permissions, drafts and offline sync use the existing note workflow; TXT export uses the current text and creates a UTF-8 file. Android uses the system file picker. Nowen backup packages retain the format and original text.

TXT currently has no formatting toolbar, preview, block references, encrypted regions, templates or format conversion. Upgrade both clients and server to a version containing TXT support before using it across devices. Older clients cannot select the plain text editor correctly.
