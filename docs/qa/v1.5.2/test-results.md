# 真实执行结果

源码 SHA：`99dbdef9fa160ccce0f66aa0489dc964a28bc6cd`。以下均为本轮真实执行；通过数字是用例级，重复轮次单列。

| 验证 | 结果 | 证据及边界 |
| --- | --- | --- |
| 前端历史 9 文件，首轮独立进程 | 55 用例：42 PASS / 13 FAIL | `evidence/*-r1.json`；原断言完全保留 |
| 旧称偶发的 4 文件，另外两轮独立进程 | 每轮 27：24 PASS / 3 FAIL | `*-r2.json`、`*-r3.json`；代理、剪贴板、登录三项稳定失败，crypto 全绿 |
| 前端原 3 条 i18n 失败，按生产方式初始化 | 连同其文件及资源探针 8/8 | `production-i18n-render.json`；原组件断言未改，新增 setup 导入生产 i18n |
| 账号栏、标签焦点、地址输入、发布 i18n 覆盖 | 42/42 | `frontend-related.json`，四个现有测试文件 |
| 地址问题诊断 | 5：4 PASS / 1 FAIL | `address-proof.json`；复制原登录断言加观察输出仍失败，新增探针复现聚焦阻止已存地址显示 |
| 后端原 5 个非 PASS 文件 | 22/22 | 详见下表，源码测试环境 |
| 当前 HEAD automation-platform | 4/4 | `backend-rest/automation-platform.log` |
| 回收站、Markdown 导出、导出保护 | 18/18 | `backend-related/`，三个现有文件 |
| 后端生产构建 | PASS | `backend-build.log`；构建入口 index.hardened.ts，输出 dist/index.js 和两个插件子进程文件 |
| 隔离删除/约束/插件实验 | 缺陷行为已复现 | `boundary-audit.json/log`；观察脚本退出 0 不等于安全 PASS |
| 生产 bundle 真实登录/JWT/删除/下载 ZIP | 已执行并复现删除风险 | `http-bundle-proof.json`、`http-export.zip`、`http-bundle-server.log` |
| 前端全量 / 前端生产构建 | NOT_RUN | 本轮是失败复核，不能挪用旧报告作为当前执行记录 |
| 正式 Windows 安装包 / Docker | NOT_TESTED | bundle 与源码测试不能替代正式产物验证 |
| Android 真机 / 最终 APK | NOT_TESTED | 初始无设备，收尾 PJZ110 已连接；安装正式包显示 1.5.1，未证明/执行当前 SHA 候选包；矩阵见独立文件 |

原 9 文件三轮合计 109 次用例执行、90 PASS、19 FAIL，包含重复执行，**不是 109 个不同功能**。历史 3622 用例与本轮 55 个定向用例不得相加成覆盖率。后端本轮共 9 文件、44 用例，通过不能推出“产品缺陷为 0”。例如现有永久删除测试正好断言普通笔记被物理删除，PASS 并不意味着删除契约风险已解决。

## 后端 5 非 PASS 的三环境复核

| 文件 | 本轮源码/测试运行器结果 | 正常 bundle 证据 | 正式 Windows 安装包 | 历史归因是否得到确认 |
| --- | --- | --- | --- | --- |
| plugin-studio-projects | 5/5；真实符号链接、junction 被拒绝 | 未在 bundle 重跑该模块安全矩阵 | NOT_TESTED | 旧“symlinkSync 没有创建 symlink”未复现；本机 lstat 为 true。另有硬链接读取/导出缺口 |
| note-delete-attachments | 7/7；大批清空子用例约 98.5 秒 | 正常笔记直接 DELETE 的危险语义亦在真实 HTTP 复现 | NOT_TESTED | 单跑可通过；接近 120s 超时阈值，不能仅凭一次通过宣布负载根因已证明 |
| attachment-modern-media | 8/8；FFmpeg 当前存在且可运行 | bundle 明确 external；打包白名单保留 ffmpeg-static；尚未在 bundle 转码 | NOT_TESTED | 当前没有 ENOENT；旧机器二进制缺失不能证明正式包有/无缺陷 |
| attachments-router-bootstrap | 1/1；测试 cwd 正确为 backend，tsx 可解析 | 构建后的实际 hardened HTTP 服务启动、登录和 API 通过 | NOT_TESTED | 旧根目录 cwd/tsx 错误本轮未复现，不是 Windows 固有解析缺陷 |
| encrypted-notes-upgrade | 1/1；v1.5.0 实库 schema 122→123、备份恢复两版本往返 | 本轮未重复 bundle 迁移恢复矩阵 | NOT_TESTED | 系统 tar 成功；旧 GNU tar 的 C: 解释与本机 tar 不同，不代表所有 Windows 会失败 |

原始 TAP 中 `# pass/# fail` 为本轮数字，文件级与用例级分开统计。upgrade PASS 是已有的受控迁移/备份测试，不是用户生产库升级和大型真实备份恢复验收。
