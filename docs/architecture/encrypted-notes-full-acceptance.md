# Encrypted Notes：Full 内置后端与 macOS 应用包验收

2026-10-02，macOS arm64 / Electron 33：Full 源码 4 项与 Full `.app` 4 项验收通过。每种资源环境均覆盖整篇 Markdown / 基础富文本及 Markdown / 富文本局部区域。Lite 完整工作台 5 项、加密目录 97 项与 Electron 安全、账号启动和资源路由 9 项回归通过；生产前后端构建及前端类型检查通过。套件复用场景，不相加为独立功能数量。

## 实际打包缺陷

生产 Full builder 将 `electron/clipper-host.js` 作为 extraResource 放在 `Resources/clipper/clipper-host.js`；该文件不在实际 `app.asar/electron/` 中。主进程仍使用 `require("./clipper-host")`，导致打包版在创建工作台前无法启动。

主进程现在在 packaged 环境加载 `Resources/clipper/clipper-host.js`，源码环境保留原路径。应用包测试从真实 Full builder 生成产物，确认 `app.isPackaged === true`、主进程入口位于 `app.asar`、工作台加载包内 `Resources/frontend/dist/index.html`；随后由生产主进程启动包内后端 bundle 和原生 SQLite。没有使用源码后端替代包内资源。

## 覆盖与证据

- 生产 `startBackend` 分配端口、启动 `backend/dist/index.js`，真实本地账号 bootstrap 自动进入工作台；不注入远端账号或固定认证头。
- 整篇 MD/RT：知识树加密创建、Worker/WASM 解锁与加密保存、原生窗口隐藏自动锁定；通过产品按钮明确确认放弃未保存内存草稿后退出进程。在相同 profile 重启主进程和内置后端，重新输入口令只恢复已保存正文。
- 局部 MD/RT：完整工作台新建普通文档、工具栏新增加密区域、正文自动保存到内置后端；实际解锁编辑，产品确认框明确放弃未写回修改。退出和重启后重新解锁恢复此前已写回的区域，不自动恢复未保存内容。
- 重启前确认请求与 SQLite 全表不含专用正文/口令标记，确认旧后端健康端点关闭后再启动新进程；结束扫描请求、SQLite 全表、profile 文件、数据库/WAL、缓存、日志与后端输出，未发现标记。关闭进程，删除每项临时 profile。
- 原生关闭仍保留未保存修改警告。验收选择产品内的明确放弃入口；没有把直接关闭脏编辑器、崩溃或 OS 休眠恢复算作已验证。

## 隔离和复验

```sh
# 仓库根目录；SQLite 必须与本机 Electron ABI 一致
npm run rebuild:native
cd frontend
npm run test:encrypted-notes:full
```

命令构建生产前后端，通过现有 Full builder 的 ABI/架构与资源检查生成本机架构 `.app`，运行 `source-full` 和 `packaged-full` 两个项目。不签名、不公证、不发布，不需要开发预览服务器；需要图形桌面。不要同时操作其他 GUI 验收窗口，原生失焦会按设计触发锁定。

应用包保留生产 Full 资源布局、主进程、preload、IPC 与 CSP；仅 extraMetadata.main 指向验收引导脚本，再加载生产 `main-bootstrap.js`。该脚本要求受保护的 `nowen-encrypted-app-*` 临时目录，初始化 Full 设置，重启保留已有设置；读取包内 SQLite 模块，观察 session 请求，仅允许该私有后端的 HTTP origin。实际本地认证和存储守卫不替换。

后端仍由生产主进程以 Electron-as-Node 启动 bundle；测试 child 的 `--require` 夹具仅约束 loopback 监听及 cwd 到临时目录。关闭自动备份、mDNS 和日历定时导出，备份路径独立。剪藏的浏览器 Native Messaging 注册在夹具中跳过，避免写入用户浏览器配置；其包内模块加载及私有 runtime 发布仍执行。这不是剪藏注册验收。

产物位于 `frontend/node_modules/.cache/encrypted-notes-packaged/`，为带验收入口的未签名应用包，不作为发布安装包交付。夹具必须通过上述测试命令提供临时 profile 后启动，不能当作普通安装应用直接使用。

GitHub 加密 CI 检查夹具语法和验收 TypeScript；GUI 应用包验收当前在本机运行。

## 原生锁定稳定性记录

一轮 Lite 回归中，整篇 Markdown 的原生隐藏锁定断言曾失败（编辑器未在 5 秒内移除）。该用例随后独立连续运行 3 次通过，整套 Lite 5 项复验通过；Full 8 项也通过。未稳定复现触发原因，不能宣称已修复这一偶发锁定现象，继续保留为原生失焦/隐藏稳定性验收项。

失败后的未保存离开提示曾阻塞夹具退出，现改为在请求和数据库检查完成后强制销毁私有测试窗口并清理后端/profile。原断言失败仍会保留，不设置重试掩盖失败；正常产品重启路径仍使用明确放弃草稿及生产退出链路。

## 保持未完成

本次未覆盖原版无夹具安装包、DMG 安装、签名/公证、自动升级、Windows/Linux 包、外部服务器/TLS、真实双设备、完整备份 UI、OS 休眠、移动真机和性能参数冻结。新建密文的扫描不等于 M4 既有明文历史、索引、缓存、WAL/空闲页及旧备份清理；M0/M2/M3/M4/M5 里程碑继续保持原验收边界。
