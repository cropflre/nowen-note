# Agent 模板与自动整理 / Templates and recurring organization

## 中文

编辑当前笔记时，从顶部操作栏打开「AI 助手」；手机上点击顶部星光按钮。空白笔记提供起草和提纲引导，有正文时提供润色、摘要和表达整理，选中文字后会显示选区提示。快捷操作只填入指令，点击「生成提案」才会发送当前笔记快照和指令。修改先展示差异，确认后经编辑器保存；可撤销、重做。编辑器选区浮层中的「改写选中文字」保留原有快捷写作流程。

从零起草仅适用于完全空白的 Markdown 或只有一个空段落的富文本笔记；含附件或其他内容的笔记继续使用精确文本修改。富文本草稿按纯文本插入，不自动解析 Markdown 排版。发送范围与确认方式可在助手底部展开；助手内按 Escape 或点击关闭按钮收起。

进入「AI 对话 → Agent → 模板与自动整理」。创建模板，选择固定笔记本、是否包含子笔记本和整理指令。也可以从自己的已有 Prompt 复制内容。新模板默认只有读取和总结能力；需要创建笔记、任务或调用外部工具时，逐项勾选授权并保存。

选择「使用模板」后按原 Agent 流程生成、查看来源并审批。模板执行使用已保存的范围和指令；若需临时自由输入，选择「改用自定义请求」，该请求不会继承模板的外部工具授权。模板修改或工具更新后，旧提案不能继续审批，需要重新生成。

在已保存的模板下，可选择每天、每周、笔记事件或签名 Webhook。定期任务可设置时间及时区。新计划先保存为暂停状态，再点击「启用」。事件仅请求运行固定模板；Webhook 正文不会被当作指令。查看 Agent 的执行记录，审批生成的笔记、任务和外部动作。计划的暂停/删除和运行记录也可通过原有自动化中心管理。更改模板后需要创建新的计划并暂停旧计划。

自动整理要求后端持续运行。桌面端关闭程序后不会继续定时执行；需要全天运行时应使用持续在线的服务端。自动触发只生成待审批提案，不能无人确认地写入。提案仍遵循十分钟有效期，服务器重启后失效；请及时查看执行记录。计划完成只代表提案已生成或排队，实际保存以 Agent 结果为准。

外部工具连接位于折叠设置中。填入公网 HTTPS 接口、允许的工具名称和可选访问令牌，再点击「核查可用工具」，将需要的工具勾选到模板。当前支持 MCP 2026-07-28 的无会话 HTTP 服务；不支持本机/内网服务、旧版会话协议或启动本地命令。令牌不会回显；撤销连接会同时撤销相关模板能力。

插件仅开放官方或已验证的 QuickJS 沙箱动作，权限限于自身插件存储；不会自动开放已有插件对整个笔记库、网络或本地 Node 的访问。每次外部动作仍会展示目标和将发送的参数，请核对后审批。调用结果显示供你查看，不会自动触发后续修改。

如果外部调用返回不确定结果，先到目标服务核查，不能直接重试。停止可以阻止后续动作，但无法撤销已经发送的远端请求。模板、计划和连接属于服务器配置，不经 Sync V2 分发；其创建的笔记、任务仍走原有保存与同步流程。备份恢复会暂停计划并撤销外部凭据，需要重新配置和授权。

## English

Open **AI Assistant** in the note's top action bar (the sparkle button on mobile). Empty notes offer drafting/outline guidance; existing notes offer polishing, a summary and clearer wording. Selected text is shown as the target. Shortcuts only fill the instruction; **Generate proposal** sends the current note snapshot and instruction. Preview and approve changes before the editor saves them; undo/redo remain available. **Rewrite selected text** in the selection toolbar keeps the existing quick-writing flow.

Draft insertion is limited to empty Markdown or rich text with one empty paragraph. Notes containing attachments or other content retain precise text edits. Rich-text drafts insert plain text, without interpreting Markdown formatting. Expand the disclosure below the input to review what is sent. Press Escape within the assistant or use its close button to collapse it.

Open **AI Chat → Agent → Templates and recurring organization**. Save a template with a fixed notebook scope and instruction, or copy one of your personal saved Prompts. New templates start with read/summary permission only. Explicitly select permission to propose notes, tasks and individual extension tools before saving.

Choose **Use template** to generate and review an approval-bound proposal. Execution uses the saved instruction/scope. **Use a custom request** returns to free input and does not inherit external-tool grants. Editing a template or changing its tool catalog invalidates older proposals; generate again.

Saved templates can create daily/weekly schedules, note-event plans or signed webhooks. Set the local time/timezone, save the plan in its disabled state, then explicitly enable it. Event/webhook input cannot replace template instructions. Review generated proposals in Agent execution history; creation and external actions still need approval. Use the existing Automation Center for plan deletion and run inspection. Template changes require a replacement plan and pausing the old one.

The backend must stay online. An embedded desktop backend does not schedule while the app is closed. Proposals retain the ten-minute lifetime and expire after restart, so review them promptly. A completed Automation run means the Agent proposal was queued/generated, not that its resources were approved or saved. Unattended writing is not enabled.

External connections accept public HTTPS MCP **2026-07-28 stateless HTTP** endpoints, optional bearer credentials and an explicit tool-name allowlist. Check available tools, then grant them to a template. Local/private endpoints, redirects, legacy session protocols and local process launch are unavailable. Revoking a connection revokes dependent grants. Credentials are not returned by listing APIs.

Only official/verified QuickJS plugin actions with no library/network authority are eligible; their own plugin-storage permissions may be used. Review the exact destination and parameters before approving any external call. Results are shown as text for inspection, not automatically used for follow-up changes. An uncertain outcome cannot be replayed safely: check the target service first. Stop prevents later calls but cannot undo an already sent request.

Templates/plans/connections are server configuration and do not sync through Sync V2. Created notes/tasks retain normal persistence and sync behavior. Backup restoration pauses plans and revokes external credentials pending reconfiguration.
