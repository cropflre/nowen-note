# 更新日志 / Changelog

本文档由 `scripts/generate-changelog.mjs` 从 git commit（Conventional Commits）自动生成，并在每次
`scripts/release.sh` 发版时追加新版本。手写修订同样欢迎——发布脚本只会在文件顶部的占位标记下方
追加新版本条目，已有内容不会被改写。

格式说明：

- 每个版本一个二级标题：`## vX.Y.Z - YYYY-MM-DD`
- 条目按类型分组：新增 / 修复 / 优化 / 文档 / 重构 / 其他
- Commit 以 Conventional Commits 为规范（feat / fix / perf / refactor / docs / chore / style / test / build / ci）

<!-- ADD_NEW_HERE -->

## v1.1.10 - 2026-05-29

### ✨ 新增

- **prefs**: 新增阅读密度偏好（宽松/紧凑） (3d94607)
- **mobile**: 搜索按钮上提到笔记标题栏 (e0f047c)
- **editor**: 表格新增行高可拖拽功能 (c5c2461)
- 新增客户端下载面板 + Gitee Release 镜像同步 (93a6117)

### 🐛 修复

- **download**: 修复 DownloadPanel icon 类型 TS2322 编译错误 (ced169b)
- **editor**: 收紧图片上下间距 (29ccead)
- **upk**: use host network for ugreen package (68065b9)

### 🔧 其他

- **upk**: update zh-CN display name (bcd55ee)


## v1.1.9 - 2026-05-28

### 🐛 修复

- **desktop**: prevent local mode reload loop (490f5a3)


## v1.1.8 - 2026-05-28

### 🐛 修复

- 调整访问控制默认开关 (b49534c)


## v1.1.7 - 2026-05-28

### ✨ 新增

- 优化桌面端云端本地模式与访问控制 (783cf6a)
- **release**: 选项 10 改为'补 upk 到现有 Release'模式（不打新 tag、不升版本） (7e4c626)

### 🐛 修复

- 修复桌面端切回本地离线模式时，本地后端被误判为远端导致黑屏/反复闪屏的问题。
- 修复后端实时删除广播编译错误 (22fcc3c)
- improve multi-device note sync (0beb31e)
- **upk**: 补回被上一个 commit 误删的 const found 行 (0e81338)
- **upk**: cp/rm 之前按 resolve(src) 去重，避免重复处理同一文件 (9e95e54)
- **upk**: 递归扫描 .upk 产物，覆盖 ugcli 实际输出路径 build_dir/pkgs/upk/ (49467ff)
- **upk**: 补 upk 模式支持版本复用 + 修 RepoTag 与 compose 不一致 + ugcli 权限自愈 (00de4d9)

### 📝 文档

- **readme**: 添加在线体验入口（note.nowen.cn） (b626b3e)

### 🔧 其他

- 完善发布流程与编辑器设置 (0ae451d)
- update release workflow and editor UI (53c2e4d)

> 🚨 **紧急安全修复**：1.1.6 用户请尽快升级。该版本修复"登录云端账号"迁移功能在
> 同一台后端上误操作导致的**附件物理文件丢失**问题。

### 🐛 修复

- **【数据保护】回收站清空 / 永久删除笔记不再误删被多笔记共享的附件物理文件**
  - 受影响场景：1.1.6 在同一台服务器上点击"登录云端账号"产生双份笔记本后，
    手动删除其中一份并清空回收站，会触发被另一份笔记引用的图片被 unlink。
  - 修复后：批量删除附件文件前会做引用计数检查，仍有活引用的物理文件不会被删，
    与单条 `DELETE /api/attachments/:id` 的行为对齐。
- **【迁移防呆】"登录云端账号"对话框现在会拒绝迁移到同一台服务器**
  - 后端 `/api/version` 返回新增 `serverInstanceId` 字段（首次启动 lazy 写入
    `system_settings`，跨重启稳定）。
  - 前端 MigrationModal 在登录拿到云端 token 后立即比对两端 `serverInstanceId`，
    相同则直接拦截、提示"无需迁移，请退出登录后用新账号登录即可"。
  - 同账号场景（不同实例但本地与云端用户名一致）会弹二次确认，避免误操作。
- **【迁移一致性】附件 hash 去重命中时不再复用旧附件 id**
  - 编辑器上传、内联 base64 抽取、公众号/URL 导入图片在 hash 命中时，会新建一条
    绑定当前笔记的 `attachments` 元数据行，同时复用同一份磁盘物理文件。
  - 迁移引擎层新增 `serverInstanceId` 预检查；即使绕过弹窗直接调用迁移函数，
    也会在写入云端前阻断"本地端 == 云端"的同源迁移。
- **【附件健康检查】新增只读健康报告，帮助定位裂图 / 404**
  - 管理员可在「设置 → 数据管理 → 系统 → 数据库」执行附件健康检查。
  - 报告会列出 `attachments` 行存在但物理文件缺失、正文引用不存在附件 ID、
    以及多行共享同一物理文件的情况。
  - 孤儿清理逻辑同步补强：多条附件行共享同一个 `path` 时，只有最后一个引用消失
    才会删除物理文件，避免清理工具自身误删活文件。
