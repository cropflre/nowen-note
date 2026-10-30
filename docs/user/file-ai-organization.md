# 文件 AI 辅助整理 / AI-assisted file organization

Phase E 开发功能，尚未发布。使用已有文件、文件夹、附件标签和个人 AI 配置，不复制或重新上传文件。

## 使用

1. 在文件中心选择文件，点击「AI 帮我整理」。未选择时，只分析当前页前 50 个可管理文件；弹窗打开后固定本次候选集合。
2. 阅读说明并勾选同意。文件名、类型、大小、目录名、现有标签和描述会发送给你配置的 AI 服务。服务可能在外部并产生费用；不会发送文件字节、笔记正文或引用笔记标题。
3. 生成建议后，检查目标目录、要添加的标签与描述。可以改选已有目录、新建根目录、修改标签和描述，或取消部分文件。
4. 点击「确认整理 N 个文件」才执行。已有标签保留，建议标签追加；描述按审核后的文本替换。操作不会删除文件、改名、改变附件 ID、存储对象或笔记引用。
5. 文件在预览后变化时，重新生成建议。提交后网络异常时，直接重试会使用原请求；不要把未知结果当成未执行。

文件详情显示已确认的描述；普通搜索同时匹配文件名、标签和描述，无需 AI。

## 语义搜索

「语义搜索」使用你已有的 Embedding 配置。每次按权限过滤后扫描最多 100 个文件，发送查询及这些文件的名称、MIME、标签和描述，按向量余弦相似度排序。「继续扫描下一批」会继续请求并合并排序。

这是按需的文字元数据检索，没有后台自动建索引；重复查询或继续扫描可能产生新的模型费用。首次一批不代表全库已扫描。未配置模型或服务故障时，可关闭弹窗使用普通搜索。

不会读取文件正文、OCR 或图片内容。D4 的本地视觉相似图片比较仍可使用，与图片语义模型不同；本阶段没有启用可选图片语义和图片向量检索。

## 权限与平台边界

- 仅能整理当前作用域内、本人可管理的文件；工作区支持标签和描述，不创建或移动个人文件夹。搜索仅返回可下载且未受保护的文件。
- 锁定笔记、加密笔记、密码保护目录以及与这些笔记关联的附件均排除在 AI 路径之外。
- Web 与未启用桌面同步的 Electron SQLite 实例支持整理。启用了桌面同步的实例在调用整理模型前明确拒绝，避免标签/描述产生未同步写入；可以在服务端 Web 文件中心操作。
- Native 本地文件的 E 功能暂不支持，界面与传输层均拒绝，不影响原有上传、浏览、目录与搜索功能。
- 描述属于附件作用域元数据；跨账号或工作区转移会清除原描述以防泄漏。完整 SQLite 数据库备份包含描述与确认记录；普通文件导出不宣称包含这些元数据。
- 没有「撤销」按钮。确认前逐项复核；整批写入失败会回滚并保留既有待同步队列。

## English

This development feature reuses existing attachments, folders, tags and per-user AI settings. It has not been released.

Select files and choose **Organize with AI**, or process the first 50 manageable files on the current page. Review and consent to sending metadata to your configured service, which may be external and may charge fees. No file bytes, note bodies or referenced-note titles are sent. Protected files are excluded. Descriptions are inferred from metadata rather than the file contents.

Suggestions remain read-only drafts. Edit the destination, additive tags and description, exclude individual files, then explicitly confirm the displayed count. Existing tags remain; reviewed descriptions replace previous descriptions. File IDs, bytes, storage paths and note references stay intact. Stale files require a fresh preview. An uncertain submission can be retried with its original request ID without applying it twice.

**Semantic search** uses your existing Embedding settings and ranks up to 100 eligible metadata records per batch. Continue scanning to cover more of the current scope. This is on-demand metadata vector search, without a persistent background index, OCR or image-model calls. Each scan may incur fees. Ordinary filename/tag/description search works without AI.

Organization works in Web and Electron SQLite instances without desktop sync. Desktop sync instances reject organization before model invocation because tags/descriptions are not yet synchronized. Native local mode explicitly rejects these features. Workspace organization supports owned editable files' tags and descriptions, without personal-folder moves. Descriptions are cleared on account/workspace transfers; full SQLite database backups preserve them. Optional image semantics are not enabled; D4 visual similarity is a separate capability. No undo is advertised.
