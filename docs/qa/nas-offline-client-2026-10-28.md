# NAS 本地离线副本：开发与验收记录

日期：2026-10-28。对应 [开发方案](../superpowers/plans/2026-10-27-nas-offline-client.md)。

后续交互已按用户要求改为登录后自动下载、自动切到本地副本，断网编辑、重连自动回传。补测发现并修复的桌面附件下载队列问题，以及最新验证范围和门禁限制，见 [自动同步补充验收](nas-offline-automatic-sync-2026-10-28.md)。以下保留首轮记录，不代表后续自动流程需要用户手动迁移。

## 已实现

- 桌面完整版的旧远程模式完成下载后，持久化切换本地运行；下次启动不等待 NAS。数据库已完成、settings 尚未写入时，依据同一来源的本地迁移记录恢复。
- 完整版直接在登录页连接 NAS 的入口也能进入下载向导；真正的 Lite 安装包显示安装完整版的接续说明，禁止执行缺少资源的迁移。
- React Provider 挂载前恢复本地服务地址和凭据，避免冷启动时旧 NAS 凭据先请求本地服务而触发退出。切换时恢复本地服务地址和本地凭据，保留旧服务器/账号的浏览器离线数据；下载前阻止遗留离线队列未完成时直接迁移，并创建完整本地备份。
- 迁移按服务器及远端账号绑定，拒绝用另一账号接续原迁移；重复请求互斥。保留已有本机内容和冲突双方，为本地独有实体保留待同步意图。
- 首次同步在进程中断后重新读取完整快照；不以遗留的内存页游标跳过正文。迁移逐页应用、全分页核对身份，不确认尚未应用的窗口期变更。
- 初次 Push 需要完整对应确认；相同内容重试使用相同身份，改变内容后使用新身份。等待 ACK 期间的本地编辑继续留在 Outbox。
- Android 附件下载失败后保留下载方向；存在缺失文件时不误走上传。失败保留并退避重试，正文与附件分别展示状态。
- 桌面附件验证哈希和大小后临时落盘并发布；文件元数据与可用状态在同一数据库事务提交。移动端复用已有安全文件存储。
- 桌面和 Android 诊断增加个人空间离线状态；有界检查真实文件，缺失文件保留元数据并重新排队下载。未完成核验、未知目录能力或剩余失败项不能宣称全部离线可用。
- Android token 过期时打开原绑定账号库，暂停远端同步并提供重新登录；明确撤销/禁用继续沿原鉴权规则处理。账号改变后迟到的鉴权响应不更新当前会话。
- 同步设置提供中英文离线说明；“笔记已保存到本机”“附件下载中”“核验中”“完整离线可用”和远端同步确认分别表达。

## 自动验证

对工作区实现运行以下检查，结果不等于已发布版本或设备验收。

| 检查 | 结果与覆盖 |
| --- | --- |
| DCC 映射检查 | 12 条不变量，205 个用例引用；新增用例关联 DCC-001/002/003/005/006/007/009 |
| DCC 后端行为回归 | 32 个文件、479 个用例通过，包含真实 SQLite 与 Sync V2 HTTP 多端收敛、删除/冲突/账号隔离 |
| DCC 前端行为回归 | 33 个文件、270 个用例通过，包含浏览器队列、Native 附件存储、移动重试及登录过期/提前续期失败 |
| 同步设置/冷启动补充回归 | 4 个文件、27 个用例通过；包含完整版直连 NAS、真 Lite 接续和过期账号库恢复 |
| Electron 回归 | 4 个文件、23 个用例通过；设置派生、启动函数的依赖替身执行、数据库提交后恢复、本地账号 bootstrap；不等同于启动真实安装包 |
| 类型与构建 | 前端 `npm run build`（含 tsc、Vite 和 UI 校验）、后端 tsc 与 bundle 通过 |
| 改动范围 lint | 与现有基线比较，18 个前端 TS/TSX 文件无新增错误；17 条历史错误保持原状 |
| 全量 lint | 当前目录中的 `dist.bak/` 与 `ios/App/App/public/` PDF worker 生成物引用缺失的 ESLint 规则，不能作为通过；未修改这些无关文件或放宽规则 |

本机后端 `better-sqlite3` 使用 Electron 对应 ABI，因此后端回归使用项目现有 Electron 的 Node 运行模式；普通 Node 直接运行最初遇到 ABI 137/130 不匹配，没有为此改动产品依赖。

可复跑命令（仓库根目录）：

