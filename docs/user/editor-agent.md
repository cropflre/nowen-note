# 编辑器 Agent / Editor Agent

打开 Markdown 或富文本笔记，点击顶部“AI 助手”。输入目标，例如“帮我优化这篇文档，保留技术细节”，点击“生成提案”。Agent 使用当前编辑器快照，包括尚未保存的修改，并可读取选区。

百炼模型使用其 OpenAI 兼容接口配置。已验证 `deepseek-v4.1-flash-1017` 的 Markdown、富文本与两篇笔记短摘要流程；Agent 请求会关闭思考模式以执行工具调用。请使用支持 Function Calling 的模型，具体接入地址以百炼控制台为准。

生成前会说明外发范围：当前笔记、选区和指令会发送给你配置的 AI 服务。密码保护目录、加密内容、回收站和无写权限的笔记不可用。关闭已有 AI 开关或由管理员设置 `NOWEN_AGENT_ENABLED=false` 可以禁用。

查看每项修改前后的文字，选择“接受修改”或“拒绝”。拒绝不改变原文；接受通过编辑器的正常保存流程应用，可使用编辑器的撤销/重做。审批期间再次编辑会使旧提案失效，请拒绝后重新生成。

“已应用，正在核验保存”不代表保存成功。只有核验正文和版本后才显示完成；其他设备是否收到请看同步收据。断网或保存失败时保留现有草稿/队列，不要重复接受。同一运行无法重复审批。

“停止”终止后续执行，不撤销已经进入编辑器的修改。收起面板会停止未完成运行。服务重启后未完成运行标记为中断，需要核查后重新生成。

不支持工具调用的模型会显示明确提示；可切换模型，或回到原有问答模式生成草稿。P0 支持安全的文本级改写，不自动重构复杂富文本结构、删除附件、创建任务或运行外部工具。原问答聊天记录保留；聊天中心的 Agent 入口引导到当前编辑器。

---

Open a Markdown or rich-text note and choose **AI Assistant** in the top bar. Describe the change and generate a proposal. Agent reads the live editor snapshot, including unsaved changes and selection. The privacy notice explains that this content goes to your configured AI provider.

Configure Bailian through its OpenAI-compatible endpoint. `deepseek-v4.1-flash-1017` has been verified with Markdown, rich text and a short two-note summary. Agent tool requests disable thinking mode. Select a model with Function Calling support and use the endpoint shown in your Bailian console.

Review the before/after text, then accept or reject. Accepted changes use the existing editor save path and support undo/redo. If you edit while approval is pending, reject the stale proposal and generate again. Password-protected, encrypted, trashed and non-editable notes are unavailable.

**Applied; verifying save** is not a success receipt. Completion requires matching persisted content and a compatible version. Check existing sync receipts for other devices. Failed or offline saves keep the editor's normal draft/queue; do not apply twice.

Stop/collapse prevents later execution but does not undo edits already applied. A server restart interrupts unfinished runs. Unsupported models can still use the existing Q&A drafting mode. P0 only makes safe text-level edits; task creation, structural rich-text rewrites and external tools are not enabled. Existing chat history remains available.