- **【附件修复向导】健康检查结果现在可直接执行基础修复**
  - 对“DB 行存在但物理文件缺失”的附件，管理员可上传替代文件写回原 `path`；
    若多条附件记录共享同一物理文件，会一起恢复。
  - 对“正文引用不存在附件 ID”的悬空引用，管理员可批量从笔记正文中移除坏 URL，
    避免前端继续请求 404。
  - 修复类操作均要求管理员 sudo 二次验证；修复后会自动重新生成健康报告。
- **【多端同步】修复同账号 PC/Web 与手机端当前笔记不同步的问题**
  - 实时更新不再按 `userId` 过滤同账号其它设备，只按 `connectionId` 排除当前连接回声。
  - PC/Web 保存后会向同账号其它连接广播轻量列表更新，手机端停留在列表或当前笔记时都能立即看到变更。
  - 当前笔记无本地未保存修改时会自动拉取并应用远端新版本；本地也有修改时进入冲突横幅。
  - 正文保存遇到 `409 VERSION_CONFLICT` 不再盲目重放旧内容覆盖远端，而是保留本地草稿，提示用户选择“重新加载”或“覆盖远端”。
  - 移动端前台恢复、联网恢复、WebSocket 重连时会主动补查当前笔记版本，补偿后台期间漏掉的实时消息。

### ⚠️ 影响范围与建议

- 仅 1.1.6 用户受影响。1.1.5 及更早版本没有"登录云端账号"功能，无此风险。
- **如果你已经丢失图片**：先检查 NAS 快照 / 备份；该场景下数据库行可能仍在，
  但物理文件已被 unlink，应用层无法凭空恢复原图。升级后可先运行"附件健康检查"，
  再对缺失项上传从备份或其它来源找回的替代文件；找不回的悬空引用可在修复向导中移除。



## v1.1.6 - 2026-05-26

### ✨ 新增

- **release**: 将绿联 .upk 从一键全量(选项5)中移除，独立到选项10 (78bbdf6)
- **notes**: 支持客户端生成的 UUID 作为笔记 ID（离线创建） (c8d8961)
- **login**: 登录页支持桌面端跳过登录直接用本地 (21c9183)
- **migration**: 本地→云端账号一键迁移（D-2/D-3 + 回滚） (f61a6a9)
- **local-mode**: 本地模式离线读 + 同步引擎 + localStore (660489a)
- **desktop**: Electron 桌面端框架 + 内嵌后端启动 (762e6b0)
- **attachment-preview**: 视频/音频按扩展名兜底 + 抽屉打开时隐藏链接气泡 (33d6c61)
- **editor-mobile**: 移动端顶栏改 iOS 风双行结构 + 桌面面包屑末段截断修复 (235db1f)
- **frontend**: add video embed extension and rich-text video URL support (b8e3493)
- **editor**: auto-convert '- [ ] ' / '- [x] ' to task list (5c9a916)
- **login**: add demo mode banner with one-click credential fill (0a0c271)
- **auth**: 新增体验账号(isDemo) 机制 (8e0ab8a)
- **url-import**: 公众号文章一键导入笔记 (d6c7c17)

### 🐛 修复

- **release**: multi 模式 upk 打包前 buildx --load 各架构镜像 (7cceed0)
- **editor**: TiptapEditor 桌面端样式/行为微调 (7b72d7d)
- **mac-build**: 单架构构建 + .node 魔数 arch 校验，修复 Intel Mac ERR_DLOPEN_FAILED (54a9c90)
- **release**: defer UPK_IMAGE_REF assembly until VERSION is finalized (80390c9)
- **upk**: 改进多架构镜像查找逻辑，支持 DOCKERHUB_REPO 环境变量 (cc57a7f)
- **VideoExtension**: 修正 NodeView props 类型为 ReactNodeViewProps，修复 tsc 报错 (1083377)
- 绿联nas 构建包 (eb15be2)
- **clipper**: split footer build for markdown branch to preserve source link (45402e8)
- **update-notifier**: move useCallback before early return to fix hook order (63f2624)

### 📝 文档

- **readme**: 补 macOS 首次打开 ERR_DLOPEN_FAILED 的 xattr 解隔离指引 (bf108cd)
- **readme**: sync features and changelog with Unreleased (e301e93)

### 📦 构建

- **upk**: 新增绿联 NAS 应用包(.upk) 打包流程 (967d00d)

### 🔧 其他

- **clipper**: release v0.1.3 (5d70c08)


## v1.1.5 - 2026-05-21

### ✨ 新增

- **attachments**: 附件预览抽屉 + 本笔记附件目录面板 (df2e06f)
- **editor**: 搜索替换面板 / docx 自研解析与导入 / 字号弹层优化等 (3a37905)
- **about**: 新增'作者感言'板块及阅读弹窗 (82e872d)

### 📝 文档

- **readme**: add Author's Note link in header (6e5d863)


