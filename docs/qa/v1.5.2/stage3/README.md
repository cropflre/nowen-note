# v1.5.2 第三阶段：修复、候选产物与验收

> 后续已按用户授权合并到本地 `release/v1.5.2`；见 [集成记录](integration.md)。剩余同步改动复核发现，后端测试还导入了 Native 前端源码，不能仅按 backend tree 相同外推全量结果；更正与复测见 [第四阶段](../stage4/README.md)。正式 NO-GO 状态不变。

**NO-GO · 正式发版；允许内部验证。** 本阶段修复已实现并有回归证据，但新审计确认 Sync V2 的独立删除协议仍可永久删除活动笔记（BUG-11 / P1）。正式 Android GUI、广域网、附件跨端与安装升级门禁也未全部完成。自动化全绿不是发版许可。

日期：2026-10-12。独立分支 `codex/release-152-hardening`，发布分支复查到 `65eda826fefe3e481cbbf19ed261a77f0123c6b6`。最终被测代码提交 **`98d1ddf51791c2eb76262cc6bf7841bc184c0696`**。后续报告提交不改变被测运行时代码。此前 `99dbdef9` 的复核档案保留；本阶段已 rebase 到最新发布分支，其新增提交仅修改维护规范。未推送、合并或发布；用户原工作区修改未纳入候选。

## 已交付修复

- HTTP 两个永久删除入口共用服务检查：只有回收站、授权且未锁定的笔记可删除；活动笔记返回 `409 NOTE_NOT_TRASHED`，检查发生在附件清理前。
- SDK、MCP、CLI、前端迁移到显式永久接口；旧 SDK 方法保留 deprecated alias。拒绝时不隐式软删，Android 导入失败清理显式先软删。
- Android Native 删除在本地事务内再次读取状态；活动/锁定笔记被拒绝，正文、来源标记与 Outbox 保留。
- 前端只在永久删除成功 ACK 后清理该笔记的冲突队列；409、503、网络失败或缺少成功标记保留草稿。
- Studio 硬链接拒绝，读取/ZIP 导出使用已核验文件句柄；覆盖符号链接、Windows junction、叶文件/父目录的检查至打开替换。目录写入竞态及部署 ACL 的限制见兼容性文档。
- 修复登录地址自动聚焦后无法恢复显示、创建笔记约束错误码；修正过时测试契约和缺失生产 i18n 初始化。没有重复添加原本已存在的翻译。
- 修复首次 ACL 建表随拒绝事务回滚、内存却缓存“已初始化”的问题；更新 OpenAPI 导出作业与删除契约。

## 实际结果与证据边界

| 检查 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 前端最终全量 | **657 文件 / 3,630 PASS / 0 FAIL / 0 SKIP** | `evidence/frontend-full-release.json`；Node 24.19.0，按 assertionResults 统计 |
| 后端全量 | **343 文件 PASS / 0 文件 FAIL / 0 TIMEOUT** | `evidence/backend-full-final.log`；Electron Node 20.18.0 / ABI 130；这是文件级口径，未宣称全部内部子例无 skip |
| 后端证据适用性 | **已更正：不能外推到最终 Native 代码** | 全量执行于 `d7e0f9f6`；backend tree/bundle 相同，但测试导入的 `nativeLocalRepository.ts` 后续改变。干净 `f07fbe13` 上 4 个旧删除步骤真实失败；保留全量原始日志，最终代码的限定复测见第四阶段 |
| DCC 映射校验 | 历史 12 契约 / 116 引用通过 | `evidence/dcc-verify-final.log`；映射校验本身不是行为证明，不能替代最终 Native 源码变更后的行为复测 |
| 历史 crypto 复跑 | 最终 5 轮，55 PASS | `evidence/crypto-final-r*.json`；另有完整全量；旧缺失日志的特定失败原因仍无法反向确定 |
| SDK / MCP / CLI | 构建通过；SDK 6、MCP 11 通过 | 保留第一次 MCP 启动目录错误及修正日志；未宣称用户配置下的 CLI 安装验收 |
| 硬化服务 HTTP | 通过 | JWT 伪造/跨用户/锁定拒绝；活动删除保护正文、历史、树、文件、Outbox；拒绝和永久删除均重启回读 |
| 导出、备份闭环 | 通过 | Markdown job→ready→下载解析；Nowen ZIP→独立空 DB 导入→重启正文读回→附件 SHA256；`http-accepted/`、最终 `windows-release-http/` |
| 浏览器实际编辑 | 通过 | Edge 156：真实登录、两种文档创建和键盘编辑、API 正文落盘、刷新编辑器重读；390px 视口；`browser-release/`。没有代验 Android 键盘或 AI 调用 |
| Android 真机 | **Native/API Bridge 范围通过** | PJZ110 / Android 15，独立 QA debug APK；活动永久删除拒绝且保留队列、离线两种正文、force-stop、30 轮双向编辑、丢通知补偿、树移动冲突与文件夹恢复；`device-release-r2/` |
| Windows 候选产物 | 通过限定验收 | 实际 builder 拷贝文件，包内 Electron 执行硬化 HTTP/备份；FFmpeg HEVC→H.264/AAC、Sharp JPEG；`windows-release-*`。unsigned unpacked，未验 NSIS/签名/升级 |
| Docker Linux 产物 | 构建及运行 smoke 通过 | 真实 Dockerfile 镜像：SQLite vec、两种插件 runner 构建 smoke、生产 API、实际 Studio read/export 链接拒绝、FFmpeg、容器重启回读；`docker-*-release*`。不代表长时间稳定运行、升级或回滚 |
| Sync V2 独立删除 | **安全门禁失败 / P1 OPEN** | `evidence/sync-delete-audit-with-restore.json`：活动笔记，owner JWT，delete mutation applied，GET 404。观察脚本成功执行不是安全测试 PASS |

