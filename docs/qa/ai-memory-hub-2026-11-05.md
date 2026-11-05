# AI Memory Hub — 归档 MVP 验收记录

执行日期：2026-11-05 至 2026-11-06（Asia/Shanghai）。基线 `release/v1.6.0@861c4d2a5`，开发分支 `codex/ai-memory-hub-v160`。使用隔离 worktree、临时 SQLite、合成用户和浏览器独立 profile；未导入私人聊天或修改原工作区未提交内容。

## 阶段交付

| 阶段 | 提交 | 实际内容 |
|---|---|---|
| Phase 0 | `2944afb3f` | 真实源码审计、API/数据/权限与同步边界冻结 |
| Phase 1 | `e5ef2ead6` | SQLite146、来源、事务接收、精确幂等回执、原始消息/修订、笔记投影、安全删除/恢复/导出 |
| Phase 2 | `550c11002` | ChatGPT/豆包明确授权的预览、手动保存、精确会话自动采集、受限持久队列、撤销与来源校验 |
| Phase 3 | `d5470a144` | 历史 ZIP/分卷/标准及原生 JSON 导入、任务预览/取消/重试/报告、AI 记忆归档管理界面 |

Phase 4–6 未实现。长期记忆明确显示尚未开放，原 MCP 工具没有伪装成新的记忆工具。不创建正式 Release，不合并 main/release 分支。

## 自动化证据

运行环境：macOS arm64，Node24.22.1，Electron43.8.4。后端原生 SQLite 当前编译为 Electron ABI，实际数据库测试使用 `ELECTRON_RUN_AS_NODE=1` 的 Electron runtime；普通 Node 的 ABI 不匹配不作为测试通过。

| 检查 | 结果 |
|---|---|
| 后端 AI 归档/真实 HTTP/解析/任务定向 | **39/39 通过**（归档19、HTTP1、解析11、任务8） |
| Clipper `npm run lint` / `npm test` / `npm run build` | **通过；40/40 测试通过**；独立经典 content.js 构建守卫通过 |
| 后端 `npm run build:tsc` + `npm run build` | **通过**；编译后重新生成 bundle，避免 tsc 覆盖 bundle |
| 历史 P0/P1 实库升级、Docker 形状插件产物、工作区议题 | **13/13 复跑通过**，schema146，既有笔记/Outbox 保留 |
| 前端 AI 记忆组件 | **5/5 通过** |
| 前端 `npm run build` | **通过**；保留既有 bundle-size / Browserslist 警告 |
| MCP `npm test` | **35/35 通过**；本轮未改 MCP 产品代码 |
| DCC `--verify` | **12 不变量 / 251 引用通过**；映射不替代真实行为测试 |
| Chromium 实际 MV3 + 真实后端/界面 | **18/18 通过**，见 [browser.json](ai-memory-hub-2026-11-05/browser.json) |
| 最终后端完整串行回归 | **416 文件：412 通过、4 个已在原基线复现的失败，无超时**；见 [checks.json](ai-memory-hub-2026-11-05/checks.json) |
| 最终前端完整回归 | **736 文件：732 通过、4 失败；4232 用例：4221 通过、11 失败**；分项如下 |

后端 39 项覆盖迁移保留旧数据、事务回滚、正文及操作 ID 幂等、消息修订/顺序/部分消息、不保存流式文本、撤销/Token/跨账号拒绝、保护笔记/Yjs、回收站及永久删除、含归档账号转移拒绝、原生 JSON 结构化往返、恶意 ZIP 与内容校验、任务取消及重试。

## 完整回归失败审计

基线使用另一份未修改的 `861c4d2a5` 临时 worktree、相同依赖和 runtime 定向复跑，未修改测试来隐藏失败。

| 测试 | 当前结果与基线证据 |
|---|---|
| 后端 `attachment-heif.test.ts` | HEIF 缓存清理预期失败；原基线同样复现 |
| 后端 `openapi-content-format.test.ts` | 旧格式枚举正则不匹配；原基线同样复现 |
| 后端 `plugin-studio-projects.test.ts` | 文件系统竞态注入的预期异常未出现；原基线同样复现 |
| 后端 `remote-image-localization-service.test.ts` | 自动批量任务遇到已有活动任务；原基线同样复现 |
| 前端 `DataManagerNavigation.test.tsx`（2例） | 原基线同样复现按钮查找失败 |
| 前端 `DataProtectionFlows.test.tsx`（4例） | 原基线同样复现入口断言失败 |
| 前端 `FileOrganization.test.tsx`（4例） | 原基线同样缺 getCurrentWorkspace mock |
| 前端 `markdownLivePreview.test.tsx`（1例） | 最终全量中失败；当前与原基线定向复跑均 **8/8通过**，保留不稳定记录 |