## v1.1.4 - 2026-05-20

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_


## v1.1.3 - 2026-05-20

### ✨ 新增

- **trash**: 笔记本删除改为软删，回收站恢复自动还原祖先笔记本链 (aeba393)


## v1.1.2 - 2026-05-19

### ✨ 新增

- **editor**: 弱网防丢字 + 字号颜色 + Mermaid 放大预览 + 列表切换优化 (0ce7da6)

### 🐛 修复

- **import**: /export/import 返回 version=1，避免有道云附件回填触发 VERSION_REQUIRED (331bea7)
- bug (a701dd2)
- **release**: 体检加 lockfile 时间戳兜底，新增依赖自动 npm install (9cd7847)
- **release**: 白名单补 @tiptap/extension-text-style 防 TS2307 (a17aacb)
- 放大图片 (935a5e4)


## v1.1.1 - 2026-05-18

### ✨ 新增

- **mobile**: 移动端编辑器体验大改造 + 修复输入回退/Failed to fetch/点笔记没反应 (10b3e59)
- **backup**: P0~P1 backup/export/import improvements (0764826)

### 🐛 修复

- **ai**: scope knowledge-base notebook by workspace on import (9fd5138)


## v1.1.0 - 2026-05-15

### ✨ 新增

- enhance FileManager, SharedNoteView, clipboard & image host formats (ae28579)

### 🐛 修复

- **backend**: Buffer→Uint8Array<ArrayBuffer> 拷贝包装，彻底兼容 TS 5.7 类型 (ac1cd51)
- **backend**: 改用 Hono c.body() 替代 new Response()，彻底绕开 BodyInit 类型摩擦 (25ace00)
- **backend**: TS 5.7+ 下用 Blob 包装 Response body 修 BodyInit 不兼容 (51ca0c2)
- **backend**: 修复 attachments 缩略图 Response 在新版 TS 下的 BodyInit 类型错 (d5daecb)
- **mobile**: 优化移动端导航与任务中心布局 (592b18e)
- **share**: 路由正则支持 base64url 字符集；评论/分享/文件管理等多项改动 (6760199)
- **share**: 分享页图片在 IP+自定义端口部署上 https 误判导致全部 ERR (6139c1a)
- **release**: 发布时同步 bump backend/package.json 的 version (d73b747)

### 📝 文档

- 更新 README 用桌面端/移动端/AI 设置展示截图 (9865c92)


## Unreleased

### ✨ 新增

- **share**: 笔记分享支持未登录访客评论 + 新增「可编辑（需登录）」权限档
  - 权限选项扩到 4 档：`仅查看 / 可评论 / 可编辑 / 可编辑（需登录）`
    - `可评论`：未登录访客填昵称即可留言；评论对所有访客可见（留言板模式）
    - `可编辑`：原匿名编辑能力（沿用，访客填昵称即可）
    - `可编辑（需登录）`（新档 `edit_auth`）：必须登录账号才能写入；未登录用户点击「开始编辑」会被引导跳到 `/login?redirect=/share/<token>`，登录成功后自动回到分享页
  - 评论数据修正：v12 之前匿名评论的 `userId` 被强行写成笔记主 id（绕过 `NOT NULL` 约束），现 schema 迁移 `v13` 把 `share_comments.userId` 改 nullable + 新增 `guestName / guestIpHash` 列，访客昵称真正持久化、审计字段不再失真
  - 反垃圾基础措施：评论长度 ≤1000、同 IP 每分钟 ≤30 条、honeypot 字段
  - 用户注销改为 `ON DELETE SET NULL`：留言历史不再随账号销毁而蒸发，前端用 `displayName` 兜底展示
  - 安全：登录回跳的 `?redirect=` 仅接受相对路径，杜绝开放重定向



### ✨ 新增

- **files**: 文件管理新增「我的上传」分类
  - 顶层多了一个 `我的上传` tab，仅展示用户从文件管理页直接上传的文件（编辑器粘贴、Tiptap 内联抽取的不计入）
  - 二级子筛选三选一：`全部 / 已引用 / 未引用`，分别对应「上传过的全部 / 已经被某条笔记真正用上 / 还放在这里没插任何笔记」
  - 后端 `GET /api/files` 新增 `filter=myUploads` + `myUploadsRef=referenced|unreferenced`，复用 `attachment_references` 倒排表（`EXISTS / NOT EXISTS` 子查询），避免全表扫 `notes.content`
  - `GET /api/files/stats` 响应增 `myUploads: { total, referenced, unreferenced }` 用于 tab 徽标
  - 与 `孤儿(unreferenced)` 视图的区别：前者在用户**自己上传**的子集内细分；后者是全集合的"没人引用"（含编辑器粘贴又删除的，且有 24h 宽限期）

### 🐛 修复

