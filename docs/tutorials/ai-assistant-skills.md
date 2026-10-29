# AI 助手自定义 Skill

在 AI 助手的「问答」页，使用「自定义 Skill」选择本次回答要遵循的个人指令。点击「管理 Skill」打开弹窗，即可新增、编辑、删除或导入；主界面只保留紧凑的选择框和管理入口。关闭弹窗会保留尚未保存的编辑，离开助手前请保存。

1. 输入 Skill 名称和指令，例如「周报」与「按项目汇总进展、风险和下一步；没有依据的内容标为待确认」。
2. 点击「添加个人 Skill」，然后在「自定义 Skill」中选择它。
3. 正常输入问题。Skill 会用于后续问答，也适用于当前整篇笔记和选中文本范围。
4. 选择「不使用 Skill」即可停用。修改已选 Skill 后，下次请求读取最新内容；删除后需要重新选择。

可以导入 `.md` 或 `.txt` 文件，包括纯文本的 `SKILL.md`。导入只填充编辑草稿，核对名称和内容后点击添加才会保存。名称最多 80 字符，指令最多 4000 字符；文件不超过 20000 字节。名称默认取 Markdown 一级标题或文件名。

Skill 与写作助手、AI 快记的个人指令共用存储，归当前用户所有。保存到当前连接的后端数据库；连接同一服务端账号可读取，独立桌面后端之间不保证自动同步。重新打开助手后会重新加载已保存的 Skill，使用前重新选择；切换账号、服务端或工作空间会清除选择。

这版 Skill 提供回答指令，不运行脚本或安装依赖，也不增加笔记访问权限。知识库检索仍使用问题和已选范围，Skill 内容不作为来源证据。Agent 模式及直接任务命令不应用此选项。导入前请检查文件内容；使用时指令会随问题发往当前配置的 AI 服务。

## English

In the AI assistant's **Questions** tab, choose a **Custom Skill** to guide subsequent answers. Click **Manage Skills** to open a dialog for creating, editing, deleting, or importing Markdown/TXT instructions. The chat toolbar keeps only the compact selector and management button. Closing the dialog retains unsaved edits while the assistant remains open; save them before leaving. Imports fill an editable draft; save it explicitly, then select it. Choose **No Skill** to disable it. Edits apply to the next request.

Names allow 80 characters, instructions 4,000 characters, and imported files 20,000 bytes. The default name comes from a Markdown level-one heading or the filename. Plain-text `SKILL.md` files are accepted.

Skills share the writing assistant and AI capture personal-instruction store. They are saved in the connected backend for the current account. Reopening reloads saved Skills but requires selecting one again. Account, server, or workspace changes clear the selection. Separate desktop backends do not automatically share these records.

This version supplies instructions only. It does not execute scripts, install dependencies, expand access permissions, or treat the instructions as source evidence. It supports knowledge, current-note, and selection questions; Agent mode and direct task commands are unaffected. Selected instructions are sent to the configured AI provider with the question.