开发中发现的缺构建产物、schema145 写死断言及一次工作区议题失败，已分别通过重新打包、使用 CURRENT_SCHEMA_VERSION 和定向复跑核实，不混入上述基线失败。

## 浏览器与视觉验收

运行：

```sh
# 先安装根、backend、frontend、Clipper 依赖并构建扩展。
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/accept-ai-memory-hub.mjs
```

该脚本启动隔离的真实产品后端、创建合成账号/个人笔记本，Vite 挂载真实 AIMemoryHub，再加载构建后的 MV3 扩展。ChatGPT/豆包 URL 由 Playwright 本地 fulfill，**没有连接真实聊天账号**。

验证真实回执及重读、未授权未上传、预览可见代码/隐藏文本排除、生成中不保存/稳定后单份保存、刷新、503 待发送队列与重连、来源撤销后停止，以及真实文件预览/明确确认/后台持久化、脚本文本不执行、原始 JSON 下载。

界面检查 1280/360px × 深/浅主题，reduced-motion，无横向溢出。复用现有 surface/background/text/border/accent tokens、原生表单与键盘焦点，没有增加装饰动画。导入和归档卡片在窄屏折行；实际安装版 dialog、屏幕阅读器、移动软键盘和 wallpaper/lite-mode 的完整人工验收未完成。

[浅色桌面](ai-memory-hub-2026-11-05/light-1280.png) · [浅色窄屏](ai-memory-hub-2026-11-05/light-360.png) · [深色桌面](ai-memory-hub-2026-11-05/dark-1280.png) · [深色窄屏](ai-memory-hub-2026-11-05/dark-360.png) · [导入预览](ai-memory-hub-2026-11-05/import-preview-dark-360.png)

## 安全与剩余边界

自动采集默认关闭，正文读取须先授权；在线自动采集前重查来源，失败回执不出队，队列/凭据绑定实例、用户及会话。解析和网页文本作为数据，不执行脚本或提示指令，不读 Cookie/密码/隐藏 API，不将正文记入普通日志。原生导出使用单个读事务；再导入保留结构化证据和时间。

必须保留的限制：

- 真实 ChatGPT/豆包、Chrome/Edge 安装、Windows/Linux、Electron/NAS/移动设备和生产账号未验收；DOM Fixture 不能代替真实网站。
- 原始归档只在接收实例，新增表未加入 Sync V2；笔记投影沿原同步链路，不宣称第二设备有完整结构化归档。
- 广泛 host permissions 沿用普通 Clipper，仅新增 alarms；没有完成 optional host permissions 的整体迁移或 Web Store 提交。
- 离线无法即时得知异地撤销，授权/验证后的七天内允许本地暂存；本地存储未宣称静态加密。
- 不下载附件，仅保留可见文字/引用；ChatGPT 只导入已选择分支，遗漏有报告。
- 暂存任务24小时；超限文件/消息明确拒绝。累计归档 JSON 超过单项导入限额时不能直接整篇重新导入，完整恢复使用全库备份。
- 用户改过或有 Yjs 历史的投影不覆盖；永久删除绑定笔记本级联删除原始图谱。管理员转移含 AI 来源的账号目前明确拒绝，原数据保留。
- PostgreSQL 只有结构镜像，未运行真实 PostgreSQL 验收；大规模资源压力、签名产物、真实代理/断电/备份恢复及第二设备核对未完成。

**结论：已具备 Phase 0–3 工程 MVP 与本地自动化证据；当前不满足正式发布条件，也不建议按已完成正式验收直接合并。** 后续先处理完整回归基线、真实站点和设备验收，再推进 Phase 4–6。

[变更文件清单](ai-memory-hub-2026-11-05/files.txt) · [API](../api/ai-memory.md) · [教程](../tutorials/ai-memory.md) · [架构](../architecture/ai-memory-hub.md)