- **files**: 「我的上传」分支字面量大小写错配，导致筛选完全失效
  - 现象：`?filter=myUploads` 走到后端后被 `.toLowerCase()` 转成 `myuploads`，再与字面量 `"myUploads"`（驼峰）比较 → 永远 false，整个 myUploads 分支变成 dead code，列表退化为返回 scope 全集，「我的上传」展示了 1300+ 张所有附件
  - 修复：把字面量也改成全小写 `"myuploads"`；同时给该分支加注释说明 filter 已 lowercased，避免再次踩坑
  - 教训：query 参数解析阶段统一 lowercased 后，下游所有 case 都必须用小写字面量；驼峰命名的 filter 名（如 `myUploads`）是高危区
  - 配套调试工具：
    - 后端 `GET /api/files` 增加可选调试日志——开启后每次列表请求会打印 `raw`（原始 query）/ `parsed`（解析后小写值）/ `whereSql` / `paramCount`，下次再遇到"前端传了 filter 但后端像没收到"的现象可一眼比对。生产默认关闭，零开销
    - 双源开关：环境变量 `DEBUG_FILES_QUERY=1`（运维侧旁路，需重启）；或 `system_settings.debug_files_query='true'`（运行时持久化，写库后 30s 内全节点生效）
    - 可视化入口：「设置 → 开发者」面板（仅管理员可见）新增 toggle，无需登服务器即可一键开关
    - 后端字段级闸门：`/api/settings` PUT 中 `debug_files_query` 仅 admin 可写，普通用户即使构造请求也会被 403
- **files**: 「我的上传」展示历史脏数据（含浏览器图标 / 误粘贴 / 测试上传等几十张非用户主动上传的图）
  - 根因：旧口径靠 `attachments.noteId == holderNoteId`（"未归档文件"占位笔记），但任何走过 `POST /api/files/upload` 的内容（含 FileManager 页全局 paste 监听器抓到的浏览器图）都会落进同一个 holder，导致"我的上传" tab 把历史粘贴 / 测试数据全部算上
  - 修复：DB 迁移 v12 给 `attachments` 加 `uploadSource TEXT`，仅 `POST /api/files/upload` 写入时标 `'file_manager'`；编辑器粘贴 / 内联抽取等其它路径保持 NULL；老附件**不回填**——历史脏数据自动从「我的上传」中清出
  - dedup 边界：当用户从文件管理主动上传一份内容已存在的文件时，会把命中的老行 `uploadSource` 升级为 `'file_manager'`（这是用户的主动行为，应当被识别）
  - 兼容：老附件仍在「全部 / 图片 / 文件 / 孤儿」等其它 tab 里可见，没有任何数据丢失；holder note（"未归档文件"）保留作为外键容器，不再用作筛选依据

### ⚡ 性能

- **files**: 文件管理图片密集场景全链路优化（图床卡顿专项）
  - 后端新增 `sharp` webp 缩略图服务（`backend/src/services/thumbnails.ts`），按需生成 240/480/960 三档宽度并落盘缓存到 `ATTACHMENTS_DIR/.thumbs/`，与原图共享 `Cache-Control: immutable, 1y`
  - `/api/attachments/:id` 新增 `?w=` 查询参数；`toFileOut` 给 raster 图片下发 `thumbnailUrl`
  - 前端 `GridCard` 用 `React.memo` + 父级派生 `isCopied`/`isDownloading`/`selected` 三个 boolean prop，消除 60+ 张卡的整体重渲
  - `<img>` 优先用 `thumbnailUrl`，加 `decoding="async"` + `fetchpriority="low"`；破图自动回退原图
  - `loadList` 加 30s TTL 模块级缓存，删除/上传/重命名/孤儿清理后清缓存
  - `downloadItem` 用 ref 同步 `downloadingId`，砍掉 useCallback 依赖，避免下载状态变化打穿 memo
  - 附件删除/孤儿清理时连带清缩略图缓存；孤儿扫描跳过 `.thumbs/` 隐藏目录
  - 预期：单页流量 ~200MB → ~2-4MB（100×），交互重渲 60 → 1-2（30×）

## v1.0.38 - 2026-05-14

### ✨ 新增

- **editor**: 顶栏新增 Mermaid / 数学公式 / 脚注 按钮，并让 Mermaid 块可双击编辑 (8970e9c)
- **editor**: Mermaid 图表 / LaTeX 数学公式 / 脚注 三项块级扩展 (530240c)
- **editor**: 链接气泡菜单 + 选区气泡补链接按钮 (ad8d8c8)
- **editor**: markdown 语法与斜杠命令增强 (862047f)

### 🐛 修复

- **release**: frontend 依赖体检白名单补 mermaid/katex/rehype-raw (cbafdc0)
- **backend**: reclaim disk space on note/notebook deletion (3d8e61b)

### ♻️ 重构

- **ai**: 用项目统一 confirmDialog 替代 window.confirm (5088414)

### 💄 样式

- **editor,share**: 编辑器链接醒目化 + 分享页排版自给自足 (e8d6e06)

### 📦 构建

- **clipper**: 0.1.2 多浏览器构建产物（chrome/edge/firefox） (1902bf7)

### 🔧 其他

- **clipper**: release v0.1.2 (01ebf0c)


## v1.0.37 - 2026-05-12

### ✨ 新增

