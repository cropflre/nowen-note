# 📚 Nowen Note 教程与帮助中心

> 面向普通用户、NAS 用户、团队管理员和开发者的统一文档入口。

[官方网站](http://nowen.cn/) · [在线体验](http://note.nowen.cn/) · [客户端下载](https://github.com/cropflre/nowen-note/releases) · [问题反馈](https://github.com/cropflre/nowen-note/issues)

## 在线帮助中心

官网帮助中心会跟随正式功能持续更新，适合直接阅读和分享：

| 帮助中心 | 地址 | 适合内容 |
|---|---|---|
| **功能与使用教程** | [Nowen Note 功能介绍](http://nowen.cn/docs/nowen-note-features) | 笔记、编辑器、任务、AI、知识图谱、协作和多端使用 |
| **安装与问题解答** | [Nowen Note 安装与问题解答](http://nowen.cn/docs/nowen-note-help) | Docker、NAS、升级、备份、网络和故障排查 |
| **API 与开发者文档** | [Nowen Note API](http://nowen.cn/docs/nowen-note-api) | OpenAPI、Token、SDK、CLI、MCP 和自动化接入 |

仓库中的 `docs/` 更适合离线阅读、提交修改和跟随源码审查；官网帮助中心更适合最终用户使用。两边会同步维护。

## 推荐阅读路线

| 你的目标 | 建议顺序 |
|---|---|
| **第一次使用** | [5 分钟快速上手](./quick-start.md) → [界面概览](./ui-overview.md) → [创建第一篇笔记](./first-note.md) |
| **部署到 NAS / 服务器** | [Docker 部署](./docker-deploy.md) → [NAS 部署](./nas-deploy.md) → [备份与迁移](./backup-migrate.md) |
| **高效写作和整理知识** | [富文本编辑器](./editor-rich-text.md) → [Markdown 编辑器](./editor-markdown.md) → [标签与收藏](./tags-favorites.md) → [搜索](./search.md) |
| **团队协作与公开发布** | [工作区](./workspace.md) → [实时协作](./realtime-collab.md) → [分享与权限](./sharing.md) |
| **接入 AI 和自动化** | [AI 配置](./ai-setup.md) → [AI 知识问答](./ai-rag.md) → [API](./api.md) → [MCP](./mcp.md) |

---

## 1. 快速上手

| 教程 | 内容 |
|---|---|
| [5 分钟快速上手](./quick-start.md) | 部署、登录、创建笔记、基础编辑与 AI 配置 |
| [界面概览](./ui-overview.md) | 导航栏、文档树、笔记列表、编辑器和设置 |
| [创建第一篇笔记](./first-note.md) | 从笔记本到自动保存的完整流程 |
| [Web 端使用指南](./web.md) | 浏览器访问、功能范围和常用快捷键 |
| [移动端入门](./mobile.md) | 手机端连接服务器、导航和基础操作 |

## 2. 笔记与知识管理

| 教程 | 内容 |
|---|---|
| [文档树与笔记本](../tree-tutorial.md) | 无限层级笔记本、拖拽、排序和 Emoji 图标 |
| [标签、收藏与置顶](./tags-favorites.md) | 跨笔记本分类和快速访问 |
| [全文搜索](./search.md) | 搜索、高亮、筛选与替换 |
| [批量管理](./batch-manage.md) | 多选、移动、删除和 AI 批量整理 |
| [回收站与恢复](./trash-recover.md) | 恢复误删内容和永久删除边界 |
| [版本历史](./version-history.md) | 自动保存、版本查看和内容恢复 |
| [导入与导出](./import-export.md) | Markdown、DOCX、Obsidian、微信收藏和多格式导出 |

近期知识管理能力还包括双向链接、块引用、反向链接和知识图谱，详见[官网功能帮助中心](http://nowen.cn/docs/nowen-note-features/knowledge)。

## 3. 编辑器与内容创作

| 教程 | 内容 |
|---|---|
| [富文本编辑器](./editor-rich-text.md) | 工具栏、快捷键、图片、链接和常用格式 |
| [Markdown 编辑器](./editor-markdown.md) | CodeMirror、实时预览、分屏和 Markdown 语法 |
| [斜杠命令](./slash-commands.md) | 使用 `/` 快速插入内容块和 AI 指令 |
| [高级内容块](./advanced-blocks.md) | 表格、代码块、KaTeX、脚注和媒体内容 |
| [Mermaid 图表](./mermaid.md) | 流程图、时序图、类图和甘特图 |
| [附件管理](./attachments.md) | 上传、引用、预览、下载和清理附件 |

## 4. AI 功能

| 教程 | 内容 |
|---|---|
| [配置 AI 服务商](./ai-setup.md) | OpenAI 兼容接口、通义千问、DeepSeek、豆包、Gemini 和 Ollama |
| [AI 写作助手](./ai-writing.md) | 续写、改写、翻译和格式整理 |
| [生成标题与标签](./ai-title-tags.md) | 根据正文自动生成标题和分类建议 |
| [AI 总结](./ai-summary.md) | 生成摘要、要点并追加到正文 |
| [AI 知识问答（RAG）](./ai-rag.md) | Embedding、知识检索、引用原文和结果核对 |

AI 配置按用户保存。管理员和普通用户可以使用各自的模型与 Embedding 配置，避免多人共用同一组密钥。

## 5. 任务、说说与思维导图

| 教程 | 内容 |
|---|---|
| [待办任务中心](./tasks.md) | 树形任务、看板、日历、甘特图、依赖、重复、提醒和模板 |
| [说说 / 时间线](./diary.md) | 发布短内容、图片和生活记录 |
| [思维导图入门](./mindmap-intro.md) | 节点创建、拖拽、缩放和文件夹管理 |
| [从笔记生成导图](./mindmap-from-note.md) | 使用 AI 把笔记转换为层级结构 |
| [导图导出与分享](./mindmap-export.md) | PNG 导出、分享和展示 |

## 6. 协作、分享与公开知识空间

| 教程 | 内容 |
|---|---|
| [工作区](./workspace.md) | 创建团队空间、邀请成员和角色管理 |
| [实时协作](./realtime-collab.md) | Yjs 协同编辑、多端同步和冲突处理 |
| [分享与权限](./sharing.md) | 查看、评论、编辑、登录限制、密码和有效期 |

Nowen Note 还支持把笔记本发布为公开知识空间，并按目录继承或覆盖查看、评论和管理权限。公开地址应配置正确的 `PUBLIC_WEB_ORIGIN`。

## 7. 多端客户端

| 平台 | 教程 / 状态 |
|---|---|
| **Web** | [Web 端指南](./web.md)，无需安装客户端 |
| **Windows / macOS / Linux** | [桌面端指南](./desktop.md)，安装包以 [Releases](https://github.com/cropflre/nowen-note/releases) 为准 |
| **Android** | [Android 指南](./android.md)，正式维护的移动端 |
| **iOS** | Capacitor 工程与 TestFlight 流程，参见 [iOS 发布指南](../iOS-Release.md) |
| **HarmonyOS** | [鸿蒙端指南](./harmony.md)，ArkTS + ArkWeb 客户端仍在逐步完善原生能力 |

## 8. 部署、升级与数据安全

| 教程 | 内容 |
|---|---|
| [Docker 一键部署](./docker-deploy.md) | Docker Compose v2、端口、数据卷和日志 |
| [NAS 部署](./nas-deploy.md) | 群晖、绿联、飞牛、威联通和极空间 |
| [Windows 本地部署](./windows-deploy.md) | Node.js 本地运行和开发环境 |
| [完整部署指南](../deployment.md) | 桌面端、移动端、NAS 和 ARM64 汇总 |
| [ARM64 部署](../deploy-arm64.md) | ARM64 镜像和国产 SoC 注意事项 |
| [备份与迁移](./backup-migrate.md) | 数据库、附件、自动备份和恢复演练 |
| [Docker 在线升级](../docker-online-update.md) | 升级前检查、完整备份、健康验证和失败回滚 |
| [对象存储](../object-storage.md) | S3、Cloudflare R2 和 MinIO |
| [安全设置](./security.md) | 密码、2FA、Token、CORS、HTTPS 和审计日志 |

> Docker 在线升级只支持官方 Compose 受管部署。镜像回滚不等于数据库回滚，生产环境必须保留独立备份。

## 9. 开发者与自动化

| 教程 | 内容 |
|---|---|
| [OpenAPI](./api.md) | REST API、鉴权和接口调试 |
| [TypeScript SDK](./sdk.md) | 在 Node.js / TypeScript 中调用 Nowen Note |
| [CLI](./cli.md) | 命令行管理笔记、附件和其他资源 |
| [MCP Server](./mcp.md) | 让支持 MCP 的 AI 客户端访问知识库 |
| [Webhook](./webhook.md) | 事件通知和外部工作流 |
| [浏览器剪藏](./clipper.md) | 从 Chrome / Edge 保存网页内容 |

Personal API Token 支持权限范围和笔记本资源范围。自动化场景应遵循最小权限原则，不要把管理员 Token 写入公开脚本。

## 10. 常见问题

| 教程 | 内容 |
|---|---|
| [登录与鉴权](./faq-login.md) | 登录失败、默认账号、2FA 和密码重置 |
| [同步问题](./faq-sync.md) | 离线队列、多端同步和冲突副本 |
| [附件与图片](./faq-attachment.md) | 上传失败、裂图、权限和清理问题 |
| [性能与存储](./faq-performance.md) | 首屏、数据库、缩略图和磁盘空间 |

更多安装与故障排查请使用[官网安装与问题解答](http://nowen.cn/docs/nowen-note-help)。

---

## 文档维护说明

- 教程内容以 `main` 分支当前实现和最新稳定 Release 为准，不再绑定某个过期版本号。
- 新功能应同时更新仓库教程入口和 `nowen-blog` 官网帮助中心。
- 安装包、平台支持范围和版本号以 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 为准。
- 发现过期步骤或错误链接，请直接提交 [Issue](https://github.com/cropflre/nowen-note/issues)。