```bash
node scripts/data-consistency-contract.mjs --verify
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/data-consistency-contract.mjs --backend
node scripts/data-consistency-contract.mjs --frontend
node --test electron/__tests__/offlineRuntime.test.js electron/__tests__/settingsLocalRuntime.test.js electron/__tests__/rendererRuntimeRouting.test.js electron/__tests__/localAccountBootstrap.test.js
npm --prefix frontend run build
npm --prefix backend run build
```

Electron 可执行文件路径随操作系统不同而变化；后端独立测试继续使用现有隔离 setup/串行 runner。

## 容量探测

在隔离临时 SQLite 中，使用 200 条/页的远端替身下载 5,000 篇 Markdown 与三级笔记本，逐项落库后检查末篇正文及总数：通过。每篇正文 3,240 字节，处理约 4,393 ms；进程 RSS 从 118,620,160 字节增至 727,187,456 字节。

这是本机桌面后端自动化容量样本，RSS 前后值不等于完整峰值或泄漏证明，也不代表 NAS 带宽、安装包或 Android 表现。当前桌面 bootstrap 仍会在内存中收集正文基线，大正文库及大单附件需要继续验证内存预算；附件下载复用现有单文件 Buffer/Blob 路径，没有宣称任意大小都已验收。

## 隔离应用与容量验收

本机使用合成账号与临时数据库，生产路由、同步实现和编辑器实际运行。桌面固定回环地址并禁用发现，Android 仅测试独立包名 `com.nowen.note.offlineacceptance`；普通网络关闭，通过 `adb reverse` 连接本机 NAS 替身。不使用私人笔记或现有用户资料目录。

| 验收 | 结果 |
| --- | --- |
| macOS arm64 源码应用 | 通过真实登录/迁移界面下载 → 停止 NAS → 完全退出重启 → 打开此前未读正文 → 离线编辑 → 再次重启保留 → 重连 → 独立鉴权读取服务端正文 |
| macOS arm64 未签名测试包 | 同一闭环通过；采用生产资源打包，入口额外隔离用户目录和网络；不是可发布的签名安装包 |
| Android 36 模拟器完整版 APK | 通过独立 debug APK 登录、首次下载、NAS 停止后强杀重开、打开此前未读正文、离线编辑写入实际原生 SQLite/Outbox、再次强杀重开保留、重连后鉴权读取服务端修改 |
| 10 GiB 附件集合 | 77 个实际文件，最大 512 MiB，其余 76 个各 128 MiB；中途断流保留待下载状态且不发布不完整文件，重试后逐项大小/SHA-256 一致 |

10 GiB 样本在本机回环网络下载与核验约 24.7 秒；客户端峰值 RSS 1,677,136 KiB（约 1.60 GiB），服务端峰值 1,284,480 KiB（约 1.23 GiB）。结束时 RSS 下降不代表过程资源开销低。现有下载路径会持有单文件 Buffer，因此该结果不能外推到低内存手机或更大单文件，也不代表 NAS 网络吞吐。

可复跑（先完成构建及原生插件同步，测试包均使用隔离入口）：

```bash
node scripts/nas-offline-acceptance.mjs
node scripts/nas-offline-acceptance.mjs --packaged
node scripts/nas-offline-large-acceptance.mjs --large
# 仅用于端口 5580 的专用只读 Android 模拟器与独立测试 APK
node scripts/nas-offline-android-acceptance.mjs emulator-5580
```

原始报告及截图位于 `frontend/node_modules/.cache/nas-offline-results/`，不会进入版本库；`candidate.json` 记录源码、macOS 测试包及 APK 哈希。候选是基于 `4cbd3fefbf63253287d61ec5a8fc616f161a9313` 的工作区未提交实现（包版本字段仍为 1.5.3），不代表 HEAD 对应版本或正式 1.5.4 已通过这些检查。

## 发布前仍需完成

- Windows 完整版、macOS 正式签名安装包及 Android 实机：首次下载后断开 NAS，完全退出/强杀并重开，打开此前未浏览的笔记和附件。macOS 未签名隔离测试包正文闭环已完成，仍需真实附件 UI 验收。
- 真实 NAS 与反代：离线编辑、重连、第二设备重新读取对应正文/版本和附件；登录过期、切账号及撤销分别操作。
- 真实磁盘不足、下载中进程异常退出、更大单文件及手机内存预算验证。10 GiB 桌面附件集合与注入断流重试已完成；这些结果不覆盖资源耗尽或进程崩溃。
- 共享空间、独立文件管理、任务/脑图等模块、其他原生平台不纳入本次完整离线承诺。
- 已创建未签名 macOS 测试包及独立包名 Android debug APK，未创建正式签名发布包、未推送、未发布；README/官网支持范围按真实设备验收结果再更新。