- AI 批量归类加确认面板；剪藏来源用完整 URL；版本提示按版本号去重 (d6b30bd)

### 🐛 修复

- **android**: 修复键盘弹起后输入框下方一大片白色空白 (35cfb74)


## v1.0.36 - 2026-05-12

### ✨ 新增

- **clipper**: AI optimize clipped content via nowen-note backend (fbc1249)
- **frontend**: wire FileManager/TiptapEditor with new attachment refs + i18n (0376a01)
- **backend**: add AI clip-enhance API and attachment/share infra (bb91576)
- **rag**: support xlsx/xlsm/xltx attachment indexing for AI Q&A (d184942)

### 🐛 修复

- **release**: prevent cross-platform native module mismatch in Win installer (5d73e19)

### 🔧 其他

- **clipper**: support Chrome/Edge/Firefox packaging + release v0.1.1 artifacts (10b36d2)


## v1.0.35 - 2026-05-11

### 🐛 修复

- **db**: 修复老库启动崩溃 SqliteError: no such column: workspaceId (d445c10)
- **release**: .fpk 产物只收集当前版本，避免 dist-fpk 历史堆积误传 (4e3bf3b)


## v1.0.34 - 2026-05-11

### 🐛 修复

- **db**: 修复老库启动崩溃 SqliteError: no such column: conversationId (984b1c4)
- **electron**: 修复 Win 安装包启动报 ERR_DLOPEN_FAILED 的根因 (8d2da99)
- **tasks**: 更新任务后同步刷新左侧分组计数（今天/未来7天/已逾期） (b39a825)
- **tasks**: 修复待办按日期分组/展示的时区错位（今天/本周/逾期） (edcc285)


## v1.0.33 - 2026-05-11

### ✨ 新增

- **ai**: 知识问答支持多会话（多聊天并行保存） (d10764c)
- **ai**: 批量 AI 操作（标签/归类） (a11bdc2)
- **ai**: 笔记归类建议（AI 自动目录归类） (313b200)
- **ai**: 自定义指令模板可保存与复用 (2395a93)
- **ai**: RAG 知识库支持附件内容索引（PDF/文本/docx 等） (afdc482)
- **backup**: 自动备份支持每日定时/保留数量/邮件通知 (eded447)
- **users**: 个人空间导出/导入开关下沉为 per-user 字段 (4769c7f)
- **upload**: 附件上传支持拖拽 (beb74d8)
- **ios**: 接入 Capacitor iOS 工程骨架与 GitHub Actions TestFlight 发版 (0320ba8)

### 🐛 修复

- **build**: unpdf 加入 esbuild external 名单，修复后端 bundle 失败 (bb46727)
- **backend**: 修复 backup.ts 重载签名默认参数导致的 TS2371 编译错误 (b69d66a)
- **security**: RAG 知识库索引按工作区/个人空间隔离 (5e5e899)
- **ui**: 修复笔记列表长标题挤掉预览行 (2b9d4c9)
- **ai**: AI 写作助手 markdown 格式化丢失链接和图片 (91e42e4)
- **electron**: 修复 main.js 第 702 行非法字符串导致主进程启动崩溃 (e851eeb)
- **release**: 仅上传当前版本产物到 GitHub Release，避免历史包混入 (91edab8)


## v1.0.32 - 2026-05-09

### ✨ 新增

- **release**: wire NOWEN_BUILD_TIME/APP_VERSION into Docker, add lite/clipper targets (d3ab15f)
- **update**: tighten cross-platform update flow (8b56551)
- **update**: in-app update notifier & clipper pack tweaks (1ba6730)
- **about**: add sponsor QR card in Settings -> About (9f78cd3)

### 🐛 修复

- bug (de5b1dc)
- **update**: suppress banner when appVersion already matches (127c1ee)
- **notes**: enforce workspace isolation on note move (a783d31)
- **clipper**: derive firefox manifest from chrome manifest (bef9e82)
- **attachments**: inherit workspaceId from note on upload (65a71cd)

### 📝 文档

- document fpk one-click install for fnOS (6d7c588)



## v1.0.31 - 2026-05-08

### ✨ 新增

