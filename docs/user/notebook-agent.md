# 笔记本 Agent / Notebook Agent

## 中文

在 AI 设置中配置支持工具调用的模型并启用 AI，然后打开「AI 对话 → Agent」。选择笔记本，决定是否包含子笔记本，描述需要的结果，例如：“总结这些会议记录，创建一篇总结笔记，并提取后续任务”。处理的是服务器已保存的笔记；修改当前编辑器草稿请使用「编辑器 Agent」。

开始前会显示数据发送说明。请求、检索到的可读笔记片段和任务上下文会发送给你配置的模型服务。密码目录、锁定笔记和加密内容不可用于此流程。范围选择限定可检索的笔记，但检索有数量和上下文预算，总结不代表完整读遍所有笔记。

查看来源链接、总结、新笔记正文和每条任务的日期、优先级、重复规则及警告。截断提示说明模型只看到了部分材料。仅总结不会创建数据；包含笔记或任务的提案，只有点击「确认并创建所示草稿」后才写入。拒绝不会创建草稿中的资源。任务优先关联新建的笔记；没有新建笔记时，可在运行前选择关联当前范围内的现有笔记。

任务可以逐条修改标题、描述和优先级，在「日期与重复规则」中调整时间与周期，取消勾选可排除该项，也可重新勾选。修改后先点击「核查任务修改」，服务端检查所选任务并返回新预览，再确认创建；核查本身不会创建资源。校验失败会保留输入，也可「放弃任务修改」恢复上次预览。排除全部任务后不会创建任务，提案中的笔记或外部动作仍需确认。任务创建完成后不能在该提案内再次修改。

创建后可直接打开笔记和任务，也可在历史记录中查看结果。如果笔记成功、任务失败，已创建的笔记会保留；「重试」仅针对未完成动作，并需重新确认。停止不会撤销已经成功的创建。

审批时断网或响应丢失，界面会先核查服务器结果；无法确认时，使用「核查执行结果」，不要直接重复创建。该流程需要联网，不会把审批放入离线队列。草稿十分钟后或服务重启后失效，结果链接和可访问的来源记录仍保留；检查已有结果后再发起新请求。历史元数据保留三十天。完成表示当前服务器已保存，其他设备仍以正常同步状态为准。

## English

Configure a model with tool calling and enable AI in settings. Open **AI Chat → Agent**, select a notebook and whether to include child notebooks, then describe the outcome. For example: “Summarize these meeting notes, create a summary note and extract follow-up tasks.” This flow reads saved server notes. Use **Editor Agent** for changes to the current editor draft.

The privacy notice explains what is sent before you start. Your request, readable retrieved note excerpts and task context go to your configured provider. Password-protected folders, locked notes and encrypted content are unavailable. Retrieval and context limits mean a summary may cover only part of the selected notebook.

Review source links, summary, new note content, task dates, priority, recurrence and warnings. A truncation notice means some evidence was omitted. A summary alone creates nothing. Note/task drafts are saved only after **Approve and create the displayed drafts**. Rejecting creates none of those resources. Tasks link to the new note if one is created; otherwise you may explicitly link an existing note inside the selected scope before starting.

Edit each task's title, description and priority; expand **Dates and recurrence** for scheduling. Uncheck a candidate to exclude it or recheck it to include it again. After editing, choose **Review task changes**. The server validates selected tasks and returns a fresh preview before you approve creation; review itself creates nothing. Failed validation preserves your input; **Discard task changes** restores the last server preview. Excluding every task creates none, while any note or external action still needs confirmation. Completed task creation cannot be edited within that proposal.

Open the created notes/tasks directly or inspect execution history. If the note succeeds and tasks fail, the note remains. Retry proposes only unfinished actions and requires fresh approval. Stop prevents future work and does not undo completed creation.

When an approval response is lost, the UI checks server results first. If that check fails, use **Check execution results** before taking further action. Approval requires a connection and is never queued for offline replay. Draft details expire ten minutes after starting or on server restart; result links and accessible source references remain. Inspect existing results before starting a new request. Metadata is retained for thirty days. Completion confirms saving on this server; other devices still rely on normal synchronization.
