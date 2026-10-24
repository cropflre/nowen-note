# 当前笔记 AI 助手入口验收（2026-10-24）

工作区为 `codex/ai-agent-p2`，基线 `44055cda`；记录随入口改动提交，尚未推送或发布。原发布目录与 P1 工作区未修改。

## 行为与范围

- 移除独占一行的「编辑器 Agent」，桌面入口并入原顶部 AI 操作组，手机入口为顶部星光按钮，名称统一为「AI 助手」。显示展开状态及受控面板关系。
- 移除富文本和 Markdown 格式工具栏中的重复星光入口；选区浮层保留原快捷写作流程，提示明确为「改写选中文字」。
- 助手展示当前笔记标题与选区，区分空白起草、全文整理和选区修改。快捷操作只填入指令，不自动发送；连接检查有独立加载状态。
- 右侧面板复用 `app-surface`、`app-border`、`tx-*`、`accent-primary` 语义变量与原 Button，不添加主题或装饰动画。手机全屏，正文与结果区独立滚动，底部保留安全区；自动聚焦输入，面板内 Escape 收起，关闭恢复焦点，手机 Tab 不离开助手。
- 为兑现空白场景的起草入口，允许单个空文档草稿提案：仅空字符串 Markdown 或一个空段落的富文本；空格、附件、其他块、已有文字及多个插入拒绝。富文本以纯文本插入并保留段落属性。
- 草稿仍经快照/版本校验、差异预览、一次性审批、编辑器可撤销事务与原保存路径；审批本身不写笔记。未改变同步或外部工具授权。

## 本地结果

| 检查 | 结果 |
| --- | --- |
| 前端 Agent、文本范围、移动工具栏、快捷写作布局 | 45/45 |
| 后端 Agent、工作流、MCP、原 AI/任务/自动化、迁移及 Outbox | 93 通过；真实 MCP 1 项无配置跳过 |
| 生产前端 Web E2E | 7 通过；真实模型 2 项无配置跳过 |
| macOS arm64 / Electron 33.0.0 / Chromium 130.0.6723.44 渲染器 E2E | 2/2，两种编辑器 |
| 前端 TypeScript/生产构建、后端 TypeScript/bundle | 通过 |
| 修改面板、文本范围、相关测试与 E2E 的 ESLint | 通过 |
| DCC 与 diff 检查 | 12 invariants / 188 references；通过 |

新增用例先复现缺失的空白引导、选区范围与空文档提案失败，再验证修正。真实后端与两种编辑器覆盖：入口位于原有 header、900/1024/1440 宽度不横溢、快捷操作零请求、审批前零写入、保存收据、撤销/重做、选区提示、390×667 手机布局、键盘焦点、中英文、明暗主题及 reduced motion。截图均为隔离合成笔记，经人工查看；未使用真实模型或私人内容。

截图与源文件 SHA-256 在被忽略的 `data/agent-ui-2026-10-24/`；Web、Electron 详细运行文件分别在 `/tmp/nowen-agent-ux-browser/` 和 `/tmp/nowen-agent-ux-electron/`，可被系统清理。日志为 `/tmp/nowen-agent-ux-{regression,browser,electron,frontend-build}.log`。执行命令沿用 `frontend/playwright.agent.config.ts`；Electron 增加 `NOWEN_AGENT_ELECTRON=1` 并筛选 `AI assistant entry`。

本轮是本地 UI 与受控模型回归，不替代真实模型/MCP、远端 CI、Windows/Android 实机、桌面打包主进程/原生桥或真实设备同步验收。