- **about**: add sponsor QR card in Settings -> About (9f78cd3)
- **fpk**: auto-detect fnpack binary by platform and arch (770aa37)
- **release**: atomic publish - fpk before docker push (e262748)
- **release**: 选项 5 严格原子发布，未签名/无产物均不推送 (1abe912)
- **release**: 智能 git pull，支持 diverged 自动 rebase / merge (db99dbb)
- **release**: release.sh 支持 .fpk target；菜单选项 5 与新选项 7 都可打 .fpk (4c4a9db)
- **files**: 图片/文件支持下载（网格 hover、列表操作列、详情抽屉主按钮） (334a934)
- **files**: 新增文件管理模块（列表/分类/搜索/预览/反向引用跳转/上传删除） (adb012f)
- **backup**: 支持导入外部 .bak / .zip 备份到备份仓库 (8571042)
- **smtp**: 数据管理内嵌 SMTP 配置教程入口与常见邮箱速查 (f706e3a)
- **backup/email**: 发送邮箱支持附件格式选择 + QQ/163/Gmail/Outlook SMTP 教程 (713fa6d)
- **backup**: 备份一键发送邮箱 + 管理员 SMTP 邮件通道 (f268fe1)
- **export**: 单笔记导出 PDF/SVG 能力增强 (3a2c80f)
- **electron**: add lite mode (remote server) with runtime switch (1772a49)
- LAN discovery + offline queue + Youdao import + biometric quick login + sort menu fix (12652f3)
- **data-manager**: 替换备份 sudo 弹窗为自定义 Modal，并合入近期多模块改动 (c27db46)
- **editor**: 优化协作横幅与编辑交互体验 (c58365e)
- **ai**: 获取模型下拉自适应弹出方向，避免被底部遮挡 (01b7fea)
- **ai**: 切换服务商时缓存API Key，避免切换后丢失 (24ccbdc)
- 优化笔记切换性能与体验, 新增设置关于页, 命令面板, 动效系统, 桌面端菜单增强 (57ff957)
- web clipper improvements, HTML preview fixes, privacy policy (ccbaa50)
- **discovery**: 局域网 mDNS 自动发现 + 多端发版脚本与打包降噪 (b9179fa)
- **release**: 版本号建议聚合本地/GitHub/Docker Hub 三端 (d1d3845)
- **frontend**: 抽离 ServerAddressInput 与 serverUrl 工具，统一服务器地址解析 (a644b52)
- **mobile**: 键盘弹起时隐藏顶部工具栏并显示底部浮动工具栏 (391e5ab)
- **release**: ARM64 多架构构建 + release.sh 升级 (9715953)
- **editor**: 图片自定义大小 + 对称缩放 + 快捷菜单 + 触屏支持 (074053f)
- 附件存储独立化 + Docker 发布脚手架 (8c0e2d1)
- **security**: 2FA + 会话管理 + 用户删除数据转移 + 多标签同步 等安全加固 (2df2026)
- **editor**: 迁移到 Markdown 编辑器 (f276863)
- **share**: 支持分享笔记可编辑模式与访客昵称 (e7454ef)
- **editor**: 修复缩进与 Tab/Ctrl+S 键盘支持 (76a04df)
- drag sort, editor enhancements, paste fix, delete key, slash commands, canDragSort TDZ fix (90a4337)
- 增加Markdown粘贴自动识别转换提示、斜杠快捷命令菜单及多项UI优化 (5c449f1)
- 阶段四 - Webhook事件系统、审计日志、数据备份恢复、批处理管道、插件系统、OpenAPI规范、MCP Server(22工具)、TypeScript SDK、CLI命令行工具、README全面更新 (cad1786)
- AI功能增强 - 文档智能解析/批量格式化/知识库导入(③⑤⑥) (239b309)
- 移动端全面适配 + Android APK 打包支持 (009fb17)
- 小米云服务导入笔记支持导入笔记图片 (2561b7f)
- support Electron desktop packaging (b70719b)
- add-tag-color-picker-support (897365a)
- add-release-signing-config-for-Android-APK (f819145)
- notebook-icon-picker-and-calendar-view (6400e53)
- add Android Capacitor packaging with server connection support (b43cb18)
- add Electron desktop packaging support - Add electron/main.js (main process: fork backend, create BrowserWindow) - Add electron/builder.config.js (NSIS/DMG/AppImage) - Add electron/icon.png placeholder icon - Support ELECTRON_USER_DATA env for DB and fonts paths - Support FRONTEND_DIST env for static file serving - Add DiaryCenter placeholder component - Add description/author to package.json - Update .gitignore with release/ (8299582)
- remove diary feature, update docs (OnlyOffice -> Univer.js) (bad18fa)
- add diary (Moments) feature - full stack implementation (43e3076)
- add tag delete in sidebar and fix tags lost on note save (729415c)
- add Ctrl+S save shortcut and update README (f520aa0)
- AI 全功能集成 (Phase 1-5) (9f66a75)
- 侧边栏/笔记列表宽度拖拽调整 & 笔记锁定功能 (ab1a1db)
- 集成 ONLYOFFICE 文档中心 - 支持 Word/Excel/PPT 在线编辑 (9265008)
- **mindmap**: 列表右键支持下载 PNG/SVG/xmind 格式 (6d37881)
- 新增思维导图功能，支持增删改查 (8266f68)
- 新增小米云笔记和OPPO云便签导入功能 (6b12d37)
- 新增手机笔记导入支持（小米/OPPO/一加/vivo），支持 HTML 格式导入 (905b16d)
- 笔记本显示笔记数量，支持实时更新 (a0ec85e)
- 字体持久化修复、笔记移动、字数统计、笔记大纲功能 (a078702)
- 站点品牌定制 + 标签引擎 (74cddf9)
- 添加登录认证、设置中心、恢复出厂设置、右键菜单等功能 (53dc315)
- 暗黑模式、待办事项中心、笔记内嵌Task、数据导入导出 (83b6bd5)
- md (70e2c69)
- init MyStation - self-hosted note app with Hono+SQLite backend and React+Tiptap frontend (c0a283f)