Android 包名 `com.nowen.note.qa152`，versionName `1.5.2-qa.98d1ddf5`，debug 签名；Windows 同名 QA 版本。仓库正式 package 仍为 1.5.1，不能将测试包元数据当成已完成正式升版。APK/EXE/bundle 哈希、Docker image ID、源码 tree 等见 [候选与结果 manifest](results.json)。大包保留在隔离工作区 `frontend/android/app/build/outputs/apk/debug/`、`.qa152-windows-release/`，不提交二进制发行包。

## 原始失败与数量口径

初次阶段三全量（Node 20）实际为 3,605 PASS、1 FAIL、16 SKIP；JSON 顶层字段把 skip 算进通过，不能直接引用顶层 pass。16 个 skip 在 Node 24 被执行，另有 2 个条件注册的真实 SQLite 迁移用例；新增队列 5 例和 Native 删除 1 例，最终共 3,630 个实际通过。Node 24 的 3 个 Blob 失败是 jsdom 24 Blob 缺少 arrayBuffer；改用 FileReader 读取真实 blob 字节，保留逐字节断言，未放宽产品二进制要求。

所有首次失败保留：接口迁移后的队列回归、ACL 回滚、Native 活动删除、脚本参数/路径、浏览器未安装默认 runtime、测试运行时兼容和包文件占用。Android 首次最终复跑因复用旧 Native 身份连接新空服务库产生 2 个冲突；再次使用新测试账号隔离，保留旧数据库/Outbox，完整运行通过。没有通过清队列或清真实数据获得 PASS。

Docker 首次 Windows `core.autocrlf=true` 的 git archive 将脚本变为 CRLF，镜像入口无法执行。Git blob 为 LF，改为 `git -c core.autocrlf=false archive` 后按 Linux 发布检出构建/启动。另有 FFmpeg 测试参数 `.2` 修成 `0.2`。后续 WSL 容器曾退出 255，未取得持续运行失败的根因；本报告只接受有证据的启动/重启 smoke，不接受 soak。均未删除失败证据。

历史 14 FAIL 的原始日志始终未提供，不能宣称已重建当时全部失败原因。旧文本的 14/15 分类矛盾见第二阶段报告；现在可独立核对的是本阶段完整 JSON、TAP、产物与设备记录。

归档复核发现第一批提交在启用原字节属性前被 Windows Git 转换过文本行尾。已重新从用户五份附件复制原始字节；原始历史 manifest 单独保存在 `../evidence/phase2-manifest-original.json`，当前 manifest 标明旧 hashes 并重新核算。已有真实测试日志字节未改变；整个 QA 目录禁用 Git 行尾转换，避免跨平台 checkout 再次破坏 hashes。

## 仍需关闭的发版门禁

1. **BUG-11：统一 Sync V2 永久删除协议和权限**。先完成 [兼容修复设计](sync-delete-contract.md)，覆盖旧客户端、合并 Outbox、附件/历史清理及离线正文恢复。HTTP/Native 防护不能替代该入口。
2. **Studio 写入边界**：确认实际部署根目录及父目录只有受信任服务账号可写；读/export 已验证不等于整个 OS 沙箱。恶意本地写入者的 create/rename 父目录竞态尚未完整消除。
3. **Android 完整产品矩阵**：真机 EditorPane、ConflictCenter 双方正文、迟到/丢 ACK、附件字节、跨身份、广域网/移动网络与升级，参见 [设备矩阵状态](android-status.md)。本轮 diagnostic entry 不能填充这些 GUI 门禁。
4. **正式客户端/部署**：签名安装/升级、Docker 升级回滚、AI 真实服务调用与写回；本轮没有这些执行证据。

原始日志与 fixture ZIP 是合成测试数据。证据 hashes 见 [evidence-manifest.json](evidence-manifest.json)，复跑工具在 [scripts/](scripts/)。
