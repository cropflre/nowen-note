# Release Center：真实三平台调试与产物复核

2026-10-16。**三平台真实调试构建和本机下载校验闭环已通过；人工安装验收、Draft 和正式发布仍未完成。** 本记录取代前两轮记录中的“远端工作流尚未部署 / 真实构建未运行”状态，保留前两轮作为历史证据。

## 提交与部署范围

- 工具实现：`5ec624c2`；慢速下载修复与独立控制台 CI：`7e0c130c`。代码位于 [PR #858](https://github.com/cropflre/nowen-note/pull/858)，目标 `release/v1.5.2`，等待审阅合并。
- 默认分支只通过 [PR #859](https://github.com/cropflre/nowen-note/pull/859) 接入专用调试工作流，合并提交 `3f929ffd`；没有把 release 分支的其他应用改动合入 main。
- 独立调试候选分支：`codex/release-center-debug-v1.5.2`，源码和工作流 SHA 均为 `f1066e49386200780d85ee651775895b513f71ca`。候选提交仅在工具实现上将四份 package/lockfile 的版本及 Android versionName 对齐为 `1.5.2`；不修改 Android versionCode，不合并到正式开发分支，不推版本 Tag。
- 本轮真实服务为 [127.0.0.1:4319](http://127.0.0.1:4319)，独立数据库 `/tmp/nowen-release-center-remote-debug/center.sqlite`。凭据仅从现有本机 GitHub 登录读入服务进程环境，没有保存到浏览器、源码或证据文件。重启机器后临时目录可能被清理，长期使用应按 README 指定持久化目录。

## 真实运行结果

[GitHub Run 38851856910](https://github.com/cropflre/nowen-note/actions/runs/38851856910) 的 `plan`、`contracts`、Windows、macOS、Linux 五个 Job 均成功。只有专用手动调试事件，未签名 Full 包，所有 builder 均 `--publish never`；原发布、Store、iOS 工作流没有改动。

| 平台 | 本机下载校验文件 | archive 字节数 | 实际结果 |
| --- | --- | ---: | --- |
| Linux x64 | AppImage、deb、latest-linux.yml，共 3 个 | 273,618,156 | 通过 |
| macOS x64 / arm64 | 两架构 dmg、zip 及各自 blockmap、latest-mac.yml，共 9 个 | 575,700,663 | 通过 |
| Windows x64 | setup.exe、portable.exe、setup blockmap、latest.yml，共 4 个 | 275,008,250 | 通过 |

合计下载 **1,124,327,069 字节（约 1.05 GiB）**，校验 **16 个真实文件**。先验证 GitHub archive digest、Run/任务/源码来源，再安全解压、复算逐文件 SHA-256，并复用旧发布校验器检查 SHA-512、大小、blockmap 与更新元数据。下载/解压临时目录在完成后清理，没有永久保存安装包。

- 源调试任务：`119fdb1e-9a61-4146-8716-361ac5507559`。
- 成功校验任务：`3f8f6a0b-8073-4c5f-b25f-56cc925fce47`。
- 记录： [预检](../../../tools/release-center/docs/evidence/remote-debug-20261016/preflight.json)、[Run 与 artifact 摘要](../../../tools/release-center/docs/evidence/remote-debug-20261016/run.json)、[完整逐文件大小与 SHA](../../../tools/release-center/docs/evidence/remote-debug-20261016/verification.json)。

**本地验收记录仍为空，页面的确认框未勾选。** 这里只证明真实构建和内容完整性，不能代替安装、启动、签名、公证或正式发布审批。

## 真实恢复、取消与网络行为

- 构建中停止并重启服务，恢复到同一个 Run ID；重复提交相同幂等键仍返回原任务。最终审计只有一次 `dispatch.intent` 和一次 `dispatch.accepted`。
- 真实 SSE 包含该 Run；已完成 Job 日志可经服务端读取、脱敏并写入审计。`POST /api/publish` 返回 404。
- 首次只读预检遇到 `fetch failed`，计划被阻断，没有派发；重新预检成功后才建立调试任务。
- 主动取消第一次实际下载（任务 `26f0e3e7-6742-4feb-9169-19cc91b9d77f`），任务进入 cancelled、释放本地互斥，源 Run 保持成功。重试只读下载，没有再次构建。
- 初始下载速率约 0.5 MB/s，最大 archive 约 576 MB；据此将单包上限从 10 分钟放宽到 30 分钟、整次校验从 45 分钟放宽到 90 分钟，保留任务截止、取消与大小配额。没有声称实际触发过旧超时；新增停滞网络流的截止测试验证提前终止。

[恢复与幂等证据](../../../tools/release-center/docs/evidence/remote-debug-20261016/lifecycle.json)。Token 失效、API 限流、压缩包破坏和部分平台失败等故障仍由模拟边界回归覆盖；没有撤销真实凭据或人为破坏已生成的远端产物。

## 测试结果

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 本机工具单元/集成（包含新截止测试） | 59/59 | [本地测试](../../../tools/release-center/docs/evidence/remote-debug-20261016/local-unit-tests.txt) |
| 本机 Chromium | 4/4；超时改动前运行，页面代码未改变 | [浏览器](../../../tools/release-center/docs/evidence/remote-debug-20261016/local-browser-tests.txt) |
| 本机 TypeScript + Vite | 通过，超时改动后运行 | [类型与构建](../../../tools/release-center/docs/evidence/remote-debug-20261016/local-build.txt) |
| 本机旧发布 / Store 隔离 | 33/33、13/13 | [发布](../../../tools/release-center/docs/evidence/remote-debug-20261016/local-release-tests.txt)、[Store](../../../tools/release-center/docs/evidence/remote-debug-20261016/local-store-tests.txt) |
| Ubuntu / Node 24，独立安装工具依赖 | 59/59、Chromium 4/4、TypeScript 与构建通过 | [CI Run](https://github.com/cropflre/nowen-note/actions/runs/38854891606)、[日志摘录](../../../tools/release-center/docs/evidence/remote-debug-20261016/ubuntu-console-ci.txt) |
| 真实三平台打包与 updater 校验 | 全部通过 | 上述真实 Run 与 verification.json |

新增 `.github/workflows/release-center-ci.yml` 对工具及其发布校验接口变更自动运行 Node 24 测试、类型检查、构建和浏览器回归。PR 的各次提交状态见 [PR #858 checks](https://github.com/cropflre/nowen-note/pull/858/checks)；保存的 [PR 状态快照](../../../tools/release-center/docs/evidence/remote-debug-20261016/pull-requests.json) 标明采集时的代码 SHA，不将文档后续提交的状态混为该快照结果。

## 实际页面

以下均来自真实服务、真实 Run 与真实安装包，不是前轮测试 ZIP：

- [构建进行中](../../../tools/release-center/docs/screenshots/remote-debug-running.jpg)
- [三平台产物校验页面](../../../tools/release-center/docs/screenshots/remote-artifacts-verified-desktop.jpg)
- [完整校验卡片与未确认的验收区域](../../../tools/release-center/docs/screenshots/remote-artifacts-verified-details.jpg)
- [390px 暗色页面](../../../tools/release-center/docs/screenshots/remote-artifacts-verified-mobile-dark.jpg)，实测页面 `scrollWidth=390`、`innerWidth=390`，表格仅在自身区域横向滚动。

## 未运行与后续边界

未运行：Windows/macOS/Linux 安装与应用启动验收、签名/公证验证、全应用本地测试、Docker/iOS/NAS/Store 分发与设备验收。Linux 兼容性等额外覆盖以对应真实 CI 的已完成步骤为准，不能代替所有发行版或物理设备验收。

未实现：正式候选构建编排、Draft、正式身份审批、正式发布和 Phase 3 分发适配。没有创建 Draft/Release、推版本 Tag、上传 Docker、TestFlight 或提交商店。下一步先审阅合并工具 PR，再做真实安装验收；之后另行推进 Phase 2 的正式发布能力，正式发布操作仍需明确授权。

逐文件交付清单见 [file-list.txt](../../../tools/release-center/docs/evidence/file-list.txt)。