### 🐛 修复

- **fpk**: align compose image tag with docker push (v-prefix) (7638896)
- **release**: PC 打包前追加 frontend 依赖齐全性检查 (72e8a5d)
- **api**: 移除 files.list 中对 FileCategory='all' 的过期判断 (f3790be)
- **release**: PC 打包前自动检查并补装 backend 依赖 (fe3c51f)
- **EditorPane**: 修复 selfUser TDZ 报错 (c3b1336)
- **realtime**: 本人编辑时不再误提示 XX 正在编辑/XX 更新了笔记 (946910f)
- **editor**: 列表中图片序号顺延 & 邮箱链接不再误唤起邮件客户端 (d6a3a5f)
- **files**: 挂载 api.files 模块（stats/list/get/remove/upload），修复运行时 undefined (26c3490)
- **sidebar**: 补齐 Inbox 图标 import，修复文件管理入口运行时 ReferenceError (cc909b7)
- **files**: 补齐 filesRouter import，修复启动 ReferenceError (4f5e2d8)
- **backup**: 修复 Windows 下 zip 全量备份恢复 dryRun 报 'unable to open database file' (07120d1)
- 修复 BackupHealth 重复声明和 typeof this.health 编译错误 (8fe21a4)
- 修复 backup.ts 中 typeof this.health 的 TS2304 编译错误 (eb567b2)
- **editor/image**: 修复点击图片直接放大、调不出尺寸手柄的问题 (97ac298)
- **export**: inline attachments as base64; fix underscore escape & double blank lines on round-trip (435eada)
- README (0a3a0d4)
- **editor**: smart toggleHeading and normalize pasted HTML to avoid multi-line paragraph bug (80896c2)
- **editor**: 修复粘贴 Markdown 时 frontmatter 正则误删文档中间内容的问题 (4227eda)
- 任务列表水平居中对齐 (7bb7893)
- 修复选中文字时BubbleMenu工具栏不显示的问题; feat: 优化图片缩放及clipper polyfill (6445c69)
- Android App 图片不显示问题 (27a2e26)
- bug (2115df0)
- release.sh 自动探测 JAVA_HOME, 解决 Android 构建 invalid source release 21 (eb65ccd)
- AppImage fileAssociations ext数组兼容 + 移动端标签区域按钮样式修复 (2370397)
- electron-builder 用 --publish never 替代 -c.publish=never 修复 25.x 校验 (ac0808f)
- 修复 TS 编译错误, release.sh 新增交互式发布模式选择 (604b42e)
- mDNS 名字冲突 (08ea660)
- desktop remote server login + docker vite build (b522944)
- **micloud**: 支持无标题纯图片笔记导入 (fe20a8b)
- **ui**: 修正笔记列表/侧边栏的 flex 截断问题 (d50742b)
- 修复"未来7天"任务统计数量不准确的问题-前端 (bc40448)
- 修复"未来7天"任务统计数量不准确的问题-后端 (61de3fb)
- **ai**: 修复 AI 问答无法检索中文笔记 & 版本历史写入过于频繁 (514de52)
- **editor**: 修复粘贴多行中文文本及 # 附近输入导致的崩溃，补充版本历史面板 i18n (3bcccfa)
- 修复编辑器多个 bug（粘贴崩溃、恢复版本回退、时间偏差、ref 警告） (57c2beb)
- **editor**: 修复编辑期间光标跳行问题，优化导入导出与笔记列表 (9e3c1d6)
- **i18n**: 补齐 zh-CN common 命名空间缺失的 needNotebookFirst 等 key (5d38e91)
- **sidebar**: 优化笔记本拖入父级的命中区域与视觉反馈 (465f7ee)
- **sidebar**: 笔记本拖拽排序后 UI 实时生效 (73c6065)
- **webhook**: 补充 note.trash_emptied 事件类型，修复后端 tsc 编译错误 (31cb393)
- 修复任务列表单行显示与侧边栏小屏交叠问题，新增代码块视图与 Toast 组件 (12eb86d)
- 修复Ollama连接405错误和分享页面无法滚动问题 (348a19f)
- 修复列表标记不显示、任务列表换行及移动端键盘空白问题 (0b46fe4)
- 修复笔记本文件夹中笔记列表缺少滚动条支持的问题，添加min-h-0约束flex子项高度 (9e5110d)
- 修复ai.ts TypeScript编译错误 - mammoth API/类型断言/冗余比较 (b7993f7)
- switch Docker base image from Alpine to Debian slim (5cca40a)
- tag-color-picker-use-portal-to-prevent-overflow-clipping (e9fe628)
- resolve Kotlin stdlib duplicate class conflict in Android build (e435d84)
- skip package-lock.json in Docker build to resolve cross-platform rollup optional dep issue (3aa78cb)
- use npm install instead of npm ci in Dockerfile for cross-platform compatibility (7f38437)
- remove import of non-existent diary route (4609d06)
- regenerate backend package-lock.json to match package.json (0393f27)
- regenerate frontend package-lock.json to match updated package.json (20d6e78)
- exclude /api paths from static file serving in production mode (4eeccae)
- remove @tiptap/pm from manualChunks (missing exports entry) (e6ac348)
- increase Node.js heap memory for frontend build (OOM) (5dc54dc)
- add @univerjs/presets to frontend dependencies (853aed9)
- add word-extractor to backend dependencies (4985075)
- resolve Docker build TypeScript compilation errors (307f041)
- replace npm ci with npm install in Dockerfile for npm version compatibility (93bb0e5)
- 修复打开Word文档时的QuantityCheckError(Nr4)错误`n`n- 将UniverDocEditor和UniverSheetEditor改为React.lazy动态导入`n- 避免Sheets和Docs preset的FUniver.extend()同时执行导致DI冲突`n- 添加Suspense包裹编辑器组件，优化加载体验`n- 配置Vite optimizeDeps keepNames保留class名称便于调试 (2d6b429)
- 修复新建文档空白问题 - 动态生成有效的 docx/xlsx 模板文件 (cb4cb72)
- 修复 OnlyOffice chat/comments 参数废弃警告，移到 permissions 中 (2c4c7e0)
- OnlyOffice 编辑器加载问题 - 动态推算公网地址 + onError 时隐藏 loading (3e17f68)
- 添加 APP_CALLBACK_URL 修复 OnlyOffice 容器间文件下载失败 (26b1d26)
- 移除 ollama 服务和 version 属性，Ollama 由用户自行部署 (e2b089c)
- 修复 Docker 构建缺少 react-markdown 依赖问题 (bfc4660)
- 修复TS2367类型错误，phase条件块中加入error状态 (9480dc7)
- 修复导入 Markdown 后显示 HTML 标签的问题 (8558b12)
- TaskRow 组件添加 PRIORITY_CONFIG 定义修复 TS2304 (4b328f8)
- 将 i18n 依赖移至 frontend/package.json 修复 Docker 构建 (e586990)
- 修复 framer-motion PopChild ref 警告 (83aedca)
- ContextMenu ref 类型兼容性修复（Docker 构建 TS 报错） (9be19e4)

### ⚡ 优化

- optimize build for low-memory server (2G RAM) (16bfef5)

### ♻️ 重构

- **data-manager**: 引入二级 Tab 分栏，降低长页阅读成本 (9e756c8)
- 优化任务统计查询 — 合并5次SQL为1次聚合, 补全 TaskStats.week 类型 (c668822)
- **release**: 合并 build-arm64.sh 到 release.sh (a7669c8)
- diary feature - pagination, optimistic updates, component split (0a0ed8e)
- 移除 OnlyOffice，改用浏览器端 Word/Excel 阅读编辑 (d34d83e)
- rename MyStation to nowen-note across all files (0d392bb)

### 📝 文档

- document fpk one-click install for fnOS (6d7c588)
- 重构 README 并新增英文版、部署指南与截图 (f33ac12)
- 新增微信赞赏码 (b39e7f2)
- declare VOLUME /app/data in Dockerfile and update README notes (e4bb0f2)
- update README with mobile adaptation and Android APK details (df321d5)
- update-readme-moments-calendar-icon-picker (e2de633)
- 全面更新 README，补充 AI/OnlyOffice/Docker架构/数据库设计等完整文档 (fc333cf)
- 更新 README，补充 AI/OnlyOffice/思维导图/任务管理等完整功能文档 (aab67ac)
- 更新 README，添加思维导图、国际化、移动端适配等功能说明 (7ef4f4c)
- 更新 README 文档，添加思维导图、国际化、移动端适配等功能说明 (90329fb)
- 更新README，添加小米云笔记和OPPO云便签导入功能说明 (482318a)
- 添加7种安装部署教程（Windows/Docker/群晖/绿联/飞牛/威联通/极空间） (f59c86c)
- 更新 README，补充认证、右键菜单、待办、数据管理等功能文档 (8251ceb)
- update frontend README with bilingual (CN/EN) documentation (9b69492)

### 📦 构建

- **release**: 支持原子发布 - 三端全部构建成功后才统一推送 (5768769)

### 🤖 CI

- **release**: fix native module rebuild and artifact path (759cac8)

### 🔧 其他

- misc frontend/backend updates (49970a4)
- **fpk**: add 飞牛 NAS .fpk packaging scaffold (v1.0.28) (b1a091c)
- 新增 .mailmap 统一历史作者身份 (0f05587)
- **clipper**: release v0.1.1 (d583449)
- release.sh 自动丢弃未提交改动而非中断 (f5a88c6)
- bump version (a6429e2)
- desktop app overhaul + icon refresh + JWT auto-provision (ef8ae99)
- 配套改动（micloud 路由、i18n、NoteList/Sidebar/TaskCenter、构建配置） (569d50a)
- **frontend**: API 诊断增强与前端杂项改动 (52c627e)
- remove Document Center feature (Univer.js) (abff16f)


