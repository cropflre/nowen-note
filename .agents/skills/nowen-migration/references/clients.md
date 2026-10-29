# 客户端交付说明

这些说明适配工作方式，不代表相应产品或版本已经验收。当前自动化覆盖真实 MCP SDK Client 的 stdio 与受保护 Streamable HTTP；WorkBuddy、Qoder/QoderWork、Claude Code、Codex、豆包工作的实际应用版本必须分别记录验证结果。

从 Nowen **让 AI 帮我迁移** 的接入引导生成配置。迁移准备需要个人 API Token、read-write 模式；受限 Token 选择目标笔记本的写权限并包含后代。最小权限按实例能力提示配置；带标签、附件的数据还需要相应写权限。HTTP gateway bearer 与 Nowen API Token 是不同凭据，不向模型或来源文件泄露它们。

| 客户端 | 交付方式 | 验证与回退 |
| --- | --- | --- |
| WorkBuddy | 在当前版本提供的 MCP/工具连接配置中接入 Nowen；复制下面的任务指令 | 先确认工具列表有 `nowen_migration_capabilities`；没有时交付标准 ZIP |
| Qoder / QoderWork | 使用宿主支持的 MCP 配置或工作目录 Skill；保持来源文件访问范围受用户授权约束 | 不假定两种产品或版本传输能力一致；不支持时交付标准 ZIP |
| Claude Code | 将 Skill 放入当前项目的技能发现目录，使用 Nowen 生成的 stdio 配置 | 本地文件上传须由宿主授权；实际应用调用另行验收 |
| Codex | 将 Skill 放入当前项目 `.agents/skills/nowen-migration`，使用 Nowen 生成的连接配置 | 先查询能力；没有可用 MCP 工具时生成文件包 |
| 豆包工作 | 若当前版本支持 MCP，则使用 Nowen 接入引导；否则让 AI 整理导出文件 | 不承诺任意版本支持本地路径、stdio 或 HTTP；始终保留文件包方式 |
| 其他 MCP 客户端 | 使用兼容的 stdio 或受保护 Streamable HTTP，先列工具再查询能力 | HTTP 不支持读取服务器本地路径；批准操作在 Nowen 完成 |

通用任务指令（替换方括号部分）：

> 请把我已授权的 [来源与导出文件位置] 迁移到 Nowen Note 的 [目标位置]。先查询迁移能力，保留目录、时间、标签、附件和支持的内部链接；不删除来源，不覆盖已有笔记。用统一迁移任务准备数据并生成预览，告诉我无法迁移的部分，等待我在 Nowen 中确认。确认后跟踪状态，失败时只重试失败项，最后给我数量与报告。若当前客户端没有可用 MCP，请生成 Nowen 支持的标准文件包供我上传。
