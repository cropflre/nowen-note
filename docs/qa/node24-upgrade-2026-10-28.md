# Node 24 升级本地验收（2026-10-28）

分支：`release/v1.5.4`，本记录为本地验收，不代表远端 CI 或正式发布。测试使用隔离临时库、临时桌面 Profile 和独立容器，没有访问用户已有数据库。桌面 QA 包沿用当前源码的应用版本号，不是新的正式 Release。

验证期间出现并行的 React 19 提交 `4f1e6504`，已保留。其后重新运行了前后端构建、ARM64 打包与桌面离线同步完整流程，均通过；较早的 Docker / Intel 包运行时验证不代表这些包已包含后续 React 变更。

数据边界按 DCC 契约核对：备份恢复完整性覆盖 DCC-008 的校验与失败回滚路径；桌面离线验收确认本地重启保留和独立服务重读，不推断 Android / iOS 或其他真实设备已同步完整。没有修改数据结构、业务写入和 Outbox 协议。

## 已通过

- 配置核查：114 个工作流均可解析，其中 176 个 setup-node 步骤固定为 24.22.1；项目各包的 engines 与锁文件一致。
- Node 24.22.1 下前后端完整构建。
- MCP 启动诊断 6 项测试：拒绝不满足安全基线的版本，保留错误诊断和任意工作目录启动行为。
- 发布与更新回归 86 项测试；原生模块、Linux ABI 策略、桌面资源和 sharp 定向回归 24 项通过。
- 桌面 Node 下载器：旧版本缓存替换、同版本复用、校验失败时保留现有二进制，测试不访问网络。
- Electron 43.8.4 / macOS ARM64：原生模块源码重建，SQLite / sqlite-vec 加载与 KNN 检查。
- macOS Intel：在 Apple Silicon 上通过 Xcode 按 x64 目标源码重建，并生成真实 x64 未签名应用；通过 Rosetta 使用其内置 Electron Node 加载打包后的 SQLite 和向量扩展，KNN 检查通过。目标架构的向量扩展也纳入安装前准备和打包前后校验，防止复制宿主架构时漏包。
- 后端隔离回归：SQLite adapter、搜索索引、备份恢复完整性、sync-v2 engine、outbox capture，分别在普通 Node 24 和匹配的 Electron Node 运行时通过。结束时已将本机原生依赖恢复为默认桌面开发使用的 ARM64 Electron ABI。
- macOS ARM64 未签名真实打包、ZIP 生成、Info.plist 最低 macOS 12，以及生成的 `latest-mac.yml` 顶层 `minimumSystemVersion: 21.0.0`。更新器行为测试确认拒绝 Darwin 20、接受 Darwin 21，保留原有发布说明和文件校验信息。
- 打包桌面端真实流程：登录隔离 NAS、自动下载本地工作区、NAS 停止后完整重启并阅读此前未读笔记与图片、离线编辑跨进程重启保留、重连后独立鉴权读取确认编辑已同步、退出登录跨重启保留。
- Docker ARM64 / amd64：完整生产镜像构建，确认 Node 24.22.1；生产依赖中的向量扩展、node-action 与 sandbox-js 运行器冒烟通过。ARM64 同时确认 OpenSSL 3.5.9。
- Docker ARM64 / amd64 隔离容器：健康接口、注册、笔记写入后重读和未鉴权读取返回 401。
- Linux x64 / ARM64 原生模块：在独立容器中使用 Electron 43 头文件和 GCC 12 源码编译，静态链接 C++ 运行库；两种产物 glibc 要求均为 2.29，无动态 GLIBCXX / CXXABI 版本要求，通过原有兼容检查。此项不等于最终桌面安装包验收。

## 发布前仍需完成

- Windows x64、macOS Intel、Linux x64 最终安装包启动与旧版本覆盖安装。
- Android / iOS 的正式签名构建、设备验证，以及 Android Docker 构建镜像验证。
- macOS 正式签名、公证、自动更新渠道验证。
- 对应提交的远端 CI 与正式发布；真实 NAS / 生产数据的升级验收。

Docker 构建初期多次遇到镜像仓库 EOF、Alpine 包索引 TLS 和下载连接重置；ARM64 生产镜像在重试后构建成功。网络失败不计为产品回归通过，也没有以放宽证书或校验和检查绕过。
