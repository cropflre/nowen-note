# 更新日志 / Changelog

本文档由 `scripts/generate-changelog.mjs` 从 git commit（Conventional Commits）自动生成，并在每次
`scripts/release.sh` 发版时追加新版本。手写修订同样欢迎——发布脚本只会在文件顶部的占位标记下方
追加新版本条目，已有内容不会被改写。

格式说明：

- 每个版本一个二级标题：`## vX.Y.Z - YYYY-MM-DD`
- 条目按类型分组：新增 / 修复 / 优化 / 文档 / 重构 / 其他
- Commit 以 Conventional Commits 为规范（feat / fix / perf / refactor / docs / chore / style / test / build / ci）

<!-- ADD_NEW_HERE -->

## v1.4.16 - 2026-08-19

### 🐛 修复

- **笔记切换**: 阻止旧富文本回执抢回激活笔记 (20bbee8)
- **视频**: 首次打开笔记前准备附件签名 (33f39ad)
- **视频**: 局域网附件授权改用原生 HTTP (ac25076)
- 优化代码块全选快捷键逻辑 (fc47cc3)
- 重新清理历史 Markdown 块标记 (c9dd1d0)

### ✅ 测试

- **笔记切换**: 覆盖提交后的迟到保存回执 (dd1931a)
- **视频**: 覆盖 Android 局域网附件授权 (7330555)
- **视频**: 覆盖首次打开前附件授权准备 (e8ded10)

### 📌 杂项

- 补充 SignPath 测试签名配置回归测试 (414272c)
- 完善 SignPath 测试签名配置 (4d2c2eb)
- 补充 SignPath OSS 水印限制回归测试 (7a1016e)
- 同步修复 Lite SignPath OSS Artifact Configuration (be46cfe)
- 修复 SignPath OSS Artifact Configuration 水印限制 (c2447c0)
- 纳入 SignPath 发布链路回归测试 (a237006)
- 迁移 SignPath 代码签名公开政策 (8616da5)
- 补充 SignPath Artifact Configuration 回归测试 (415199f)
- 更新 SignPath 正式发布链路契约测试 (83ccfb8)
- 补充 Windows SignPath 签名验证回归测试 (4e8ea92)
- 补充 SignPath 正式发布配置回归测试 (3bcf305)
- 强制正式 Release 汇总 SignPath 已签名 Windows 产物 (1f41b90)
- 迁移 SignPath Windows 正式签名流水线 (8fcef19)
- 接入 Lite SignPath Windows 发布者动态注入 (a7fdcda)
- 接入 SignPath Windows 发布者动态注入 (c02a4fd)
- 迁移本地 Windows 发布守门入口 (ea35bdb)
- 迁移本地未签名 Windows 发布守门规则 (0b53b58)
- 迁移 Windows 签名后更新元数据刷新入口 (bd101d0)
- 迁移签名后 Windows 更新元数据重建逻辑 (6cf9a58)
- 迁移 Windows 签名验证入口 (ef03283)
- 迁移 Windows 签名信息导出脚本 (acb2724)
- 迁移 Windows Authenticode 严格校验器 (6e2bc2e)
- 迁移 SignPath 发布配置检查入口 (fcb3beb)
- 迁移 SignPath 正式发布配置校验 (8f5d29a)
- 迁移 SignPath Windows Lite 产物配置 (504938b)
- 迁移 SignPath Windows Full 产物配置 (67fe3d2)
- 更新 SignPath 手动测试签名契约 (67dec7a)
- 确保手动构建始终执行 SignPath 测试签名 (837978e)
- 补充 SignPath 测试签名工作流契约 (56fc631)
- 接入 SignPath Windows 测试签名链路 (6fa6441)
- 补充 macOS 双架构压缩包发布校验 (ae7cbc0)
- 兼容 macOS 双架构手动下载包校验 (1afc0da)
- 补充 macOS 手动下载压缩包识别 (5d7b164)
- 补充桌面平台 Release 说明回归测试 (528268d)
- 在 Release 说明中明确桌面平台矩阵 (886c3e2)
- 将发版发布者契约纳入更新发布测试 (a79f7b1)
- 补充 macOS 发版完整性回归测试 (cb2baca)
- 强化 macOS 发版产物完整性门禁 (60ac8e6)
- 修复完整桌面发版漏传 macOS 产物 (2e656e6)
- 新增 macOS 发版产物完整性校验 (b63e715)
- 补充 Markdown 选区符号包裹回归测试 (#726) (3e7eb95)
- 优化 Markdown 选区符号包裹输入链路 (#726) (769ede8)
- 补充分享管理剪贴板兼容性回归测试 (f3f2a43)
- 修复 Edge 分享链接复制兼容性 (a26cf31)

## v1.4.15 - 2026-08-18

### 🐛 修复

- **回收站**: 点击已删除笔记时提示先恢复 (c55cfa9)
- **回收站**: 隐藏已删除笔记设置图标入口 (da26e07)
- **回收站**: 阻止已删除笔记进入正常加载链路 (9f36f30)
- **回收站**: 启用已删除笔记生命周期守卫 (159adb0)
- **回收站**: 避免 API 包装器类型收窄 (f1647cc)
- **回收站**: 收敛生命周期守卫 DOM 监听 (2588550)
- **回收站**: 阻止已删除笔记进入正常编辑链路 (785f15c)

### ♻️ 重构

- **回收站**: 删除失效的 DOM 生命周期守卫 (3621d16)
- **回收站**: 移除失效的 DOM 生命周期守卫 (8869e3c)

### 📝 文档

- **readme**: update v1.4.14 release documentation (e298b83)
- **readme**: 更新 v1.4.14 发版文档 (b5a8a40)

### 📌 杂项

- 测试(发布)：覆盖 CI macOS 产物汇总流程 (ec42206)
- 修复(发布)：统一由本地脚本汇总 CI 的 macOS 产物 (92b73de)
- 测试(发布)：锁定单一 Release 发布者契约 (1794c93)
- 修复(Windows CI)：使用 PowerShell 解压 Node ZIP (d3f5509)
- 修复(发布)：移除 Actions 的 Release 发布职责 (84c9e4c)
- 测试(回收站)：锁定知识树恢复失败态链路 (0986b74)
- 整理(笔记加载)：保持原有类型声明顺序 (08fe721)
- 测试(笔记加载)：覆盖失败后被新导航清理 (7b0f3de)
- 修复(知识树)：挂载笔记失败态恢复桥 (fd004fb)
- 修复(知识树)：导航时清理遗留的笔记失败态 (9e03d94)
- 修复(笔记加载)：允许后续导航清理失败状态 (f77d83e)
- 测试(权限)：覆盖笔记投影失效后的自动恢复 (3172f7a)
- 修复(笔记加载)：允许失败后直接退出错误遮罩 (ce57bc6)
- 修复(权限)：访问前自愈失效的知识树投影 (82a2a6e)
- 修复(权限)：增加知识树资源投影自愈 (bd8cfbf)

## v1.4.14 - 2026-08-18

### ✨ 新增

- **移动端**: 折叠文件详情辅助信息 (9f6a2ba)
- **移动端图片**: 挂载图片剪贴操作桥 (6dd100b)
- **移动端图片**: 增加复制剪切粘贴桥 (a1dae47)
- **图片**: 增加富文本图片节点剪贴事务 (966d5d2)
- **markdown**: 选中文字支持语法符号自动包裹 (#726) (55a78c5)

### 🐛 修复

- **备份**: 修复流式恢复 TypeScript this 类型 (b603421)
- **移动端**: 修正文件类型摘要映射 (357a8bd)
- **图片**: 剪切未选目标时保持待移动状态 (2ce8ae2)
- **视频**: 签名刷新后自动恢复播放器 (268ab6e)
- **视频**: 跟随附件签名地址刷新播放源 (aaf59c9)
- **图片菜单**: 滚动时保持工具栏锚定图片 (0b164ad)
- **图片**: 旋转后保持编辑菜单选中状态 (cb78ef8)
- **备份**: 增加流式恢复启动守卫 (2a7d554)
- **备份**: 校验大归档流式恢复启动 (84ac455)
- **export**: include team root documents in note selection (9b7e4f2)
- **mobile**: prevent note list text selection on long press (37726ea)
- **mobile**: keep context menu inside viewport (171ddf4)
- **android**: restore native text selection actions (787964e)
- **notes**: preserve source note while target is loading (3670460)
- **notes**: narrow stale activation guard to commit race (8af8074)
- **notes**: prevent stale save ack from restoring previous note (52168b2)
- **notes**: add active-note switch intent guard (95d30bc)
- **export**: rasterize Mermaid before image capture (#728) (3846119)
- **export**: render Mermaid diagrams in image exports (#728) (2c0c144)
- **mobile**: 修复权限分享与公共空间导航 (00e41fc)
- **浏览器插件**: 增加登录会话自动续期 (a242997)
- enable streaming full backup restore (5775560)
- stream large full backup restores (8835262)

### ✅ 测试

- **图片**: 覆盖移动端图片复制剪切粘贴 (11def44)
- **视频**: 修正播放器重建后的断言 (2bbcd0a)
- **视频**: 覆盖签名地址晚到后的播放源恢复 (fb98237)
- **图片**: 覆盖旋转后保持节点选中 (92ad393)
- **备份**: 锁定大归档恢复生产入口 (cdb23ec)
- **export**: cover team root document markdown zip (792cf2e)
- **notes**: cover source-note save during switch (2b37639)
- **notes**: cover stale activation guard (527dbe5)
- guard streaming large backup restore (4cb010d)

### 📌 杂项

- 修复(移动端)：确保展开工具栏可完整滚动 (63d2383)
- 修复(移动端)：输入法弹出时保持顶部工具栏布局 (2783ba7)

## v1.4.13 - 2026-08-14

### ✨ 新增

- **设置**: 增加 QQ 群反馈入口 (7564fe8)

### 🐛 修复

- **编辑器**: 修复只读笔记与格式刷事件 (d03f912)
- **备份**: 接入全量备份后台任务 (7ef63ab)
- **文件夹同步**: 完善附件引用与预览 (069416e)
- **思源导入**: 优化导入性能并稳定进度展示 (a490dae)
- **图片布局**: 修复旋转图片挤入文字行 (d8198f9)
- **多语言**: 补齐笔记删除提示翻译 (5155add)

### 📝 文档

- **计划**: 补充备份与思源导入实施计划 (1ca23b1)
- **思源导入**: 明确性能与进度稳定性设计 (3fdf2b8)
- **readme**: update v1.4.12 release docs (ec7a6bd)
- **readme**: 更新 v1.4.12 发版文档 (084b4a1)

## v1.4.12 - 2026-08-14

### 🐛 修复

- **AI问答**: 补齐主内容收缩边界 (7a4be43)
- **AI问答**: 优化会话侧栏与知识库范围交互 (5cfdd78)
- **备份**: 修复全量备份超时与高资源占用 (945d819)
- **export**: scope team single-note zip jobs (ff6f33d)
- **export**: resolve single-note workspace scope (27fca21)
- **编辑器与桌面端**: 修复富文本粘贴并记住窗口状态 (76f685c)

### 📝 文档

- **readme**: 更新 v1.4.11 发版亮点 (08d1e5d)
- **readme**: update v1.4.11 release highlights (f00359e)

### ✅ 测试

- **export**: cover team single-note workspace scope (00a06c9)

### 🔧 其他

- **发布**: 收口 v1.4.12 版本元数据 (c12c75e)


### 🐛 修复

- **AI问答**: 补齐主内容收缩边界 (7a4be43)
- **AI问答**: 优化会话侧栏与知识库范围交互 (5cfdd78)
- **备份**: 修复全量备份超时与高资源占用 (945d819)
- **export**: scope team single-note zip jobs (ff6f33d)
- **export**: resolve single-note workspace scope (27fca21)
- **编辑器与桌面端**: 修复富文本粘贴并记住窗口状态 (76f685c)

### 📝 文档

- **readme**: 更新 v1.4.11 发版亮点 (08d1e5d)
- **readme**: update v1.4.11 release highlights (f00359e)

### ✅ 测试

- **export**: cover team single-note workspace scope (00a06c9)

## v1.4.11 - 2026-08-13

### ✨ 新增

- **笔记**: 支持创建独立副本 (ae70543)

### 🐛 修复

- **search**: restore indexed content as search source (9bf642f)
- **Markdown**: 修正编辑器主题变量 (6f4b659)
- **菜单**: 统一笔记右键菜单并修复导出子菜单显示 (07a5777)
- version iOS/TestFlight builds from release tags (2107114)
- **AI**: 修复知识库统计和聊天内容布局 (cb52d71)
- **知识树**: 修复搜索状态下新建文档不可见 (21941cc)
- **移动端**: 修复协作笔记图片全屏预览黑屏 (3966880)
- **编辑器**: 修复移动端操作面板显示异常 (aaf8aa0)
- **备份**: 恢复自动全量备份保留清理 (434c091)
- **编辑器**: 修复重复标题编辑时光标不可见 (33fe08b)
- **editor**: keep duplicate title caret visible (c1b6cbe)
- **editor**: mount duplicate title caret bridge (24ee6f5)
- **editor**: restore visible caret for duplicate title assist (e69e635)
- **editor**: remove duplicate desktop image transform menu (08e1440)
- **publication**: register shared notebook attachment access (f664a41)
- **markdown**: restore live preview on mobile toolbar (d43d9d4)
- **markdown**: restore live preview mode binding (cec2bff)
- **markdown**: normalize mobile split mode on note changes (18d3583)
- **markdown**: mount mobile view controls bridge (a6c929d)
- **markdown**: restore mobile edit preview controls (f5b623c)
- **editor**: expose image transform actions in desktop toolbar (aee9a2b)
- expand mobile markdown editing viewport (b25ad1a)
- **ci**: make v1.4.10 metadata finalizer valid (5cf81ff)

### ♻️ 重构

- **图片**: 移除重复变换菜单 DOM 隐藏桥 (3cdebb1)
- mount task entry ux bridge (681c265)
- separate task search from quick add (564fbd5)
- clarify task search and create hierarchy (5fa9ac2)

### 📝 文档

- **MCP**: 修正启动器路径配置说明 (20ba0f3)
- **readme**: update v1.4.10 release highlights (9fede0a)

### ✅ 测试

- **remote-image**: align trashed note visibility with ACL (0ca26f9)
- **knowledge-tree**: align sidebar move guard contract (fd20dad)
- **菜单**: 补充保存模板菜单契约测试 (409834c)
- **editor**: cover duplicate title caret visibility (5cd43e6)
- **editor**: cover image transform menu dedupe (0051a02)
- **publication**: guard shared notebook attachment access (ef09eba)
- **markdown**: harden live preview control assertions (ca08529)
- **markdown**: cover restored live preview controls (44ffa9b)
- cover task entry visual hierarchy (d69f719)

### 🤖 CI

- **pg**: remove temporary safe sync fallback (882c79a)
- **pg**: add safe main sync fallback (03e930e)

### 🔧 其他

- **markdown**: clean mobile view bridge import (795c1e2)
- **version**: bump backend to v1.4.10 (ed94f30)
- finalize v1.4.10 release metadata (98af79a)

## v1.4.10 - 2026-08-12

### ✨ 新增

- add duplicate title prefix warning (581a72a)
- improve Markdown find and replace (4848f8d)
- add current directory note search (b61b6b6)
- **知识树**: 支持拖拽移动节点层级 (2dd76d0)
- **图片预览**: 增加旋转与独立复原操作 (e2d3e22)
- **笔记模板**: 补齐移动端模板入口 (94008d6)
- **桌面编辑器**: 增加原生文本上下文菜单 (4debf98)
- **桌面附件**: 使用系统默认程序打开本地办公附件 (f72e2d6)
- **移动编辑器**: 将图片和视频加入紧凑工具栏 (8e0512a)
- **笔记模板**: 支持保存模板并从模板新建笔记 (3dd7800)

### 🐛 修复

- **编辑器**: 优化 Markdown 搜索面板换行布局 (6d9f4d5)
- **知识树**: 隐藏加密目录中的笔记 (b208299)
- **ci**: repair PostgreSQL sync workflow YAML (79b0f3f)
- **editor**: narrow image target positions before use (531225b)
- disable offline sync by default (92f7b12)
- retry quarantined offline attachments (55e6dac)
- validate offline blobs before rendering (a7450f8)
- quarantine broken offline attachment blobs (ae9b07d)
- add offline attachment recovery signal (e77f297)
- keep offline attachment blobs out of online rendering (1cd4582)
- **富文本粘贴**: 保留笔记间复制格式 (e516c5b)
- tolerate Android media File wrapper metadata (e4d59d7)
- map image upload events to selected file (cba6ff9)
- map video upload events to selected file (1460923)
- bridge original media files into upload lifecycle (8f7aeed)
- preserve mobile media file identity (b615415)
- identify mobile media files across DataTransfer (231ca0a)
- verify uploaded video byte size (4f50677)
- align mobile media size display (30a2740)
- stabilize native multipart attachment uploads (c054fed)
- prevent note card text selection on mobile long press (7506ff2)
- **三栏布局**: 将目录搜索框换行显示 (d9dcf29)
- adapt mobile note menu to short viewports (36e9174)
- keep settings close button visible while scrolling (fa78f46)
- preserve image rotation in fullscreen viewer (d424eb0)
- focus title after creating note (c54e665)
- wrap long note titles (58a479c)
- **附件**: 稳定图片身份并保护临时地址持久化 (c843ccb)
- **服务器地址**: 修复公共路由前缀识别 (5c5ba8b)
- **图片编辑**: 修复查看到编辑的完整交互 (351eb04)
- **笔记模板**: 改用应用内保存弹窗 (b881665)
- **tasks**: keep postgres reminder schema in sync (bc27503)
- **tasks**: keep reminder behavior consistent in quick capture (b6d5c64)
- **tasks**: make reminder creation timezone-aware and observable (752d908)
- **tasks**: use server-resolved reminder time when timezone is known (9f55b84)
- **tasks**: resolve reminder times in creator timezone (47632dd)
- **tasks**: persist reminder timezone offset (1a4be7f)
- **tasks**: register reminder timezone migration (f231155)
- **tasks**: preserve date-only deadline semantics (0b84165)
- **tasks**: add postgres reminder timezone column (b76e6c7)
- **tasks**: add reminder timezone migration (fca68fd)
- **笔记模板**: 修正模板列表请求路径 (7253c3f)
- **下载页**: 增强发布资产回退与平台分组 (9c9174b)
- **笔记模板**: 防止清理任务误删模板附件 (784a5e5)
- **备份保留**: 统一 db-only 清理并持久化停用配置 (9de297a)
- **移动端返回**: 统一浮层返回键消费顺序 (739c0ea)
- **思源导入**: 完善拖拽识别与无响应提示 (947b677)
- **思源导入**: 让自动恢复目录走统一知识树持久化 (5eda64b)
- **往返导入**: 修复 Markdown 附件 ZIP 无法重新导入 (e32752c)
- **tasks**: 修复截止时间提醒未自动创建 (58bc857)

### ♻️ 重构

- **富文本粘贴**: 默认保留文字颜色 (8008c98)
- **图片体验**: 统一查看器与编辑交互 (3eeb77b)

### ✅ 测试

- **tasks**: cover timezone-aware reminder schedule (68c49d4)
- **tasks**: keep date-only reminder separate from deadline (ce3f576)
- **移动编辑器**: 补充紧凑工具栏契约 (333f7cf)

### 🔧 其他

- **ci**: remove obsolete invalid PostgreSQL final sync workflow (8c0a275)
- **ci**: repair PostgreSQL sync workflow parser error (cd67ee4)
- **version**: prepare v1.4.10 (09bfa5b)
- apply v1.4.10 TypeScript release fix (7d287c8)
- remove temporary offline sync workflow (c8d412e)
- set offline sync default off (6b5c77f)
- remove temporary offline attachment patch workflow (5256665)
- apply offline attachment recovery fix (5ebb5fb)
- remove temporary rich text paste workflow v2 (adc4cdc)
- remove temporary rich text paste workflow (26c30ac)
- remove temporary mobile media queue workflow (61aaea5)
- add concurrency-safe rich text paste fix workflow (d30be70)
- make rich text paste fix concurrency-safe (096533d)
- apply mobile media queue status fix (32d070e)
- remove temporary mobile video retry workflow (dd6f432)
- remove temporary mobile video patch workflow (dc60725)
- add temporary workflow for rich text paste fix (2540cb2)
- retry mobile video upload fix with dependencies (d4cdee9)
- apply mobile video upload fix (7dabbd7)
- apply markdown search UI fix (7a251a4)
- retry mobile note menu viewport fix (d27dac5)
- clean directory search runtime import (545daa7)
- apply mobile note menu viewport fix (9aecbb3)
- apply settings close button sticky fix (6fdb05f)
- apply image viewer transform fix (0e9dade)
- apply long note title wrapping fix (2c86bd3)
- **tasks**: preserve migration documentation (ec99b04)
- **tasks**: keep reminder repository diff focused (a0cf6e0)


### ✨ 新增

- **笔记模板**: 支持保存模板、从模板创建笔记，并补齐移动端入口与模板附件保护
- **编辑器**: 增强图片查看、编辑、旋转与附件打开体验
- **Electron**: 新增原生文本右键菜单与本地办公附件系统默认程序打开

### 🐛 修复

- **笔记图片**: 加固附件身份与内容持久化，避免保存后重新打开出现图片占位符
- **导入导出**: 修复 Nowen Markdown 附件 ZIP 往返导入，并完善思源导入反馈与文件识别
- **备份**: 修复自动/手动备份的 db-only 保留策略及停用配置持久化
- **任务提醒**: 统一全天截止、创建端时区与原生通知调度，并收紧提醒接口权限
- **移动端**: 修复 Android 返回键浮层消费顺序并优化媒体入口
- **编辑器**: 修复图片目标位置可空导致的 TypeScript 发版阻断

### ⚡ 优化

- **下载页**: 增强 GitHub Release 页面回退，并按平台与安装类型稳定分组
- **离线同步**: 调整为首次默认关闭，仅在用户主动开启后运行

## v1.4.9 - 2026-08-10

### 🐛 修复

- **客户端连接**: 修复公网 HTTPS 域名登录失败 (fef64db)
- **思源导入**: 终止无限轮询并防止任务重复执行 (814a4fa)
- **浏览器插件**: 修复剪藏组件自动恢复并发布 0.4.0 (9bbae99)
- **说说**: 修复移动端长列表滚动 (4725d8f)
- **关于**: 修复桌面端赞赏码资源加载 (89cc7d6)

## v1.4.8 - 2026-08-10

### ✨ 新增

- **目录树**: 支持多选批量移动和删除 (795ef2a)
- **导入**: 支持 Markdown 附件 ZIP 导入 (c6f32ca)
- **导出**: 增加单篇 Markdown 附件 ZIP 入口 (4e5663e)

### 🐛 修复

- **Docker**: 复制同步提示校验脚本 (7019fa4)
- **导入**: 修正思源进度桥接异常变量 (797f573)
- **图片**: 统一 Electron 图片预览和加载状态 (d76ba65)
- **同步**: 防止 MCP 与 Live 自动保存陈旧覆盖 (6982bee)
- **同步**: 移除全局失败提示并阻止旧产物打包 (13ca303)
- **搜索**: 修复首次输入未触发全文搜索 (e0df8c7)
- **说说**: 修复移动端媒体入口与上传重试 (095cfc5)
- **editor**: 清理图片地址切换后的错误状态 (1919c71)
- **import**: 将思源导入改为后台任务避免 504 误报 (45050d1)
- **ios**: restore CocoaPods script input output paths (1c7c3a7)
- **ios**: allow self-hosted local networking under ATS (0bbf13c)
- **ios**: declare UIScene configuration (72e9a89)
- **ios**: adopt UIScene lifecycle for iOS 27 (a0dd6e8)
- **notes**: protect every cache-first editor from attachment access race (d5c453f)
- **attachments**: keep cached note priming offline-safe (669da65)
- **editor**: prime cached note attachment access before mount (292d260)
- **notes**: prepare attachment access before cached note render (95fb33f)
- **attachments**: add cached-note access priming helper (20ce6d8)
- **sync**: reconcile knowledge-tree deletions immediately (767e111)
- **ui**: add knowledge delete reconciliation helper (5992293)
- **permissions**: bridge trashed note lifecycle ACL (f34a2a7)
- **knowledge**: enforce tombstone ACL on restore (a807dbb)
- **knowledge**: make includeDeleted tree views effective (261f906)
- **permissions**: preserve recycle-bin lifecycle access (61ffe9b)
- **permissions**: expose tombstone access resolver (4290028)
- **permissions**: resolve recycle-bin tombstones safely (902a153)

### ♻️ 重构

- **notes**: keep attachment priming in shared cache-first loader (dad6117)

### ✅ 测试

- **notes**: cover default attachment priming for split editor (f0824b6)
- **attachments**: type fetch mocks for tsc (656947c)
- **editor**: cover image autosave race with latest snapshot (7c7da4b)
- **editor**: cover image save flush on note switch (20726df)
- **notes**: cover cached image note access before reopen (c0e2f2c)
- **attachments**: cover cached note image access priming (2a20a17)
- **ui**: keep delete reconciliation fixtures type-safe (d65fc89)
- **ui**: cover deleted knowledge note reconciliation (d1fc820)
- **permissions**: cover deleted tree visibility and restore ACL (73444e6)
- **permissions**: cover recycle-bin tombstone lifecycle (96e2edb)

### 🤖 CI

- **editor**: distinguish changed-file lint from repository lint (f58a151)
- **attachments**: validate signed access and reference regressions (85fbf3f)
- **editor**: validate lint and build for image persistence fixes (c5a7297)
- **editor**: run note image persistence regressions (06189cb)
- **knowledge**: keep delete reconciliation under regression guard (2c7ef6c)
- retry verified delete reconciliation patch (fc0eb90)
- verify v1.4.7 delete state reconciliation (aa6629d)
- retry v1.4.7 recycle lifecycle bridge (e2a1f6b)
- apply v1.4.7 recycle lifecycle bridge (7c8b42f)
- **knowledge**: guard recycle-bin tombstone lifecycle (7bd7bb3)

### 🔧 其他

- **clipper**: bump extension version to 0.3.0 (209be0b)
- **ci**: remove v1.4.7 delete patch workflow (88a11c3)
- **ci**: remove v1.4.7 temporary patch workflow (14ebf35)

### 📌 杂项

- 提交当前版本全部代码改动 (2f4ace5)
- 修复 AI 写作助手泄露内部块 ID (c0cd345)
- 修复：手动排序仅调整同级节点顺序 (30a1dc0)
- 功能：支持批量导入 Markdown 文件 (1592123)
- 修复：三栏布局展示根目录文档 (9652761)
- 修复：持久化笔记树展开收起状态 (14bd1d9)
- 调整：移除未同步修改的全局提示 (2d654e9)
- 修复：全文搜索支持正文和中文关键词 (70cb16e)
- 修复：恢复重新打开笔记后的附件图片 (c59ccc0)
- 修复：允许取消浏览器插件 AI 优化选项 (71bd25f)
- 修复：支持中文中括号唤起双链 (985fee0)

## v1.4.7 - 2026-08-10

### 🐛 修复

- **permissions**: preserve recycle-bin lifecycle access (abde307)
- **permissions**: expose tombstone access resolver (21a0b1e)
- **permissions**: resolve recycle-bin tombstones safely (951ec41)
- **ios**: align Xcode deployment target with Capacitor 8 (ec61f08)
- **ios**: raise minimum deployment target to iOS 15 (7362c87)

### 📝 文档

- update English README for v1.4.6 (fed251d)
- update README for v1.4.6 (acbed9e)

### ✅ 测试

- **permissions**: cover recycle-bin tombstone lifecycle (5119ddc)

## v1.4.6 - 2026-08-07

### ✨ 新增

- **editor**: move outline toggle to outer toolbar (51f4c04)
- **ui**: 三栏布局展示子文件夹与层级范围 (#676) (91717e5)
- **ui**: delay and stabilize the branded startup splash (2089cc8)
- **ui**: unify workspace loading visuals (890010a)
- **ui**: coordinate a single startup loading experience (936042b)
- **dev**: force release configured ports before startup (39b1e0b)
- **dev**: add cross-platform port conflict cleanup (4560b23)
- 使用原生调度并确认提醒交付 (a501fa1)
- 接入 Capacitor 原生任务通知 (fc3a79e)
- 添加任务原生通知调度模型 (ddb95d9)
- **files**: show protected retention state in details (8431f1a)
- **files**: label manual uploads as protected (e5cd9cd)
- **updater**: add macOS manual download policy (fb13849)
- **android**: mount shared mobile image viewer (42a0e2f)
- **android**: add unified gesture image viewer (bcc4309)
- **android**: add in-app markdown image preview (1190b51)
- add PostgreSQL knowledge denial migration (7ed193b)
- persist explicit restricted mode in PostgreSQL (3c036ad)
- add explicit access modes and deny interaction (c92850f)
- expose access mode and deny role in knowledge API (d1cc943)
- wrap knowledge permission policies (d33c4f1)
- expose manual access modes and deny rules (e942f3f)
- apply nearest explicit deny in knowledge access resolution (1940bd3)
- add explicit knowledge access denials (09058fd)
- support explicit knowledge access modes (210925e)

### 🐛 修复

- **release**: run Capacitor 8 with Node 22 baseline (7a6db50)
- **release**: use portable Linux native baseline (7814277)
- **i18n**: pass formatted large document values safely (dd7d2c9)
- **i18n**: avoid reserved count interpolation for display values (5ec1096)
- **i18n**: merge editor split translations (4bd6919)
- **i18n**: add editor split translations (42c88fe)
- **i18n**: localize diary Markdown toolbar behavior (158542b)
- **i18n**: add diary Markdown toolbar translations (3dc4cf4)
- **i18n**: merge security settings translations (8129b57)
- **i18n**: add missing security settings translations (c9c0cf9)
- **i18n**: merge workspace layout translations (0f4208c)
- **i18n**: add workspace layout translations (3f83076)
- **i18n**: complete large Markdown mode translations (5b78254)
- **i18n**: localize large rich text safe viewer (23a9ecb)
- **i18n**: merge large document translations (d991aa8)
- **i18n**: add large document safe mode translations (c9fc771)
- **i18n**: merge token usage translations (90e9605)
- **i18n**: add token usage translations (f57010d)
- **i18n**: localize Mi Cloud background import status (bc799e5)
- **i18n**: merge Mi Cloud progress translations (fb57ff0)
- **i18n**: add Mi Cloud background import translations (2d6972e)
- **i18n**: localize Youdao import flow (39f14ec)
- **i18n**: merge continued release translations (9fe5885)
- **i18n**: add download and LAN translations (781ab67)
- **i18n**: add Youdao import translations (764980c)
- **i18n**: scope legacy settings observer and dynamic copy (012b7f5)
- **i18n**: format server dates with app locale (a411e0f)
- **i18n**: keep legacy bridge compatible with older WebView (e115229)
- **i18n**: install scoped settings compatibility bridge (4d02c09)
- **i18n**: bridge legacy settings hardcoded copy (e2c5c11)
- **i18n**: localize attachment detail drawer (86b9736)
- **i18n**: localize workspace member management (55e6a0e)
- **i18n**: localize editor error fallback (983ad3c)
- **i18n**: merge additional release translations (5ed7837)
- **i18n**: add release localization resources (2b076f3)
- **export**: recover Markdown image export failures (#693) (48a57bd)
- **editor**: install safe format-transition Yjs reset (16c571c)
- **editor**: preserve Yjs causal tombstones across format conversion (962cae5)
- **mcp**: expose granted workspace notebooks to restricted tokens (2792d8b)
- **mermaid**: add borderless inline preview styles (f5b90a1)
- **mermaid**: render rich-text previews without code card chrome (6a571df)
- **ui**: optimize daily records mobile layout (b372a0a)
- **editor**: persist tab indentation after refresh and sharing (78b8fc8)
- **attachments**: reuse remote source buffer on thumbnail fallback (357d9be)
- **ci**: include Vite import meta types in task planning check (5a9f9cd)
- **task-offline**: fail fast on missing API contract instead of silent no-op (7d9a8b7)
- **android**: handle UGREEN remote gateway redirects (#688) (8a17577)
- **release**: unblock v1.4.6 by syncing version and hardening offline API init (51c3afd)
- **sync**: 修复单端误冲突、重复副本与保存状态异常 (#684) (6aea903)
- **editor**: 文件管理中的视频直接插入播放器 (#679) (3f56c64)
- **editor**: 文件管理中的图片直接插入正文 (#677) (7e03355)
- **mcp**: 增加稳定启动器与运行时诊断 (#674) (1cbdcde)
- PC 客户端渲染进程退出后自动恢复 (#672) (8b9b787)
- 仅在三栏布局启用目录选择行为 (#671) (2b2060b)
- 三栏式目录点击与展开行为分离 (e316b4f)
- **ui**: dismiss startup splash on legacy observer fallback (123b90a)
- **ui**: keep startup readiness observable while root is concealed (e3b3b0c)
- **ui**: prevent auth loader leakage before splash reveal (42fbf90)
- **ui**: keep startup dismissal stable in StrictMode (f835f7f)
- **ui**: keep one startup loader until the app is ready (7f424b8)
- 永久清理 Markdown 内部块 ID 泄漏 (3fd2b04)
- **diary**: preserve links in journal content preview (beddcac)
- **diary**: use named Markdown preview export (384000e)
- **diary**: render journal links in read-only preview (8bba7f4)
- **docker**: use runtime port in compose healthcheck (43537ac)
- **docker**: make healthcheck follow runtime port (9e640d1)
- **dev**: avoid treating fuser errors as process ids (32b1d23)
- **dev**: sync newly added dependencies before Vite starts (a25fd78)
- **dev**: auto-install missing workspace dependencies (9678e5b)
- **export**: refresh image access and render markdown footnotes (fe10513)
- **export**: prepare footnotes and attachment access for images (c835af0)
- **linux**: block incompatible desktop native binaries (64c532e)
- **linux**: route release rebuilds through portable baseline (a3252e0)
- **linux**: surface native backend load failures (caacfc0)
- **linux**: avoid portable rebuild recursion (77747be)
- **linux**: route CI native rebuilds through portable baseline (e8f0fea)
- **linux**: add portable native rebuild helper (5efba6d)
- **linux**: register native portability checks (3778b2d)
- **linux**: add native compatibility check CLI (a42c4f6)
- **linux**: add native module compatibility inspector (1da6102)
- 通知已显示后持续重试 ACK (93dc62d)
- 检查 Android 精确提醒设置 (e13ac6e)
- 避免服务切换时重复取消提醒 (f8dac70)
- 通过登出事件清理原生提醒 (12be98a)
- 登出和切换服务时清理原生提醒 (17822ec)
- 避免未调度原生提醒被误确认 (a15c2a9)
- 仅确认真正交给系统的原生提醒 (318e4d1)
- 记录原生提醒的实际调度凭证 (e7e5d8b)
- **editor**: keep legacy rich-text outline positions accurate (d3cf045)
- 接入安卓原生任务提醒并保障交付 (716deba)
- **static**: harden precompressed runtime typing (9cd777d)
- **files**: mark protected workspace uploads in detail (ff9f04e)
- **files**: distinguish protected manual uploads from orphans (b39e696)
- **files**: protect manual uploads from orphan cleanup (aff82f4)
- 完成团队空间权限链路收口 (d893aae)
- 先鉴权再处理团队导出请求 (05fa680)
- **files**: install immediate orphan visibility middleware (b98720b)
- **files**: report removed attachments as orphans immediately (902f329)
- **updater**: require browser download on Windows and macOS (cf0ddbc)
- **ui**: deduplicate burst error toasts (9083ccf)
- **android**: install root document create compatibility (626392a)
- **macos**: open browser instead of installing updates (3dfd4ad)
- **android**: route hidden root creates through knowledge tree (014be7a)
- **android**: add root document create policy (97b6bd1)
- **android**: suppress residual taps after pinch zoom (12bb885)
- **android**: route editor images through gesture viewer (39bde38)
- **client**: restore code block copy fallback (7d90a10)
- **mcp**: sync markdown updates into active Yjs rooms (61a14ad)
- **search**: filter restricted candidates before result limits (92fe146)
- **files**: paginate after knowledge access filtering (d492582)
- **openapi**: correct task priority description (#654) (102d0ee)
- **share**: normalize all shared comment timestamps (#655) (0b119ba)
- prevent ineffective owner denial rules (42b6e32)
- prevent realtime metadata leaks after access revocation (7e61921)
- report inherited policy state accurately (061269c)
- resolve allow and deny transitions atomically (8f7604d)
- keep deny rules from restricting unrelated members (0d7daa5)
- require verified identity or signature for attachment downloads (ab37f4a)
- wrap remaining workspace data routes with knowledge ACL (14a8509)
- enforce restricted access in export and tags (2529dc9)
- filter file manager by effective note access (f210469)
- enforce restricted knowledge access in offline sync (5771f24)
- **permissions**: conceal filtered search candidate counts (a081544)
- **permissions**: conceal restricted resource existence (a0f115b)
- **permissions**: wrap full-text search with knowledge visibility (50a1223)
- **permissions**: filter restricted notes from search results (83cd940)
- **permissions**: clarify restricted member allowlist in dialog (c2f0bee)
- **permissions**: filter legacy knowledge collection responses (61046a9)
- **permissions**: bridge legacy resource guards to knowledge ACL (8a707d2)
- **postgres**: add restricted knowledge access policy schema (9144afb)
- **permissions**: backfill restricted policies for existing ACLs (0c94cab)
- **permissions**: hide restricted tree metadata (647c75c)
- **permissions**: expose restricted access mode to UI (0fdc5ff)
- **permissions**: make node member lists restrictive (494f541)
- **permissions**: enforce restricted tree visibility (dc87851)
- **permissions**: add restricted knowledge access policy (a58fb50)
- **journal**: compact daily record paragraph spacing (fc42411)
- **import**: preserve imported Markdown content and format choice (#639) (12c2c2d)

### ⚡ 优化

- **attachments**: quantize signed URL exp to reduce cache-busting churn (cb0fe5e)
- **attachments**: make ETag variant-aware and short-circuit 304 before file read (2d154da)
- **attachments**: allow conditional reuse instead of forbidding all caching (b5de4bc)
- **notes**: cache healthy block authority verdicts per connection (f066161)
- **notes**: run block authority schema DDL once per connection (fa425f2)
- **notes**: skip revalidation for documents already marked mismatch (3beddce)
- **notes**: remove O(n^2) full-document reparsing from block authority (3e88879)
- **frontend**: optimize initial loading and static delivery (7f2ea9c)
- **frontend**: defer command palette search (f31e726)
- **frontend**: lazy load command palette (7bd0f98)
- **frontend**: remove AI helpers from entry chunk (89c37b1)
- **frontend**: defer AI auxiliary bridges (e0b7d4c)
- **frontend**: remove editor bridges from entry chunk (a79e32d)
- **frontend**: defer editor and mind-map bridges (80dd4e3)
- **frontend**: defer authenticated feature centers (51fb92a)
- **frontend**: mount feature centers after authentication (a84428a)
- **frontend**: group low-frequency global centers (82d7d41)
- **frontend**: defer AI and shared viewer (702607c)
- **frontend**: lazy load shared note viewer (d56785c)
- **frontend**: lazy load AI chat panel (dfc5bc2)
- **docker**: build precompressed web assets (6ea7ce5)
- **build**: add web-optimized frontend build (cd1ea0d)
- **build**: separate web precompression build (ee2eb70)
- **build**: emit bundle manifest (d1d042d)
- **build**: wire precompression and bundle budgets (3c2995c)
- **build**: add frontend bundle budget report (d510566)
- **static**: install precompressed asset runtime (602d577)
- **static**: serve precompressed frontend assets (3831899)
- **static**: negotiate precompressed assets (789730d)
- **build**: precompress frontend assets (9fa4849)
- **frontend**: defer core workspace panels (749e039)
- **frontend**: lazy load navigation rail (1974da5)
- **frontend**: lazy load note list (54a49b3)
- **frontend**: lazy load sidebar tree (feceed6)
- **frontend**: defer editor workspace runtime (4b54c3f)
- **frontend**: split lazy workspace chunks (c811036)
- **frontend**: lazy load split editor (19bfc4b)
- **frontend**: lazy load notebook share join (dcd69da)
- **frontend**: lazy load share management (1873739)
- **frontend**: lazy load file manager (54af30d)
- **frontend**: lazy load diary center (215e6bd)
- **frontend**: lazy load mind map center (6f0e8fd)
- **frontend**: lazy load task center (ac2d165)
- **frontend**: add lazy workspace fallback (cae8039)
- **static**: compress and cache frontend assets (9cf923c)
- **static**: add cache validators for frontend assets (6c288b2)
- **android**: keep image preview bridge off gesture mutations (4fa9254)
- **permissions**: initialize access policy table once (9db8836)

### ♻️ 重构

- **i18n**: compose release translation patches (0429816)
- **i18n**: remove redundant token usage override (c13b6f5)
- **i18n**: keep token usage on base locale source (ee36aef)
- **ui**: reduce note loading flashes (5571ba5)
- **android**: remove superseded markdown image prototype (f9598a8)

### 📝 文档

- **dev**: document one-command forced port restart (60ae160)
- **readme**: sync NAS remote login support in English (69b2771)
- **readme**: fix updater command formatting (f62cbb3)
- **readme**: add UGOS and fnOS remote login support (8ea95c9)
- **readme**: 更新 v1.4.5 功能与升级说明 (8c7d55a)

### ✅ 测试

- **i18n**: cover editor split translations (719d26f)
- **i18n**: cover diary Markdown localized placeholders (6463073)
- **i18n**: cover diary Markdown translations (f6543d2)
- **i18n**: cover security settings addons (c7c3e56)
- **i18n**: cover workspace layout translations (5c32811)
- **i18n**: keep release coverage on actual patch namespaces (8ea4d4a)
- **i18n**: cover large document safe mode translations (635e182)
- **i18n**: cover token usage translations (c5b6c32)
- **i18n**: cover Mi Cloud progress translations (dbc4c61)
- **i18n**: cover download LAN and Youdao translations (73a4825)
- **i18n**: isolate release coverage from legacy locale debt (7f3c69f)
- **i18n**: guard release translation parity (ee90bd8)
- **export**: make issue 693 Blob assertions portable (928bb50)
- **editor**: reproduce format round-trip document duplication (5be6311)
- **mcp**: cover workspace note read and write grants (01c4318)
- **mcp**: cover restricted workspace notebook discovery (cc5b54b)
- **mermaid**: cover borderless rich-text preview scoping (74fdc98)
- **attachments**: expect concealed denial for spoofed identity (eeb38fc)
- **attachments**: lock cache revalidation and gateway fallback contracts (2dc2242)
- **store**: lock in the memoisation AppContext render cost depends on (fd10eab)
- **editor**: cover outline toolbar entry (43477d4)
- **ui**: bind loading styles to their component contracts (7b94d25)
- **ui**: verify non-inheriting root concealment (0043dac)
- **ui**: ensure transient auth loading stays hidden (1ada701)
- **ui**: guard the unified loading hierarchy (709ecb2)
- **diary**: use workspace-relative source path (a4c4627)
- **diary**: cover clickable journal links (f961764)
- **docker**: verify healthcheck follows runtime port (5cf573b)
- **dev**: cover automatic dependency synchronization (5d502da)
- **dev**: verify occupied ports are force released (21347a6)
- **export**: avoid jsdom origin coupling (958c559)
- **export**: verify footnotes and NAS attachment signing (51065bf)
- **export**: cover image footnotes and async preparation (e4338e0)
- **linux**: cover native compatibility policy (5546653)
- **linux**: add packaged sqlite native smoke test (c41a4a5)
- **editor**: cover real legacy outline drift pattern (0b9a201)
- 覆盖原生提醒调度凭证 (ad94b4e)
- **editor**: correct legacy outline position expectation (1847973)
- **editor**: cover legacy outline position drift (f1c8536)
- 覆盖原生任务通知调度计算 (340c990)
- **frontend**: cover command palette lazy load (b61f231)
- **frontend**: protect deferred editor bridges (4dd4f4d)
- **frontend**: protect deferred global centers (af13a10)
- **frontend**: cover AI and share lazy boundaries (4c4fc74)
- **static**: prevent double compression regression (25e492b)
- **static**: verify Brotli asset serving (78274d3)
- **static**: cover precompressed negotiation (14aae47)
- **files**: cover protected manual upload visibility (9f9f294)
- **files**: keep manual uploads during orphan cleanup (8cbbe5c)
- 同步 PostgreSQL 继承与受限权限枚举 (52f95ed)
- **files**: verify orphan list and source note responses (5d64963)
- **files**: cover immediate orphan visibility after image removal (ea4715e)
- 稳定清理旧搜索模拟断言 (e3efac5)
- 使用真实搜索权限回归替代旧后置模拟 (086730e)
- **frontend**: cover core workspace lazy chunks (ccc26a2)
- **static**: verify JavaScript gzip response (64c09b1)
- **frontend**: cover startup chunk boundaries (f300b27)
- **updater**: cover Windows browser download policy (403fff0)
- **static**: cover frontend asset caching (3ee73f2)
- **ui**: cover burst toast deduplication (215a853)
- **android**: cover root document create compatibility (89d4378)
- **updater**: run macOS manual download policy checks (731d56b)
- **updater**: cover macOS manual download policy (ee9fb51)
- **android**: align image bridge source contract (bafff04)
- **android**: cover mobile image viewer contract (3eb05fb)
- **client**: assert failed copies stay unsuccessful (a633174)
- **client**: cover code block clipboard fallback (d344013)
- **mcp**: run note format regressions (437975e)
- **mcp**: cover active Yjs room synchronization (33f3df9)
- **knowledge**: make query-limit regression ordering deterministic (23fb88e)
- **knowledge**: cover ACL filtering before query limits (a65b9dc)
- cover explicit private mode and deny precedence (0b792b1)
- verify PostgreSQL explicit mode and denial parity (fb706d2)
- cover sync files export tags and attachment ACL (b835647)
- **permissions**: verify hidden resources do not leak existence (ebc870e)
- **permissions**: verify full-text search hides restricted notes (5dc1d88)
- **permissions**: verify legacy collection endpoints hide restricted rows (3e9a177)
- **permissions**: cover legacy note and notebook guards (1378fea)
- **postgres**: verify restricted access policy parity (cd9187d)
- **permissions**: cover restricted workspace subtree access (bb6b162)

### 🤖 CI

- **i18n**: cover editor split surface (effc895)
- **i18n**: cover diary Markdown behavior (2642f84)
- **i18n**: cover security settings surface (7cbfe7b)
- **i18n**: cover workspace layout surface (43d6040)
- **i18n**: cover large Markdown editor (b5ad7ee)
- **i18n**: cover large document safe viewer (1b710d2)
- **i18n**: cover token usage surface (86219b0)
- **i18n**: cover Mi Cloud import surface (d36f8ad)
- **i18n**: cover import and download surfaces (90bd1d5)
- **i18n**: cover app-locale date formatting (11062e2)
- **i18n**: guard release localization fixes (2fd2f7e)
- **issue-694**: guard RT Markdown round-trip duplication (7c1161b)
- **editor**: cover tab indent persistence and sharing (6d012df)
- **attachments**: cover media range contracts (e989560)
- **attachments**: run cache revalidation contracts (3928581)
- simplify Android release version assertion (243438d)
- fix release version consistency assertion (5866f61)
- complete v1.4.6 review fix verification (50b4a6c)
- apply v1.4.6 review fixes (5b0545e)
- apply editor outline toolbar entry (0a220cd)
- rerun diary link preview validation (3eebef8)
- simplify diary preview patch workflow (69dad82)
- apply diary link preview fix (9bc44e0)
- **dev**: verify dependency auto-sync startup (1085476)
- apply Linux desktop native portability fix (046f915)
- **linux**: enforce portable Electron native modules (b2e752d)
- resolve main sync conflicts for release v1.4.6 (4765e79)
- 添加任务原生提醒回归验证 (639b4c2)
- **perf**: cover entry deferral changes (3d207a8)
- **perf**: validate web-optimized build (8770d14)
- **perf**: ignore tiny uncompressed chunks (2faceaf)
- **perf**: validate frontend loading budgets (8ee229a)
- **android**: validate root document create compatibility (de0405b)
- **knowledge**: validate ACL-aware query limits (c58fcad)

### 🔧 其他

- remove temporary indent fix workflow (96be17e)
- fix indent persistence workflow syntax (61ef14b)
- apply indent persistence fix (457754a)
- remove temporary issue 690 workflow (a1b6ad1)
- isolate issue 690 source patch (d337c35)
- make issue 690 patch resilient (335ac6c)
- apply issue 690 attachment buffer fix (327b62a)
- complete staged export center import fix (d6a45a9)
- repair staged release fix script (294849e)
- stage v1.4.6 review fixes (8062b12)
- add temporary outline entry patch helper (2485deb)
- **test**: add unified loading UX regression command (98260e4)
- add temporary diary preview patch helper (e47c08c)
- **test**: add Docker runtime healthcheck regression command (7968004)
- **dev**: expose port cleanup regression test (ffa1d6e)
- **ci**: remove temporary Linux patch workflow (76aa335)
- 调整 Capacitor 构建同步顺序 (8e530c2)
- 使用 Node 22 验证 Capacitor 8 (f4135d8)
- 补齐移动端 Capacitor CLI (16a33ac)
- 修正提醒日期模板转义 (38b3a44)
- 将 Issue 635 验证切换为 PR 流程 (eed1e69)
- 重新触发 Issue 635 修复验证 (1003834)
- 修正 Issue 635 补丁脚本转义 (dc91830)
- 触发 Issue 635 修复验证 (f36f22c)
- 配置 Issue 635 修复验证流程 (24c82e9)
- 添加 Issue 635 自动修复脚本 (6344cdf)
- 清理 PR 645 临时触发文件 (cf78864)
- 清理 PR 645 临时工作流 (e9df4b0)
- 清理 PR 645 临时修复执行器 (326d80f)
- 恢复权限回归标准流水线 (7716643)
- 仅提交已验证的权限源码修复 (705c9d8)
- 收紧搜索权限守卫挂载语义 (431a4ec)
- 修正 PostgreSQL 权限迁移路径 (fd3a635)
- 修正 PR 645 自动修复脚本提取 (6543844)
- 通过 PR 流水线执行权限修复 (44b296a)
- 触发 PR 645 修复执行器 (534a240)
- 注册 PR 645 修复执行器 (7b975c5)
- 执行 PR 645 权限收口修复 (834d1ae)
- **updater**: keep unrelated package scripts unchanged (93d053b)
- remove accidental branch probe (61cd457)
- branch probe (265d598)
- remove accidental placeholder (002a61a)
- placeholder (f0d1811)

## v1.4.5 - 2026-08-03

### ✨ 新增

- **journals**: add workspace journal scope UI (11f75b9)
- **journals**: add personal and workspace journal scope selection (0732aa9)
- **journals**: route markdown date links by active scope (9dade97)
- **journals**: route rich-text date links by active scope (8ba5fbd)
- **journals**: add shared journal scope resolver (d932253)
- **journals**: expose workspace shared journal API (62d3603)
- **journals**: implement workspace shared journal domain service (6e4af49)
- **journals**: add workspace journal binding migration (071456a)
- **journals**: expose safe cleanup and rollback (1207ce5)
- **journals**: add natural weekday date commands (3fb9882)
- **journals**: add safe legacy archive cleanup service (abde485)
- **markdown**: register daily record slash commands (67b1a3a)
- **markdown**: add daily record slash commands (725f9b1)
- **daily-records**: share date command definitions (5b669d3)
- **journals**: expose archive migration in daily records (5059185)
- **journals**: create and repair entity archive paths (66b3492)
- **journals**: add idempotent archive tree service (4ab75f8)
- **daily-records**: use native date input for slash picker (6319040)
- **daily-records**: clarify workspace journal scope (7c0f5fc)
- **daily-records**: register slash commands and navigation label (817ceb8)
- **daily-records**: register date slash commands (fbf9984)
- **daily-records**: add slash date and journal commands (70e6585)
- **daily-records**: route diary center through unified hub (02c3094)
- **daily-records**: add unified moments calendar journal hub (b943588)
- **daily-records**: add aggregated daily journal view (ac4d1ce)
- **daily-records**: add date and journal helpers (8aa3371)
- **dev**: expose one-command startup (524b2ac)
- **dev**: route Vite proxy to selected backend port (c2ae7d0)
- **dev**: add unified development launcher (5a2911d)
- **知识树**: 支持取消文件夹密码 (ee19acb)
- **tasks**: add personal Inbox and global quick capture (ac49f5a)
- **tasks**: keep recurring estimate inheritance in PostgreSQL pilot (ebad2db)
- **tasks**: inherit estimates for recurring task instances (d70d1c2)
- **tasks**: mount daily time planner (e8354f3)
- **tasks**: add daily time planning workspace (6db50a9)
- **tasks**: add time planning helpers (9c16d1d)
- **tasks**: add time planning frontend API (f8ff0be)
- **tasks**: add PostgreSQL time planning schema (b692e4f)
- **tasks**: mount task time planning routes (fe4fb9d)
- **tasks**: register time planning before database startup (689f672)
- **tasks**: add personal time block API (7efbd29)
- **tasks**: register time planning migration (ad7dc5b)
- **tasks**: add v72 time planning migration (7894d98)
- **tasks**: combine My Day with smart task views (f3df038)
- **tasks**: add task labels and saved views workspace (5af549c)
- **tasks**: add saved view filter logic (909ad56)
- **tasks**: add task metadata frontend API (2522630)
- **tasks**: add task metadata postgres schema (b1cb28e)
- **tasks**: mount task metadata routes (77285a4)
- **tasks**: bootstrap task metadata migration (4a9d3ed)
- **tasks**: add task labels and saved views API (ac58973)
- **tasks**: register task metadata migration (d0c602e)
- **tasks**: add task metadata schema migration (f67542a)
- **tasks**: add PostgreSQL My Day schema (fb6eaf1)
- **tasks**: register My Day schema migration (869e537)
- **tasks**: add formal My Day schema migration (fc15d48)
- **tasks**: integrate My Day into task center (42c6e12)
- **tasks**: add My Day planning panel (97c8d8a)
- **tasks**: add My Day planning helpers (0a819c3)
- **tasks**: add My Day client API (40f6022)
- **tasks**: mount My Day plan routes (1ceffcc)
- **tasks**: add synced My Day plan API (8d837d1)
- **ui**: add fixed all-notes entry to knowledge tree (ef78439)
- **diary**: 完成 Issue #241 的 Markdown、AI 总结与输入法修复 (#589) (4fea4be)
- **tasks**: install offline task and habit API adapter (ff97e60)
- **tasks**: add offline cache and mutation replay (8cd0454)
- **ui**: enable three-column mode on Web (3c119b7)
- **ui**: add desktop three-column note mode (8264f51)
- **onboarding**: mount welcome bridge at app layout (08240d3)
- **onboarding**: open seeded welcome after initial sync (b6584d0)
- **onboarding**: mount first-login welcome bridge (6b8cd93)
- **onboarding**: open the Chinese welcome note once (390ee8d)
- **onboarding**: register bilingual onboarding migration (6cc5fa6)
- **onboarding**: seed bilingual guides for new users (ad378de)
- **sync**: complete offline workspace synchronization (#580) (ba58429)
- **ai-chat**: add stop, message actions and footnote references (f925e1e)
- **ai-chat**: collapse and resize reliable context (2cf87b7)
- **ai-chat**: allow visible scrollbars (6500dd5)
- **ai-chat**: add abortable AI stream bridge (9a97a54)
- **siyuan**: localize remote Markdown images after import (16a7bfb)
- **comments**: add inline text annotations with permission-aware threads (#570) (52b810f)
- **security**: auto-lock password folders (fe18229)
- **import**: add target format options (1314db7)
- **micloud**: show background progress, cancel and retry controls (ce839d2)
- **micloud**: use one background job and SSE progress stream (67687d7)
- **micloud**: mount background import job routes (144f093)
- **micloud**: add persistent background import jobs with SSE (670c19c)

### 🐛 修复

- **calendar**: preserve ICS time semantics and add safe all-day tasks (3c17ee2)
- **journals**: normalize workspace journal success copy (deeed32)
- **journals**: normalize scoped journal success copy (88fe134)
- **journals**: allow read-only members to open shared journals (218d497)
- **journals**: escape cleanup UI integration template (5465f0c)
- **migrations**: tolerate legacy session foreign key errors (b979fb9)
- **markdown**: use public editor lifecycle signal (a1679a6)
- **journals**: repair archive before opening daily entries (11a80cd)
- **journals**: refresh archive state across creation entrypoints (279d364)
- **daily-records**: query personal journal tree explicitly (a09306b)
- **daily-records**: preserve personal journal scope (5016f05)
- **daily-records**: navigate calendar by real months (7324728)
- **daily-records**: use lucide icon component type (f16e67f)
- **数据库**: 兼容任务迁移版本冲突 (143b3e3)
- **sync**: prevent false success and recover unacknowledged edits (#612) (d9fb5d0)
- **markdown**: filter internal block IDs from clipboard (0f86d9d)
- **editor**: sync current markdown snapshot manually (08fccc2)
- **editor**: keep markdown saves active before CRDT sync (6bbb8b9)
- **tasks**: correct start times in calendar feeds (15c65ed)
- **tasks**: revalidate task visibility before editing a time block (5b786d3)
- **tasks**: seed My Day route test user (242b403)
- **tasks**: handle task mutation response in My Day (a602bfe)
- **tasks**: reset My Day across midnight (9ed17f3)
- **tasks**: stabilize task center remount callback (685eed7)
- **tasks**: stabilize My Day labels and effects (b584074)
- **db**: apply missing historical migrations (a19a8a5)
- **db**: add block schema repair migration (9a1d4ea)
- **layout**: make workspace controller the single note-list owner (8e0843a)
- **layout**: stop mobile bridge from overriding wide note layouts (cf60664)
- **layout**: preserve explicit workspace mode during legacy migration (28106df)
- **onboarding**: avoid first-login open race (5bae18e)
- **onboarding**: register first-login gate migration (fe043c3)
- **onboarding**: gate guide seeding on first login (cfaf533)
- **client**: support IPv6 NAS server addresses (819d5a8)
- normalize timezone handling and mindmap geometry (6ed4dd1)
- **ci**: apply mindmap React type compatibility (b0213df)
- **ci**: remove invalid XHTML div attribute (042c138)
- **siyuan**: localize remote images for Markdown imports (2e5b47c)
- **tree**: sync saved note titles to knowledge tree (9755279)
- **comments**: place inline annotation action inside selection tooltip (4ca1c51)
- **security**: clear stale unlock tokens on account change (0ca0aee)
- push feature files without workflow changes (73fd75d)
- keep runner workflow YAML valid (bfbbc11)
- provide readable Obsidian test file fixture (45fc79f)
- mock Obsidian API through relative module (c3a28b1)
- preserve staged multiline replacement contents (12c3b2e)
- relax staged replacement uniqueness check (e4ac2a4)
- apply sequential import format replacements (bb4dbe3)
- preserve embedded replacement string indentation (ba122cf)
- execute staged workflow run block through YAML (0d415eb)
- extract staged import script indentation (fd2635a)
- **micloud**: stop deduplicating returned note rows (a2b24c4)
- **micloud**: preserve every returned note row (79c88b0)
- **micloud**: avoid stale notebook scope causing per-note 500 (1ebf2a7)
- **micloud**: use supported hierarchy reason (4f433cb)
- **micloud**: mount hardened import route (8e15db4)
- **micloud**: isolate backend imports per note (9e9054f)
- **micloud**: prevent large Xiaomi note imports from being aborted (#553) (af2b102)
- **release**: keep README changelog section compact (b60881b)

### ⚡ 优化

- **tasks**: lazy-load the time planner when expanded (435abd4)
- **editor**: defer images from eight media nodes (cef67d6)
- **editor**: cache runtime complexity decisions (c694025)
- **editor**: move split scan off note switch critical path (e2ac02e)
- **editor**: defer and cache note split analysis (0076141)

### ♻️ 重构

- **daily-records**: reuse shared slash definitions (287cbdb)
- **tasks**: normalize planner time input and payload (ecf00da)
- **tasks**: share My Day schema initializer (c9e73ad)
- **tasks**: keep a stable offline API facade (860692c)
- **tasks**: make offline replay deterministic (fd86610)
- **onboarding**: remove unused sync helper (f65b3c3)
- **onboarding**: keep sidebar bridge unchanged (6349d97)
- **micloud**: expose reusable row import pipeline (9984134)

### 📝 文档

- **mcp**: restore installation entry and complete setup guides (#563) (45d92e6)
- **readme**: align English v1.4.4 overview (9d34537)
- **readme**: sync v1.4.4 capabilities (21f3499)

### ✅ 测试

- **journals**: lock workspace shared journal UI contract (7b5aeaa)
- **journals**: verify markdown links target active workspace (c399bb1)
- **journals**: verify personal and workspace scope resolution (202c691)
- **journals**: verify workspace journal route lifecycle (771e2cc)
- **journals**: verify workspace shared journal permissions and scope (4c86a25)
- **journals**: use canonical ordinary note type (741c176)
- **journals**: lock cleanup preview and rollback UI contract (1eb71f5)
- **journals**: verify cleanup route lifecycle (d8ef737)
- **journals**: expect expanded markdown date commands (ebf1aac)
- **journals**: expect expanded rich-text date commands (43e093e)
- **journals**: cover natural weekday commands (a7bd702)
- **journals**: verify safe cleanup preview and rollback (3845ccf)
- **migrations**: cover v1.2.4 orphan session upgrade (d1aa621)
- **daily-records**: lock shared date command semantics (4acafd5)
- **markdown**: cover daily record slash commands (3b9bf8a)
- **journals**: verify archive route lifecycle (95d7efe)
- **journals**: cover archive tree migration and idempotency (6e610f7)
- **daily-records**: cover real month navigation (72d9027)
- **daily-records**: cover slash command registration (fd3620c)
- **daily-records**: align preview truncation boundary (4ce0d77)
- **daily-records**: cover date boundaries and journal previews (4dc1143)
- **tasks**: verify workspace schedule isolation (7298045)
- **tasks**: verify recurring estimate inheritance (2ba8288)
- **tasks**: add targeted time planning typecheck (195bc0d)
- **tasks**: cover time planning helpers (bdf3246)
- **tasks**: cover estimates and time block lifecycle (b5c6dcb)
- **tasks**: initialize task metadata schema before cleanup (169a534)
- **tasks**: cover saved view filtering (8b72aaf)
- **tasks**: cover task metadata routes (a66db87)
- **db**: make block repair assertions migration-version agnostic (8ef919a)
- **tasks**: verify My Day route mounting and persistence (e8250d7)
- **tasks**: cover My Day plan validation (7d893c9)
- **tasks**: cover My Day planning helpers (9b5a4c5)
- **db**: type historical migration fixture (c49aa5e)
- **db**: cover skipped block migration repair (4e1d1f2)
- **ui**: cover fixed all-notes navigation entry (12453b2)
- **tasks**: type native delete mocks accurately (016b3aa)
- **tasks**: model the remapped server task accurately (66eebdb)
- **tasks**: cover pending overlays and remapped deletes (b49359a)
- **tasks**: preserve API method signatures in mocks (163d054)
- **tasks**: keep native API mocks separate from wrappers (07d4314)
- **tasks**: cover offline cache and replay behavior (2ab4dfe)
- **layout**: preserve explicit three-column startup state (6bb0eed)
- **layout**: ensure mobile bridge does not override wide workspace mode (1a4ac45)
- **layout**: cover functional list ownership and Web switching (8a7e396)
- **onboarding**: verify first-login seeding gate (84f215a)
- **onboarding**: cover first-login welcome opening (0b03d17)
- **onboarding**: cover bilingual new-user guide seeding (0e0ca4e)
- **editor**: expect deferred split capability analysis (93da6f4)
- **editor**: cover deferred split analysis (906cd66)
- **editor**: cover runtime decision reuse (2c59ae7)
- **editor**: cover image-dense runtime threshold (7f063c3)
- **ai-chat**: cover abortable ask fetch scoping (74bb284)
- **siyuan**: cover Markdown image-bed localization (c56546f)
- **frontend**: align tree title listener mock typing (3e0c526)
- **knowledge-tree**: follow compact density and folder interaction updates (b543b35)
- **knowledge-tree**: align sidebar contracts with current recovery and mobile density UI (49e74a0)
- **knowledge-tree**: track latest schema migration version (b6250a4)
- **micloud**: cover persistent jobs, retry and SSE (483baf8)
- **micloud**: cover one-job SSE import flow (6282fc1)
- **micloud**: require one created note per returned row (65ab647)
- **micloud**: cover duplicate row preservation (17244f6)
- **micloud**: cover backend 500 isolation and idempotency (39edb3d)

### 🤖 CI

- **calendar**: add ICS and all-day regression coverage (ff5d8fd)
- **calendar**: validate selective PR 631 integration (aa29cff)
- **journals**: validate workspace shared journals (34db5b9)
- **journals**: validate cleanup and natural date commands (0cadedf)
- run markdown integration patch on pull requests (3d40e5a)
- **markdown**: verify daily record commands (1e2f5b8)
- fix markdown daily command verification paths (ddd71f0)
- apply markdown daily command integration (fa2863e)
- **journals**: run archive route lifecycle tests (f6a3901)
- **journals**: harden archive merge-ref validation (606359f)
- **journals**: validate real archive entity migration (eee80e9)
- **daily-records**: run slash command registration tests (b696582)
- **daily-records**: cover slash commands and navigation (d150a6d)
- **daily-records**: add focused frontend regression workflow (f432ba5)
- **tasks**: validate time planning feature (feeb54a)
- **tasks**: validate labels and saved views (83fb347)
- **tasks**: add targeted task metadata typecheck (7a6a57d)
- **pg**: add final knowledge-tree read command (6ab2346)
- **pg**: add knowledge-tree read retry command (0e30ccf)
- **pg**: add one-shot schema view parity command (d28cdc8)
- **pg**: add one-shot audit reconciliation command (e11ce1f)
- **pg**: stage knowledge-tree read migration command (b12f0f0)
- **pg**: avoid workflow permission during branch sync (cd73024)
- **pg**: add one-shot latest-main sync command (4596d1f)
- **tasks**: validate My Day frontend and backend (175c463)
- **blocks**: validate historical schema repair (73f1d04)
- **tasks**: include offline runtime changes (ba1c304)
- **tasks**: validate offline task and habit support (2cf8364)
- **layout**: cover Web three-column state ownership (eb6a7d4)
- **onboarding**: cover first-login gate and app bridge (3455ce9)
- **onboarding**: verify bilingual new-user guides (033d5a4)
- **editor**: include deferred split layout regression (ce5c0d5)
- **editor**: verify issue 577 note switching fixes (d48911f)
- **ai-chat**: verify issue 568 interactions (9b75ea4)
- **siyuan**: run Markdown remote image import regression (7e1df2b)
- add import format regression workflow (a5cad3f)
- **micloud**: validate background jobs and SSE UI (9b5ee49)
- **pg**: remove temporary latest main merge command (c2069b2)
- **pg**: fix latest main merge anchor (b63cfff)
- **pg**: register latest main merge command (1a5b4b2)
- **pg**: remove temporary structure command workflow (f954087)
- **pg**: separate workflow update from structure commit (3e2ca7b)
- **pg**: enable PR-triggered structure command (a8dcb05)
- **pg**: trigger Yjs structure materialization (4abfca8)
- **pg**: materialize Yjs structure migration slice (2a6dc58)
- **micloud**: add backend import regression coverage (9f1ecf1)
- **pg**: remove temporary Yjs validation workflow (698d51d)
- **pg**: remove temporary Yjs command workflow (93df9eb)
- **pg**: remove temporary PostgreSQL sync workflow (ae98f50)
- **pg**: allow edited Yjs command trigger (f423753)
- **pg**: reuse proven command workflow for Yjs writes (a585d2b)
- **pg**: expose guarded Yjs write command (589ca91)
- **pg**: use fresh Yjs validation trigger branch (8cc5c40)
- **pg**: normalize remaining Yjs slice markers (e965597)
- **pg**: normalize Yjs patch markers before validation (d8e8da7)
- **pg**: trigger Yjs validation from clean main PR (45be7d1)
- **pg**: validate Yjs write slice through PR event (baa9897)
- **pg**: use robust v1.4.4 reconciliation script (bd34008)
- **pg**: finalize v1.4.4 sync regression reconciliation (1a9da55)
- **pg**: harden v1.4.4 sync regression gate (e76d466)
- **pg**: add guarded Yjs write migration command (cf2e1c3)
- **pg**: register reviewed mainline DB exceptions (d58f0fd)
- **pg**: add guarded main synchronization command (e59ca0c)
- **pg**: remove unused one-shot sync workflow (a90f564)

### 🔧 其他

- **backend**: 同步 package-lock 版本号至 1.4.4 (6a2e714)
- **android**: 升级 Gradle 插件与 compileSdk 版本 (d97bfda)
- **calendar**: remove temporary integration workflow (b73e50a)
- **calendar**: remove temporary integration script (193800d)
- **calendar**: normalize all-day due date transition (5708014)
- **calendar**: add validated integration patch (af77858)
- **journals**: remove temporary main sync workflow (d88851a)
- **journals**: prepare latest main sync (1c9e873)
- **journals**: remove temporary workspace journal frontend workflow (dbfa9e5)
- **journals**: remove temporary workspace journal frontend patch (b140d6b)
- **journals**: remove temporary workspace journal backend workflow (4645317)
- **journals**: remove temporary workspace journal backend patch (68d4643)
- **journals**: run robust frontend integration (128c2bf)
- **journals**: replace fragile frontend integration workflow (eb26326)
- **journals**: add robust workspace journal frontend patch (c2e03df)
- **journals**: wire workspace journal frontend integration (7438afa)
- **journals**: remove invalid frontend integration script (f059f7e)
- **journals**: add workspace journal frontend integration patch (6b13590)
- **journals**: wire workspace journal backend integration (929a16b)
- **journals**: add workspace journal backend integration patch (9ca92df)
- **journals**: remove temporary cleanup integration workflow (1678a95)
- **journals**: remove temporary cleanup integration script (4130052)
- **journals**: run cleanup integration on PR merge ref (5677f04)
- **journals**: wire cleanup integration task (e54427b)
- **journals**: add cleanup integration patch (bed5452)
- **markdown**: remove temporary integration workflow (ad6a463)
- **markdown**: remove temporary integration script (8ddbaf7)
- add temporary markdown daily command patch (32f7108)
- **journals**: remove open repair workflow (5c06cd9)
- **journals**: remove open repair helper (0cec66e)
- **journals**: retrigger explicit open repair (ac14fce)
- **journals**: wire explicit open repair (f42d331)
- **journals**: add explicit open repair patch (3e144a0)
- **journals**: remove contract patch workflow (0a93a69)
- **journals**: remove contract integration helper (38d4b56)
- **journals**: retrigger contract integration (b97fe82)
- **journals**: wire contract fix integration (6cba912)
- **journals**: add deterministic contract fixes (fd9c153)
- **journals**: remove frontend patch workflow (7c0591b)
- **journals**: remove frontend integration helper (67bff5e)
- **journals**: remove route patch workflow (66012a5)
- **journals**: remove route integration helper (4dd4b30)
- **journals**: retrigger frontend integration (6878c37)
- **journals**: wire archive frontend integration (2e62630)
- **journals**: add deterministic frontend integration patch (cd7f535)
- **journals**: retrigger route integration (9280dfd)
- **journals**: wire archive route integration (121ac76)
- **journals**: add deterministic route integration patch (92af822)
- **daily-records**: remove temporary API scope script (1748078)
- **daily-records**: remove temporary API scope workflow (9b0a2fd)
- **daily-records**: run temporary API scope patch (5d83b2f)
- **daily-records**: add temporary API scope patch (2eddca4)
- **daily-records**: remove temporary journal scope script (dc9ca45)
- **daily-records**: remove temporary journal scope workflow (75271d3)
- **daily-records**: simplify temporary journal scope patch (90e4b1f)
- **daily-records**: run temporary journal scope patch (7866602)
- **daily-records**: add temporary journal scope patch (eebac8a)
- **daily-records**: remove temporary integration script (a0803c1)
- **daily-records**: remove temporary integration workflow (0b95d7c)
- **daily-records**: include nav label in integration patch (2fa0c22)
- **daily-records**: extend temporary integration patch (1c9eff3)
- **daily-records**: run temporary slash integration patch (05cd937)
- **daily-records**: add temporary slash patch script (88b8715)
- **ci**: remove one-shot PostgreSQL final command (bc016fb)
- **ci**: remove one-shot PostgreSQL retry command (dcf35e6)
- **ci**: remove one-shot PostgreSQL schema command (7cc03ec)
- **ci**: remove one-shot PostgreSQL audit command (17e5fc0)
- **ci**: remove one-shot PostgreSQL migration commands (ace96cc)
- remove temporary typecheck script (48bedb8)
- remove temporary fix script (92aa593)
- remove temporary fix workflow (a81699e)
- **ci**: run timezone and mindmap alignment fix (a0bed52)
- **ci**: stage timezone and mindmap alignment fix (2c25253)
- remove staged auto-lock workflow (7660911)
- remove staged auto-lock script (7168a5d)
- **ci**: run folder auto-lock implementation (27fc757)
- **ci**: stage folder auto-lock implementation (7e94833)
- remove one-shot import format runner (85d5fc8)
- remove staged import format workflow (5eff276)
- enable import format implementation run (be25b43)
- stage import format implementation (fec0989)

### 📌 杂项

- 任务中心国际化文案补充 (b61f4e7)
- 任务行低优先级旗标桌面端悬停显示 (168be3e)
- 任务面板支持独立展开模式 (7abcec5)
- 任务中心架构重构  收集箱/我的一天/时间规划整合到侧栏 (d4e6800)
- 编辑器工具栏新增快速捕获到任务收集箱 (b2e29e9)
- 修复行内评论选区在外部交互后的残留显示 (35105c8)
- 全屏编辑时隐藏布局控制器 (e334234)
- 修复 Markdown 编辑器协同文档挂载时机 (c6fabd2)
- 知识树拖拽支持 DOCX 文件导入 (cd474df)
- 支持绿联 LAN 网关远程访问 (85b09cb)
- 修复笔记块索引内容文本重复 (571b34f)
- 移除行内评论浮动按钮及样式 (2d1d91b)
- 知识树目录节点折叠交互修正 (1c8a452)
- 任务数据导入导出入口与事件桥接重构 (7f301a2)
- 工作区删除笔记归属迁移逻辑提取为独立服务 (2b5e050)
- 知识树移动端工具栏按钮布局统一 (7aedcf1)
- 离线同步设置界面显示缓存位置和管理入口 (1c5a48a)
- 桌面端支持自定义离线缓存目录 (a1e19fc)
- 修复菜单构建时 isDev 取值时机 (8735c0a)
- 知识树紧凑工具栏与响应式操作菜单 (56166ae)
- 知识树统计新增笔记计数方法 (a7b8ed9)
- 修复行内评论 token 感知与匿名 401 边界 (2fd73cb)
- 移动端列表优先布局并整合搜索入口 (19d1ebb)
- 知识树创建菜单支持布局模式感知 (a97f2e6)
- 新增知识树搜索范围切换控件 (1159db0)
- 修复 Migration 版本号冲突 (df1062d)

## v1.4.4 - 2026-07-30

### ✨ 新增

- 移动端知识树支持紧凑模式 (c66752a)
- 知识树支持全部展开/收起并优化加载失败态 (7d8aedb)
- 支持笔记 Markdown 与富文本格式互转 (fda5b37)
- 笔记列表回收站空状态展示 (b11d7df)

### 🐛 修复

- **share**: show guest nickname in public comments (#543) (8dd7b47)
- **permissions**: install routes in legacy backend entry (eb645bd)
- **share**: prompt guest nickname before public comments (#541) (862fbcf)
- **editor**: restore rich-text interaction after format conversion (#539) (bf92883)
- 窗口化 Tiptap 编辑器大纲滚动定位 (afaecde)
- 右键菜单子菜单按视口智能定位 (877b7dc)
- 知识树根文档下创建子节点包裹隐藏根容器 (3a2fec3)
- 增强斜杠菜单中文输入法组合态处理 (37ec249)
- 优化 Markdown 隐藏块标记的容错与编辑器光标稳定 (8210c8f)
- 移动端抽屉导航栏宽度规则仅作用于导航项 (b4520aa)

### 📝 文档

- 设计 GitHub SignPath Windows 更新签名方案 (5c73e1f)
- **readme**: sync v1.4.3 capabilities (1f77093)

### ✅ 测试

- **permissions**: cover legacy backend route bootstrap (c2af22b)

### 🤖 CI

- **permissions**: watch legacy runtime bootstrap (45a20a9)


## v1.4.3 - 2026-07-29

### ✨ 新增

- 导出/导入支持解锁受密码保护的笔记本 (f3d1165)
- 知识树文件夹支持 JWT 解锁令牌 (d865ebe)
- 编辑器支持从文件管理插入已有附件 (ff011d9)
- 知识树文件夹支持密码保护 (8aec91e)
- **mobile**: 支持导入 Markdown 文件并优化移动端菜单交互 (2c35dc3)
- **ui**: add reusable user picker combobox (546c7dc)
- 登录会话改用 /me 校验并支持账号切换回退重登 (692bba0)
- 登录页支持记住账号与自动登录 (981b98b)
- 当前空间显示笔记本数量 (4c08908)
- 支持编辑器大纲栏拖拽宽度 (8a05e7a)
- 调整桌面和移动端知识树模式 (dfc2594)
- 知识树支持导入与权限管理 (15608c1)
- 完善图片编辑功能 (7f79618)
- **mobile**: 增加目录浏览模式开关 (6b9fe40)
- **mobile**: 最近优先与逐层目录导航 (b3b1111)
- **backup**: mount WebDAV backup settings bridge (d162785)
- **backup**: add WebDAV backup settings UI (2f88f69)
- **backup**: upload automatic backups to WebDAV (9f2168a)
- **backup**: enable WebDAV backup runtime (484323e)
- **backup**: mount WebDAV backup runtime routes (2ee8547)
- **backup**: add WebDAV configuration and upload routes (7051845)
- **backup**: add encrypted WebDAV backup service (7fb1cd3)
- **tree**: hide physical root document containers (7c09035)
- **tree**: route root document operations through compatibility layer (e41b5eb)
- **tree**: support documents at knowledge tree root (d3f2fc6)
- **tree**: route tree panel through create menu runtime (d433927)
- **tree**: add unified plus create menu runtime (d7bbd38)
- **permissions**: add DingTalk-style notebook access management (bc82df5)
- **mobile**: load compact knowledge tree styles (36acf46)
- **mobile**: add compact knowledge tree density (cc25787)
- **tree**: install Markdown file drop bridge (3ee5f77)
- **tree**: support dropping Markdown files into content tree (c2d267d)
- **import**: mount rich text callout compatibility (e4d8bfa)
- **import**: install rich text callout decorator (9609c6e)
- **import**: decorate SiYuan callouts in rich text (4af9143)
- **import**: mount Siyuan import feedback bridge (1a68337)
- **sync**: auto-resolve version conflicts before snapshot pull (7158a7c)
- **sync**: add latest-write conflict resolution strategy (7dc340c)
- 知识树嵌入优化、远程图片本地化及设置面板改进 (b6c3952)

### 🐛 修复

- 斜杠菜单中文输入法回车误触选择 (cf722d2)
- 附件面板复制保留笔记内相对链接 (e28d5dd)
- 文件管理器清理附件按钮常驻并点击重新扫描 (b9770f7)
- 修复笔记附件目录遗漏归属文件 (88f0e8f)
- **mobile**: 进一步压缩移动端知识树目录行高并修正操作按钮尺寸 (b006c70)
- **mobile**: 进一步压缩浏览器移动端树目录间距 (77d747f)
- **editor**: stabilize code block indentation and numbering (#327) (96f1162)
- **mobile**: 明显缩小移动端笔记节点间距 (8d720e2)
- **mobile**: make note rows visibly denser than folders (93413d1)
- **mobile**: scope dense tree styling to the rendered panel (ea434b0)
- **editor**: add stable code block indent commands (#327) (9ea12bd)
- **ui**: keep empty user picker exclusions stable (8ab8a47)
- **permissions**: use dropdown user picker for ACL rules (4cde233)
- **mobile**: 修复浏览器移动端树节点间距未生效 (72a16c0)
- **mobile**: scope compact tree density to mobile sidebar (b38f7c4)
- **desktop**: keep public notebook navigation inside app entry (9b3fff6)
- **desktop**: use file-safe public space navigation (9254fbd)
- **desktop**: resolve public routes from file-safe query (0555d7c)
- **desktop**: add file-safe app navigation helper (c37bebe)
- **tree**: correct note counts and compact mobile rows (d8d959c)
- **ui**: 全端默认关闭拼写检查 (84dde03)
- **tree**: simplify desktop row hover actions (4469f15)
- **desktop**: compact offline indicator (2f202c8)
- **mobile**: suppress offline status banner (20840ff)
- 鼠标悬停时隐藏笔记本数量 (a1ac584)
- **sync**: retain pending editor snapshots locally (d9e7262)
- **editor**: preserve debounced edits during conflict sync (b1ea57a)
- **sync**: preserve edits during silent conflict resolution (deac023)
- **sync**: resolve version conflicts silently (5e42b79)
- **share**: hide internal markdown block markers (a310f6a)
- **android**: limit preview tap capture to touch pointers (05d728f)
- **android**: close image preview when tapping image (270938e)
- **tree**: use anchored dropdown for new content (33e20a7)
- **backup**: harden WebDAV request parsing (80807a8)
- **backup**: use symbol-safe WebDAV route guard (bac976b)
- **permissions**: transfer unified knowledge tree ownership atomically (d075622)
- **migrations**: load permission runtime after feature registration (049b26b)
- **migrations**: keep db runtimes out of migration bootstrap (b0bc728)
- **url-import**: tighten DNS compatibility typings (0764830)
- **url-import**: load DNS compat before route modules (6772896)
- **url-import**: install DNS fallback before routes load (f18661d)
- **url-import**: add system resolver fallback for DNS checks (4686c04)
- **mobile**: tighten tree expander and icon spacing (2aa9ddf)
- **share**: 修复 Edge 分享链接复制失败 (0ea07d1)
- **tree**: include note version when writing dropped Markdown (7ecb3c8)
- **mindmap**: 切换目录时清空旧导图内容 (eacd871)
- **editor**: scope callout selector to both editor roots (0958545)
- **import**: render SiYuan progress inside import panel (12f7e35)
- **editor**: style callouts in production rich-text root (1efc07a)
- **editor**: detect callouts in actual Tiptap root (e23c8ee)
- **import**: treat SiYuan callouts as supported content (069a6be)
- **android**: open mobile tree drawer by default (7f02fee)
- **import**: detect Siyuan zip contents and show progress (52924a5)
- **markdown**: read normalized Callout data properties (e6351a8)
- **markdown**: allow hyphenated Callout HAST attributes (2e9902f)
- **import**: refresh knowledge tree after note imports (4dbb441)
- **markdown**: preserve callouts beside raw iframe HTML (2d422f1)
- **siyuan**: normalize iframe entities and heading IAL (bc8a661)

### ⚡ 优化

- **windows**: speed portable extraction and show startup splash (3d94397)
- **desktop**: shrink production backend bundle for faster startup (da25b73)
- 优化一级目录笔记本数量统计 (3af7c08)

### ♻️ 重构

- **permissions**: reuse user picker for collaborators (485f382)

### 📝 文档

- 记录附件目录归属修复设计 (1019df7)
- restore WeChat and Alipay sponsor codes (10f51f7)
- **readme**: sync current features and simplify project overview (3f35622)
- **backup**: add native WebDAV backup guide (7e948e1)
- **backup**: document WebDAV encryption key (0ad89f1)

### 💄 样式

- **mobile**: compact nested knowledge tree rows (c3caa82)
- **tree**: load desktop compact density (467dbce)
- **tree**: compact nested desktop rows (9f15085)
- **tree**: add fallback drop target highlight (9002741)
- **tree**: highlight Markdown file drop target (8f500dd)
- **import**: render SiYuan callout variants in editor (be7739f)

### ✅ 测试

- 补充附件面板复制相对链接测试 (9407320)
- **editor**: account for trailing paragraph in indent transactions (4b33aa7)
- **editor**: expose issue 327 transaction shapes (8f94193)
- **mobile**: verify note-only compact tree density (382ab9e)
- **mobile**: lock dense tree panel class (1b684dc)
- **permissions**: cover shared people pickers (fcade60)
- **editor**: cover code block indent transactions (#327) (6e122b8)
- **permissions**: lock ACL user picker behavior (5559496)
- **mobile**: cover sidebar-scoped compact tree density (19ae641)
- **desktop**: lock Windows startup performance build settings (6572c97)
- **desktop**: cover file-safe public space navigation (dd70e98)
- **mobile**: lock compact nested tree spacing (f9709de)
- **tree**: lock compact descendant row density (bf0fb86)
- **ui**: 覆盖全局拼写检查关闭 (d6f960e)
- **android**: keep desktop mouse drag unaffected (95be27e)
- **android**: cover image preview tap close (7f98dad)
- **tree**: cover anchored create dropdown (cfed8a4)
- **permissions**: cover v64 unified tree ownership transfer (8e1f632)
- **backup**: cover encrypted WebDAV configuration (dff4e96)
- **migrations**: lock feature registration before db runtime (f3b4efa)
- **tree**: initialize optional tree resource schemas (eedd474)
- **tree**: cover root rich text and markdown documents (d147e25)
- **url-import**: verify DNS installer is executable and idempotent (0bc83f6)
- **url-import**: cover system DNS fallback and bootstrap order (1771f3b)
- **mobile**: lock compact tree expander geometry (b94b947)
- **mobile**: lock compact knowledge tree contract (811076f)
- **tree**: cover external Markdown drop detection (b3145a7)
- **editor**: stabilize production-root assertion (fe4f035)
- **editor**: assert real root class contract (a7153e6)
- **import**: cover inline SiYuan progress host (15f3a0c)
- **editor**: observe callouts in production root (3a16ad9)
- **editor**: cover production Tiptap callout root (86aec10)
- **markdown**: validate live-preview Callouts independently (32a7f87)
- **markdown**: avoid CodeMirror DOM implementation assertion (5c9467b)
- **markdown**: isolate live-preview Callout blocks (743d1c5)
- **markdown**: cover five Callouts in live preview (5b0d80f)
- **markdown**: cover five SiYuan Callout preview types (fed348c)
- **import**: add SiYuan Callout fixture (e5765b3)
- **import**: cover callout bridge lifecycle (4f604a8)
- **import**: preserve callouts across rich text and markdown (175bf79)
- **import**: cover rich text callout decoration (f2794d2)
- **android**: cover default drawer and rail label layout (d3cd3d9)
- **import**: cover Siyuan zip detection and request matching (5d0b4ac)
- **sync**: cover automatic latest-write conflict resolution (5d1875c)
- **markdown**: split issue 494 preview assertions (1b6ada7)
- **import**: verify content tree refresh bridge (d226b21)
- **markdown**: isolate issue 494 callout iframe regression (03a6ba6)
- **markdown**: isolate issue 494 regression scenario (e0eb933)
- **markdown**: consolidate issue 494 coverage (3b5575b)
- **markdown**: exercise issue 494 preview path in runtime CI (59a44a0)
- **markdown**: cover issue 494 callout and iframe compatibility (dea425b)
- **siyuan**: cover issue 494 markdown regressions (9271a17)

### 📦 构建

- **windows**: add portable extraction splash asset (5c51ac3)

### 🤖 CI

- **mobile**: preserve legacy density variable aliases (5db4ff9)
- **editor**: make issue 327 integration patch resilient (c1bf619)
- **editor**: run issue 327 integration from draft PR (ca8ddbb)
- **editor**: apply and verify issue 327 integration patch (56ee76c)
- **share**: add markdown presentation regression (fbbd246)
- **android**: validate image preview tap close (ca63b99)
- **backup**: validate WebDAV backup support (af5307f)
- **migrations**: verify bootstrap ordering regression (2751b07)
- **tree**: record issue 512 validation result (b223d9f)
- **tree**: rerun issue 512 validation (d2c72af)
- **tree**: trigger issue 512 validation (3eb6d5b)
- **tree**: add issue 512 validation workflow (a8ac7bf)
- **permissions**: retain ownership regression diagnostics (1e8499a)
- **permissions**: add notebook permission management checks (799f515)
- **url-import**: verify DNS fallback and backend build (a81866f)
- **mobile**: enforce compact expander footprint (ede4dfd)
- **mobile**: cover compact knowledge tree styles (18e5f5c)
- **markdown**: split Callout preview diagnostics (1366287)
- **import**: verify Markdown Callouts in preview modes (0975f20)
- **import**: include Callout bridge lifecycle test (4f1f1a4)
- **import**: cover rich text callout compatibility (616d97f)
- **import**: validate Siyuan import feedback bridge (7ec68ac)
- pinpoint issue 494 preview regressions (108da88)
- isolate issue 494 frontend checks (c24d00a)
- run issue 494 frontend regressions (c017741)
- run SiYuan markdown regression coverage (6f9eedf)

### 🔧 其他

- remove temporary file (81cc37a)
- apply share marker fix (bdbd85a)
- **ci**: remove redundant create dropdown migration (d1e1dd8)
- **ci**: add create dropdown migration (9a2f7a1)
- **tree**: remove temporary issue 512 validation report (684d598)
- **tree**: remove issue 512 validation marker (06d02f3)
- **tree**: remove temporary issue 512 validation workflow (b52cb03)
- **tree**: remove temporary issue 512 PR workflow (1125092)
- **tree**: remove temporary issue 512 command workflow (4c0ed7f)
- **tree**: remove temporary issue 512 marker (9a25d64)
- **tree**: remove temporary issue 512 trigger workflow (1469b98)
- **tree**: remove temporary issue 512 apply workflow (8856324)
- **ci**: add PR trigger for issue 512 implementation (65dab80)
- **ci**: add issue 512 command workflow (bebedb4)
- **ci**: remove permission integration workflow (fed1cab)
- **ci**: start issue 512 implementation (3764f5b)
- **ci**: add issue 512 workflow trigger (22e9793)
- **ci**: apply issue 512 implementation (c855426)
- **ci**: trigger permission integration when ready (445c8cb)
- **ci**: run permission integration from pull request (5133737)
- **ci**: add one-shot permission management integration (605fe70)
- remove temporary Edge copy fix workflow (071cb3f)
- clean Edge copy trigger marker (1621e83)
- trigger Edge copy fix from pull request (aa7cf8b)
- add one-shot Edge share copy fix trigger (001509c)
- remove one-shot mind map fix trigger (10f1a84)
- add one-shot mind map folder fix trigger (19d9eb8)
- remove accidental temporary file (c866133)
- **import**: remove unused Callout fixture (180187b)
- remove accidental placeholder (4ab8b36)

### ⏪ 回滚

- **tree**: remove desktop compact spacing stylesheet (4f87b3b)
- **tree**: stop loading desktop compact spacing (86e9412)

### 📌 杂项

- noop (ca8b780)
- 修复知识树置顶统计 (00cb50e)


## v1.4.2 - 2026-07-27

### ✨ 新增

- 支持多账号登录历史切换 (88976e3)
- **frontend**: improve knowledge tree scrollbar performance and settings UX (b8a0e69)
- **tree**: create documents inline without modal (9ebbe49)
- **tree**: add inline create draft helpers (63fd495)
- **layout**: enforce unified-tree-only desktop and mobile navigation (15ae19f)
- **layout**: migrate legacy notebook-list preferences at startup (113dc45)
- **layout**: define unified-tree-only navigation policy (35bb333)
- **mobile**: expose global note search in nav rail (26992bb)
- **mobile**: add note search launcher helper (1aba32f)
- **frontend**: add knowledge tree sort control (0bcad89)
- **frontend**: apply selected sort mode to knowledge tree listings (2311939)
- **frontend**: add unified knowledge tree sort model (8d0d7bb)
- **editor**: integrate safe one-shot format painter (251305e)
- **editor**: add safe format painter transaction helper (df86790)
- **android**: extend immersive editing to Markdown (68cd545)
- **android**: add immersive mobile editing mode (44e8d09)
- **knowledge-tree**: add capability-aware node context menu (d04f510)
- **knowledge-tree**: make the unified tree the only Sidebar hierarchy (#467) (2f96915)
- **knowledge-tree**: coordinate legacy Notes/Notebooks hierarchy writes (#465) (00c864b)
- **knowledge-tree**: show shared mixed content in the unified tree (#463) (c0540c7)
- **navigation**: make the unified knowledge tree the primary Sidebar hierarchy (#461) (ef307e8)
- **shortcuts**: integrate customization runtime and settings (066ec9e)
- **shortcuts**: resolve overrides and validate bindings (0c70d8c)
- **shortcuts**: mark configurable commands (e969c10)
- **settings**: add shortcut customization panel (5ff7dc1)
- **shortcuts**: execute customizable rich-text bindings (3f199bc)
- **shortcuts**: add platform-scoped override storage (a06157c)
- **shortcuts**: add unified registry and help center (#456) (9edf24d)
- **issue-370**: implement P0 permissions and P1 unified knowledge tree (0d65d43)
- **shares**: add centralized share management (#447) (fdabc64)
- **perf**: add issue 210 sign-off validator (4d7c70f)
- **perf**: install issue 210 sign-off runtime (92c0d06)
- **perf**: add issue 210 runtime sign-off collector (75fa180)
- **shares**: add centralized management page (#447) (a6a7df0)
- **shares**: add management presentation helpers (#447) (86385b4)
- **shares**: add management query service (#447) (940aed3)
- **issue-370**: harden and productize split editing (140e176)
- **issue-370**: productize layout commands (015cc32)
- **issue-370**: add workspace layout helpers (c2a04dd)
- **sidebar**: add shared notebook tree component (3938152)
- **editor**: route editors through initialization watchdog (1e4f4d7)
- **editor**: wrap Tiptap initialization (d4aa92a)
- **editor**: wrap Markdown initialization (5aaa46a)
- **editor**: watch editor readiness (e3ee89b)
- **editor**: add initialization timeout policy (3fd1e20)
- **images**: 历史笔记网络图片批量本地化 (#423) (c5828a3)
- **code-block**: expose MAXScript in language picker (dc70053)
- **editor**: register MAXScript before lowlight setup (6039400)
- 移除侧栏账号入口 (a6cc5ea)
- **markdown**: highlight MAXScript fences (e699921)
- **code-block**: share MAXScript lowlight setup (a403210)
- **code-block**: add MAXScript grammar (e18dd05)
- **import**: apply permission mappings in primary import flow (7c7e55c)
- **import**: mount permission transfer centers (1c29a67)
- 移除一次性数据迁移接口 (3eee71d)
- **import**: submit explicit permission mappings (28de8a4)
- **export**: add explicit permission export dialog (9b5d36d)
- 移除桌面端服务器资料凭据 (f3b3d91)
- **export**: add permission export bridge (27d54db)
- **import**: add permission mapping modal (c53cf6c)
- **import**: add permission mapping review queue (6896f7c)
- **import**: add permission account mapping panel (ce49ba3)
- 移除连接与迁移前端功能 (25fd9aa)
- **import**: expose permission-aware package endpoints (0406d76)
- **import**: integrate permission preview and apply (2c186a2)
- **export**: make permission manifest opt-in (a00128c)
- **import**: add guarded permission undo (b2cb360)
- **import**: add v2 permission transfer service (8be6ded)
- 将拆分文档移入更多菜单 (af4fddb)
- 增加窗口化性能签收标签 (8e57ad2)
- 增加跨章节安全回退与最新快照 (1de5278)
- 绑定子文档离线更新代际 (195fcac)
- 实现子文档代际冲突与结构重分段 (768bc7e)
- 增加子文档代际迁移 (a0a7859)
- 同步恢复导入后的 Block 权威状态 (16429cf)
- 增加 Block 权威跨库原子写入 (a63e235)
- 添加 Block 权威灰度主读 (dbfdbb7)
- 接入编辑器性能门禁与分段存储基础 (002ff0f)
- **editor**: 完成 Block 权威存储与 Subdocument 窗口化 (152706c)
- **editor**: validate inline image replacement snapshots (ea12df5)
- **blocks**: validate inline image replacement nodes (4c0c1b2)
- 增强块补丁与Tiptap编辑器性能分析能力 (782fa43)
- **ai**: discover and test embedding models (34fbc4c)
- **blocks**: persist scoped list item structure patches (27c8ebf)
- **editor**: enable list item structure planning (351e8af)
- **editor**: type scoped list item structure patches (1ac3e93)
- **editor**: plan controlled list item create and delete (6c9f4ce)
- **blocks**: apply scoped list item structure patches (6e157b1)
- **blocks**: plan list item structural indexes (81b4d6a)
- **ai**: bind embedding to a saved profile (8381a08)
- **blocks**: add controlled list item create and delete (e6d94a3)
- **editor**: type list subtree index responses (3825345)
- **blocks**: use incremental list subtree indexes (1e97c74)
- **blocks**: plan incremental list subtree indexes (0a80118)
- **tasks**: move completed tasks below pending tasks (c88fa23)
- **editor**: enable list hierarchy patch planning (fded464)
- **editor**: compose list hierarchy patch planning (51f54f3)
- **editor**: plan controlled list hierarchy moves (510fe54)
- **editor**: type controlled list item moves (bacf7ac)
- **blocks**: support controlled list hierarchy patches (eb1dede)
- **blocks**: add controlled list item moves (0517674)
- **mindmap**: add minimal borderless node style (d30eaad)
- **editor**: install empty Block identity dispatch (0516390)
- **editor**: reconcile empty Block IDs without history (c318aff)
- **editor**: patch empty Tiptap documents safely (d1a433c)
- **editor**: plan rich mixed structural patches (c61c1b8)
- **editor**: type mixed index update metadata (ac03a09)
- **blocks**: expose mixed index update kind (061428e)
- **editor**: type structural index update metadata (c94f926)
- **blocks**: expose structural index update kind (8153f72)
- **blocks**: expose patch index update mode (31ee6a4)
- **blocks**: plan incremental patch index updates (a98c34c)
- **attachments**: add safe legacy image-host migration (d9f43b8)
- **electron**: prevent data directory from being set to protected system paths (57c9e19)
- **import**: add permission mapping client API (bb41225)
- **import**: mount round-trip permission mapping routes (8badde8)
- **import**: add permission package and mapping endpoints (c68ee55)
- **import**: add guarded workspace permission mapping service (1375451)
- add persistent import reports and guarded undo (#380) (ee62e2c)
- **import**: add conflict-safe round-trip incremental sync (26271e7)
- **editor**: plan rich leaf block replacements (a96d370)
- **editor**: type rich block replacement operations (3933188)
- **editor**: validate rich block replacement snapshots (4027466)
- **blocks**: apply validated rich block replacements (e892153)
- **blocks**: validate rich block replacement nodes (7a21e8a)
- **editor**: grey-roll out Tiptap Block Patch saves (1a655e0)
- **editor**: define Block Patch grey rollout policy (41218fa)
- **blocks**: expose authoritative patch response (4f1d64a)
- **blocks**: return authoritative patch snapshot (f373323)
- **editor**: plan safe Tiptap block patches (39c9f80)
- **import**: safely merge round-trip packages into existing folders (55de099)
- **blocks**: add confirmed frontend patch client (3ffc91c)
- **import**: show round-trip preflight report (9ef0f15)
- **blocks**: add atomic batch patch route (8786188)
- **blocks**: add pure Tiptap batch patch engine (86763c4)
- **block-links**: resolve split redirects before navigation (49d935c)
- **block-links**: install split redirect resolver (5eb116e)
- **block-links**: expose split redirect resolver (a1b6c81)
- **block-links**: resolve blocks moved by note splitting (c9cca98)
- **import-export**: preserve tree and attachments round trip (c70d51b)
- **note-split**: support Tiptap previews and block-link confirmation (6e07707)
- **note-split**: expose rich-text block link warning (09561e7)
- **note-split**: expose Tiptap heading split entry (3bdc48b)
- **note-split**: preview Tiptap heading sections (b11fae0)
- **note-split**: register Tiptap split routes (ef5453d)
- **note-split**: add transactional Tiptap splitting (3c0b015)
- **note-split**: add Tiptap heading split planner (67d760b)
- **note-split**: choose chapters before splitting (1c21933)
- **note-split**: send selected section indexes (236c8ad)
- **note-split**: register selected-section routes first (4b86722)
- **note-split**: support selected chapter extraction (a714bbf)
- **note-split**: build partial split source safely (0b19c24)
- **note-split**: preserve attachment ownership across split and undo (8776a75)
- **note-split**: route editor through split runtime shell (6591282)
- **note-split**: expose split action in editor (f699013)
- **note-split**: add split preview and undo dialog (f831df4)
- **note-split**: add confirmed split api client (d9c3242)
- **note-split**: add client split preview planner (e6c6955)
- **note-split**: register note split routes (94d8e0b)
- **note-split**: add transactional split and undo routes (8d68f62)
- **note-split**: add markdown split planner (a127aa9)
- **markdown**: route large editor through incremental sync shell (6bca463)
- **markdown**: sync CodeMirror and Y.Text incrementally (9cf3c5f)
- **markdown**: track incremental collaboration runtime (3298669)
- **editor**: embed pasted bilibili video links (7a453ab)
- **markdown**: add incremental CodeMirror Y.Text mapping (18895c4)
- **markdown**: enable optimized editor from viewport tier (fb64b9b)
- **markdown**: route medium docs to viewport editor (37f9112)
- **markdown**: upgrade large docs to viewport editor (4a52fee)
- **markdown**: add stale-safe worker controller (e1e7869)
- **markdown**: run document analysis in worker (33ea398)
- **markdown**: add worker-safe document analysis (2a68c05)
- **editor**: route heavy nodes through runtime shells (5d5c5a5)
- **editor**: defer mermaid rendering by viewport (55f82f5)
- **editor**: lazy mount video and iframe node views (3fa9d60)
- **editor**: support interaction-gated heavy nodes (c1a2f35)
- **editor**: expose runtime mode notice and session restore (9c8f7a7)
- **editor**: add reusable heavy-node viewport hook (1f93df2)
- **editor**: explain emergency document protection reasons (f63f9f1)
- **editor**: route notes through progressive runtime policy (e536a29)
- **editor**: add runtime mode store and long-task escalation (b779eb2)
- **editor**: add progressive runtime mode policy (230ab27)
- **editor**: add unified document complexity profiler (20ba263)
- **search**: expose sidebar search pending state (ab7a705)
- **search**: add progressive query policy (b97e6fe)
- **editor**: add lightweight editor for huge Markdown notes (aa46b7b)
- **editor**: detect unsafe large Markdown documents (263cf0f)
- **settings**: load switch card styles (f3641e3)
- **settings**: redesign preference switches (167726f)
- **auth**: secure multi-server account profiles (#343) (7645fb4)
- **sync**: poll desktop collections for external writes (b57b488)
- **sync**: install workspace refresh bridge (01cb894)
- **sync**: add desktop workspace refresh bridge (6186955)
- **note-transfer**: expose rewritten link counts to clients (#325) (62651f5)
- **note-transfer**: support atomic local and object-storage transfers (#325) (c6504f2)
- **audit**: add note transfer category (#325) (cb34a36)
- **note-transfer**: mount cross-space transfer center (#325) (13042fc)
- **note-transfer**: add copy and move transfer center UI (#325) (559354a)
- **note-transfer**: add typed frontend transfer client (#325) (ca3261e)
- **note-transfer**: mount dedicated transfer router (#325) (8ef6616)
- **note-transfer**: expose preview and execute endpoints (#325) (60c1147)
- **note-transfer**: add safe cross-workspace note transfer service (#325) (71b6386)
- **settings**: mount Docker update center (#330) (8b97e1c)
- **settings**: add Docker online update experience (#330) (7cc9aeb)
- **updater**: add admin preflight backup and apply API (#330) (dd301ba)
- **settings**: mount administrator update control plane (#330) (5003fa5)
- **updater**: expose authenticated internal control plane (#330) (1213f28)
- **updater**: persist update jobs and rollback containers (#330) (54cb7ea)
- **updater**: add restricted Docker Engine adapter (#330) (b86233d)
- **docker**: split local build compose override (#330) (4f8c0e7)
- **docker**: package updater entrypoint and health metadata (#330) (b5cbb5e)
- **docker**: add managed updater deployment profile (#330) (43cdc4b)

### 🐛 修复

- **android**: improve share import multipart handling and safe-area layout (0bbb7cb)
- **release**: 支持 AppImage 内嵌 blockmap (9344371)
- **docker**: 修复多架构构建语法 (7bb77c5)
- md (6c27a83)
- **import**: preprocess browser-saved HTML documents (73a41e5)
- **import**: normalize SingleFile HTML before note conversion (cd08dce)
- **ai**: narrow embedding settings observer target (c976fa6)
- **ai**: keep index task copy bridge idempotent (89b7e7d)
- **tree**: install custom scrollbar bridge at startup (56630b8)
- **tree**: add runtime custom scrollbar for web and desktop (a80f487)
- **tree**: restore visible desktop scrollbar (b9cef05)
- **frontend**: restore sort button beside knowledge tree filter (a618125)
- **electron**: preserve markdown text encoding on open (a87d1cb)
- **electron**: decode Windows markdown encodings (5a73653)
- **editor**: preserve nested block structure in format painter (b6369bc)
- **issue-455**: add one-shot nested block safety workflow (f9618d6)
- **issue-455**: add nested block safety patch (7f9385d)
- **editor**: keep format painter hooks in component scope (8c2f665)
- **issue-455**: add one-shot hook scope repair (de3fb7a)
- **issue-455**: add hook scope correction (337e776)
- **editor**: keep format painter hooks unconditional (1311eb1)
- **issue-455**: add hook-order repair workflow (e69d914)
- **issue-455**: add hook-order correction (954455c)
- **android**: preserve editor focus in immersive toolbar (1c783f7)
- **knowledge-tree**: keep imported documents under selected tree parent (cc92910)
- **knowledge-tree**: remove duplicate child map declaration (df5cfac)
- **knowledge-tree**: repair context-menu panel JSX (9735f92)
- **knowledge-tree**: restore directory context-menu capabilities (a6c13ed)
- **knowledge-tree**: defer insert guard trigger and fix cross-scope parent mapping (4cbb244)
- **shortcuts**: remove stale tooltip hints after clearing bindings (a8b4eff)
- **shortcuts**: support generated heading commands (24489d3)
- **yjs**: avoid no-op version bump during flush (7792d1f)
- **knowledge-tree**: initialize schema once per database connection (1aa409e)
- **knowledge-tree**: activate tree subtree before restoring resources (e9f99d7)
- **postgres**: validate tree parents only on structural updates (7719ec5)
- **knowledge-tree**: retain structural guard after runtime ensure (0c2f56b)
- **knowledge-tree**: register v64 structural guard (9e0f6a2)
- **knowledge-tree**: validate parent scope only on structural changes (2881903)
- **postgres**: preserve document parents on legacy notebook updates (01b71dd)
- **knowledge-tree**: keep hardened sync triggers after runtime ensure (ce36ca8)
- **knowledge-tree**: register v63 legacy sync migration (04dd066)
- **knowledge-tree**: split legacy notebook parent and state triggers (7f4122a)
- **knowledge-tree**: restore deleted descendants with subtree recovery (8be01ed)
- **knowledge-tree**: restore complete deleted subtrees (4ea844c)
- **permissions**: preserve workspace role for newly created nodes (f2f8efc)
- **permissions**: keep workspace creators on inherited team roles (837f39d)
- **knowledge-tree**: route listing through qualified SQL implementation (ddde99f)
- **knowledge-tree**: use unambiguous mixed-tree title ordering (4f8219c)
- **knowledge-tree**: avoid migration bootstrap schema cycle (3712f52)
- **knowledge-tree**: ensure optional resource tables before tree queries (c999f0d)
- 完善笔记删除与附件清理逻辑 (1fdad04)
- 完善编辑器分屏镜像与多编辑器集成 (29bdc37)
- 优化编辑器分屏镜像同步逻辑 (7296fb1)
- 清理前端初始化与设置相关逻辑 (8a1795a)
- **collaboration**: render complete shared notebook tree (43750b4)
- **api**: harden note content view boundary (#355) (c59f04c)
- **api/editor**: hide Markdown block IDs and route by content format (#355) (0d397a1)
- **tags**: make tag creation idempotent by scope (8a3cebd)
- **tags**: register scoped tag uniqueness migration (9d6637a)
- **tags**: migrate tag names to scoped uniqueness (1785f78)
- **tags**: add idempotent scoped tag creation (8e06def)
- **sdk**: let server derive attachment note search text (478a26f)
- **sdk**: deduplicate concurrent attachment logins (6c8a316)
- **sdk**: copy typed arrays before creating blobs (d9d196a)
- **sdk**: include web platform types for public client (5d350da)
- **ci**: install SDK without missing lockfile cache (ac15412)
- **sdk**: expose note content format types (de815dc)
- **editor**: 修复大纲生成与跳转 (f36bbbf)
- **editor**: exclude explicit-only grammars from auto mode (2d07fca)
- **code-block**: preserve automatic detection subset (f54337e)
- **editor**: 移除轻量编辑模式提示 (7fd14c2)
- **editor**: 移除视口优化提示 (93640a2)
- **import**: preserve forbidden status in undo error (2e37e2a)
- **import**: recheck admin role before permission undo (0c1e4d6)
- **export**: honor data manager workspace scope (6697434)
- **import**: show invalid permission manifests in preflight (ab13f80)
- 清理遗留服务器资料数据 (734f5ad)
- **import**: harden legacy permission mapping (58bb44d)
- 修复超长笔记滚动区域 (51e6e06)
- 修复窗口化笔记滚轮失效 (dce9211)
- 收口 M6 M7 权威存储与窗口化一致性 (5811aa3)
- 重分段后立即回退单体编辑器 (435c34b)
- **clipper**: recover missing content script receivers (a344e48)
- **blocks**: enforce list item container compatibility (c13a742)
- **editor**: prove list structure Block identities (b13ad3f)
- **editor**: fall back after rejected list structure patches (ad9c660)
- **blocks**: reuse structural index plan type (53c484f)
- **editor**: plan list moves with large subtrees (76f211f)
- **editor**: preserve list attrs and choose equivalent moves (1c7a5df)
- **blocks**: preserve list attrs when sinking items (2accf67)
- **editor**: fall back after rejected list moves (21cf1b1)
- **ai**: keep vector status messaging consistent (e918dc9)
- **blocks**: track temporary structural Block identities (a1af567)
- **ai**: clarify vector indexing states (5272ff2)
- **ai**: install embedding queue hardening (ede3455)
- **ai**: harden embedding queue recovery (8a84ffb)
- **blocks**: narrow incremental leaf operations (4faf2c6)
- **blocks**: report actual indexed Block rows (baa958a)
- **blocks**: expose ancestor index updates (d762bff)
- **blocks**: refresh indexed ancestors for leaf patches (cec9019)
- **editor**: narrow rich replacement operation types (dbabd0b)
- **editor**: fall back on rejected rich block nodes (22a1578)
- **blocks**: preserve note history during patch saves (c4bfc0b)
- **editor**: scope Tiptap runtime policy to its note (4cf9295)
- **editor**: keep empty Tiptap docs on whole-save path (19a5a34)
- **editor**: isolate Block Patch AppContext usage (b47d29e)
- **editor**: serialize title saves behind Block Patch (234d98d)
- **blocks**: type list update broadcast payload (ccc21c8)
- **editor**: isolate stale Block Patch completions (dc3b624)
- **blocks**: reject cross-note idempotency key reuse (819c95b)
- harden attachment router bootstrap (b319734)
- **blocks**: preserve valid Tiptap containers after deletes (7701035)
- **blocks**: normalize source before atomic patch (6f4a7c6)
- **editor**: align runtime search plugin key typing (41d1639)
- **block-links**: enforce ACL across redirect chains (0f3a2fb)
- **block-links**: make redirect resolver route-order independent (0e39363)
- **block-links**: preserve moved block ids across redirect chains (b29eae2)
- **note-split**: keep Tiptap out of Markdown Yjs rooms (d981c87)
- **note-split**: refresh split availability after mutation (39a27a6)
- **note-split**: keep empty Tiptap chapters valid (c16a70a)
- **note-split**: keep Tiptap directory schema clean (d2408c7)
- **note-split**: strip persisted block ids from titles (ca0e85f)
- **note-split**: hide runtime block ids from titles (3fbc1d5)
- **note-split**: generate valid internal note links (56aaf95)
- **docker**: load hardened backend entrypoint for full backups (#352) (2690bb1)
- **desktop**: 修复视频全屏与打包校验 (1ac40e3)
- **editor**: avoid syncing note format as user preference (6aa2952)
- **note-split**: rollback on transactional version races (64691f4)
- **desktop**: respect markdown format when opening notes (f89cfbc)
- **desktop**: open markdown notes in markdown editor (2349ab7)
- **markdown**: skip conversion for emergency rich text (2b0ac4a)
- **markdown**: classify normalized content for large mode (4319446)
- **markdown**: keep analysis worker compatible with old webviews (ed45702)
- **build**: use browser timer handle types (ab29e74)
- **build**: cast runtime-only note metadata safely (88a04e1)
- **build**: use numeric Tiptap end selection (de1e637)
- **build**: type lowlight runtime test doubles (1a79680)
- **build**: align editor performance diagnostic types (972687f)
- **video**: correct desktop overlay guard syntax (#367) (cf41b24)
- **video**: keep desktop native controls interactive (#367) (6bad94f)
- **editor**: keep runtime notice compatible with older webviews (6ed11f6)
- **editor**: harden viewport highlight scheduling (8bec5ce)
- **editor**: use canonical empty decoration set (db9f00b)
- **editor**: preserve rich-text threshold compatibility (649c657)
- **editor**: avoid false large-document mode for compact rich text (b5a0255)
- **search**: animate full-text search loading spinner (ead4262)
- **search**: make sidebar loading spinner rotate (d66d51f)
- **search**: buffer sidebar typing and preserve focus (c4f0394)
- 删除不必要的文件 (a88fd22)
- **editor**: bypass Tiptap and Yjs for huge rich-text notes (c0a44c7)
- **search**: preserve intentional short queries (bc40fee)
- **search**: defer progressive short queries (7e8b0e0)
- **search**: cancel stale progressive requests (394fd8b)
- **editor**: route huge Markdown notes to safe mode (61bfd1a)
- **android**: 对齐 findLast 长度转换语义 (4b37273)
- **editor**: 区分 WebView 兼容错误与笔记结构异常 (e5be206)
- **android**: 在应用启动前加载运行时兼容层 (639ddb9)
- **android**: 补齐旧版 WebView findLast 兼容 (1d15943)
- **editor**: remove task list DOM observer loop (#361) (635fda3)
- **editor**: align task and bullet list markers (#361) (82cad44)
- **search**: repair source text and bound candidate retrieval (#340) (5c4ead6)
- **editor**: keep in-note search matches visible (#328) (9a3df5f)
- **editor**: complete cache-first and split loading coverage (#351) (fb40a94)
- **editor**: smooth delayed note loading transitions (#351) (e998f9e)
- **sync**: trust server probe for LAN connectivity (#350) (14d1e11)
- **sync**: respect syncNow failure results (#350) (ac7abca)
- **sync**: harden recovery flush single-flight (#350) (a0b85a7)
- **sync**: distinguish visibility probes from real recovery (#350) (27699df)
- **sync**: tighten workspace refresh bridge types (882f678)
- **ui**: deduplicate space navigation entry (290e8dd)
- **ui**: load space action trigger guard (52450c0)
- **ui**: hide legacy transfer floating trigger (bbb6788)
- **ui**: move space actions into navigation rail (bc32d3e)
- **ui**: consolidate space actions into compact launcher (24ae016)
- **editor**: clarify block indent shortcuts (#327) (b61dc13)
- **editor**: render code block indent on NodeView (#327) (5c08f2e)
- **electron**: validate updater release assets (#329) (7b39915)
- **siyuan**: keep rich-text indexes consistent after import (#284) (9e3b805)
- **embed**: keep sandbox and fallback state synchronized (#284) (e958bbd)
- **markdown**: hide standalone SiYuan block IAL rows (#284) (4cfc5bf)
- **siyuan**: finalize rich-text imports with explicit safe mappings (#284) (06dc638)
- **siyuan**: harden rich-text mappings for imported advanced nodes (#284) (ded13ea)
- **siyuan**: canonicalize real callout and IAL AST nodes (#284) (f975e3d)
- **embed**: require password handshake and expose safe fallback (#284) (8b010fd)
- **markdown**: keep semantic preview blocks intact (#284) (2de3d82)
- **markdown**: normalize imported SiYuan callouts (#284) (ae94cc5)
- **note-transfer**: require interactive safe move execution (#325) (a15bb2c)
- **note-transfer**: keep content text references aligned (#325) (830f995)
- **note-transfer**: require complete move preview versions (#325) (37f883d)
- **note-transfer**: install active-workspace refresh bridge (#325) (6c0b7ed)
- **note-transfer**: refresh active workspace after transfer (#325) (ec59051)
- **note-transfer**: await object-storage preview and execution (#325) (9ac3a3d)
- **note-transfer**: require attachment-safe move semantics (#325) (17c82e2)
- **note-transfer**: bridge note link index synchronization (#325) (584ba3f)
- **note-transfer**: bridge attachment reference synchronization (#325) (37a7541)
- **note-transfer**: use UUID link fixtures and initialize audit schema (#325) (4622c33)
- **note-transfer**: correct preview link counts and blocker statuses (#325) (098b410)
- **upload**: finish offline image uploads deterministically (#331) (1bf9451)
- **android**: enable WebView long-press text selection (#335) (cf352e6)
- **android**: restore editor text selection actions (#335) (4b9a79c)
- **android**: install editor media scope guard before app mount (#338) (91d5525)
- **android**: isolate non-editor media buttons from editor bridge (#338) (8120ce7)

### ⚡ 优化

- **ai**: scope index copy observer to settings panel (2bad49f)
- **frontend**: scope sidebar search observer to relevant nodes (1ea704d)
- **blocks**: unify mixed patch index updates (a595ffd)
- **blocks**: incrementally index top-level structural patches (563f8f8)
- **blocks**: update leaf patch indexes incrementally (f6343e2)
- **editor**: suppress optimized-mode outline rescans (9b6fa97)
- **editor**: cache ProseMirror plain-text snapshots (8b7b831)
- **editor**: stop realtime full-document search rescans (c040f6a)
- **editor**: defer math node rendering by runtime mode (84b4c46)
- **markdown**: bypass legacy full-text diff during incremental sync (9c8d4f5)
- **editor**: limit code highlighting to active viewport (5775cfd)
- **editor**: stop code-block scans in lightweight mode (5935b18)
- **editor**: measure note fetch and runtime policy stages (90f91fb)
- **editor**: lazy-load offscreen rich-text images (c985498)
- **editor**: disable code highlighting in lightweight mode (0635080)
- **sidebar**: make notebook creation optimistic (#344) (4be7b08)
- **sidebar**: make notebook creation optimistic (b6f10c9)
- **editor**: optimize code block input and save acknowledgment (#342) (c72c971)
- **editor**: optimize code block input and save acknowledgment (39120f1)

### ♻️ 重构

- **ai**: mount embedding index task copy bridge (03d1bc6)
- **ai**: clarify embedding index task copy (d69501b)
- **tree**: group create and import actions (8e99702)
- **sidebar**: delete legacy notebook directory implementation (a8b5804)
- **layout**: retire manage mode and list-toggle shortcut (2bc0913)
- **shortcuts**: remove retired note-list layout shortcut (f1fd25d)
- **commands**: retire legacy note-list layout command (e2078cb)
- **navigation**: remove legacy all-notes directory entry (790fb77)
- **frontend**: handle all sidebar search surfaces safely (5aca659)
- **frontend**: mount unified sidebar search experience (d3e2ddb)
- **frontend**: install sidebar search compatibility bridge (16aa13c)
- **frontend**: retire duplicate sidebar search field (c613e18)
- **frontend**: remove legacy notebook tree toggle (0897353)
- **knowledge-tree**: preserve base schema helper for trigger hardening (ae49e45)
- **permissions**: preserve capability core for workspace ownership fix (50d43b8)
- **knowledge-tree**: preserve core service for listing fix (fce65cc)
- **code-block**: keep language setup in view dependency (a0939da)
- **editor**: use scoped list move operations (7908287)
- **editor**: scope list item moves (4beee4e)
- **blocks**: use scoped list move protocol (99d8465)
- **blocks**: scope list hierarchy moves (37207c8)
- **attachments**: remove retired image host wording (5e72f3f)
- **attachments**: remove third-party image hosting (f128192)
- **image-hosting**: route legacy config through repository (faf015f)
- **frontend**: 简化笔记列表拖放目标解析逻辑 (19d1661)
- **upload**: remove image-host-specific timeout constants (9dac0ac)
- **api**: remove retired image-host upload override (2e7cb0a)
- **image-hosting**: remove retired fallback policy service (146b6be)
- **image-hosting**: remove retired S3 image host service (4ec7bc7)
- **frontend**: 简化笔记本排序偏好存储并优化刷新按钮锚点 (ae33d88)
- **image-hosting**: retire upload API and preserve migration metadata (976f78c)
- **attachments**: retire third-party image upload path (be940fb)
- **navigation**: expose connection actions through account menu (473e416)
- **desktop**: turn server center into connection and account flow (d840e4e)
- **migration**: remove superseded light migration engine (dfc518c)
- **migration**: remove legacy cloud migration dialog (46c8ada)
- **desktop**: move server management into account flow (86fa803)
- **editor**: share Tiptap derived runtime policy (f53bab1)
- **editor**: isolate Tiptap derived runtime policy (e822a71)
- **editor**: unify markdown safe mode with runtime policy (17f945c)
- **releases**: share cached release lookup with updater (#330) (bab11a4)

### 📝 文档

- 设计知识树滚动条视觉方案 (25ac654)
- **perf**: document issue 210 cross-platform sign-off (7c74301)
- **sdk**: show Markdown create and update flows (882b980)
- **api**: document native Markdown note contract (c74a609)
- 设计移除视口优化提示 (fc18197)
- 编写移除侧栏账号入口计划 (3aff5ee)
- 设计移除侧栏账号入口 (16bcc6a)
- 编写移除连接与迁移功能计划 (9833ddc)
- 设计移除连接与迁移功能 (180bfd5)
- 编写拆分文档菜单实现计划 (6039616)
- 设计拆分文档入口移入更多菜单 (bac901e)
- 更新 M6～M7 灰度与代际说明 (ba91868)
- 添加 M6～M7 实施计划 (54e1e70)
- 固化 M6～M7 灰度演进设计 (c4dfd0c)
- **blocks**: document safe inline images V2-J (170c8be)
- **blocks**: document list item structure patches V2-I (737491a)
- **blocks**: describe list item structure patches (3514376)
- **blocks**: document list subtree index mode (8bab906)
- **blocks**: document list subtree index updates (b50490d)
- **blocks**: clarify list attrs and subtree planning (bbb96dc)
- **blocks**: document list hierarchy patch V2-G (7c8d442)
- **blocks**: describe controlled list hierarchy patches (1bba45f)
- **blocks**: record no-history empty Block reconciliation (f6e43ea)
- **blocks**: document empty document reconciliation V2-E (6f77735)
- **blocks**: record empty document reconciliation (66b6044)
- **blocks**: document mixed index patch V2-D (126da74)
- **blocks**: document structural index patch V2-C (ff34ed4)
- **blocks**: document incremental index updates (e9e7d97)
- **blocks**: document rich replacement patch V2 (c7dcfb0)
- **env**: remove legacy image hosting wording (b74ca53)
- **attachments**: document image-hosting retirement and migration (c97f32e)
- **desktop**: document connection-first server workflow (7e59384)
- **blocks**: document grey-save safety boundaries (b89a148)
- **blocks**: document Tiptap grey rollout (4bd7883)
- **blocks**: clarify user-level idempotency keys (8aa9a85)
- **blocks**: document Block Patch API V1 (658e547)
- **block-links**: document split redirect behavior (ade6961)
- **note-split**: record Tiptap split implementation (f180963)
- **note-split**: assess rich-text heading split (a1b3106)
- **readme**: use HTTP official and demo addresses (cac88e4)
- **tutorials**: update web guide and HTTP links (88c222d)
- **tutorials**: refresh quick start workflow (b41af29)
- **tutorials**: rebuild current help center index (b72d9cc)
- **readme**: distinguish official website and demo (42ec2d4)
- **readme**: align English project guide (ee25ab6)
- **readme**: rewrite project overview and deployment guide (6b108df)
- **docker**: update deployment and online upgrade workflow (#330) (e02e7fa)
- **updater**: add security and recovery guide (#330) (ec9b6ce)
- **docker**: document updater environment controls (#330) (2cb50aa)

### 💄 样式

- **frontend**: distinguish tree filtering from global search (b1b3ba0)
- **sdk**: remove accidental BOM (3b95332)

### ✅ 测试

- **import**: cover SingleFile HTML normalization (f23cb6a)
- **ai**: cover embedding index task copy (e74fe59)
- **tree**: lock web scrollbar runtime contract (e629c57)
- **tree**: cover custom scrollbar geometry (ee5570b)
- **tree**: lock visible desktop scrollbar contract (0b9be0c)
- **tree**: lock inline create interaction contract (c129362)
- **tree**: cover inline create title helpers (e75cb19)
- **sidebar**: accept simplified unified sidebar root guard (e1a39e3)
- **shortcuts**: remove legacy note-list shortcut expectations (842c8a7)
- **layout**: cover unified-tree-only migration and view policy (a93a7d7)
- **layout**: align editor workspace tests with unified tree (68fc21d)
- **mobile**: run note search launcher in jsdom (8d18b79)
- **mobile**: cover note search launcher sequencing (2634ceb)
- **frontend**: run knowledge tree sort tests in jsdom (4a4c05e)
- **frontend**: cover unified knowledge tree sorting (5fea266)
- **frontend**: cover sidebar search scope cleanup (134e30f)
- **electron**: cover markdown encoding detection (693d89d)
- **editor**: align format painter fixtures with schema (a24b726)
- **issue-455**: add one-shot schema fixture correction (c4441d3)
- **issue-455**: add schema-correct test fix (dfaf622)
- **editor**: protect format painter UI integration (444c4cc)
- **editor**: cover safe format painter behavior (85a9df8)
- **android**: cover Markdown immersive editing (d009e44)
- **android**: add immersive editor regression gate (90b6a7b)
- **knowledge-tree**: cover context menu capability matrix (2bc1d26)
- **shortcuts**: verify cleared bindings remove tooltip hints (bfcc334)
- **shortcuts**: model the real ProseMirror editor root (3556083)
- **shortcuts**: verify exported platform document (d9c3477)
- **shortcuts**: cover persistence validation and reset (5e002f9)
- **note-split**: destroy Yjs rooms during database cleanup (7045e4a)
- **note-split**: close database after backend suite (d29647a)
- close shared database after backend suites (4410050)
- **knowledge-tree**: trace subtree restore steps (268906b)
- **knowledge-tree**: expose failing operation phase (2c44357)
- **postgres**: cover v64 structural guard (9d25391)
- **knowledge-tree**: expect v64 structural guard schema (d20f55e)
- **postgres**: verify document-parent preservation trigger (f636ded)
- **knowledge-tree**: expect v63 legacy sync schema (1dcd713)
- **knowledge-tree**: verify complete subtree restore (8a55a79)
- **permissions**: prevent workspace creators from becoming node admins (b9a4886)
- **knowledge-tree**: avoid CommonJS top-level await (714117f)
- **shares**: mount named management router (#447) (7eeb53d)
- **shares**: cover management HTTP contract (#447) (0a42d22)
- **perf**: require complete issue 210 stability evidence (ca82c66)
- **perf**: focus the synthetic editor before save sampling (fe2c575)
- **shares**: use repository React DOM harness (#447) (4f8daeb)
- **perf**: cover issue 210 sign-off validator (12393b9)
- **shares**: stabilize page API mock (#447) (7ab181e)
- **perf**: cover issue 210 runtime collector (0a647b2)
- **shares**: cover management page rendering and filters (#447) (7cc830d)
- **shares**: cover management presentation helpers (#447) (9ee4f0e)
- **shares**: cover management filtering and access (#447) (c03b10e)
- **issue-370**: cover workspace layout helpers (a4dd3d1)
- **api**: cover authorized shared notebook subtree (45724fc)
- **sidebar**: cover shared notebook hierarchy (5f0040b)
- **block-patch**: align gate with current protocols (#355) (cb4b829)
- **editor**: cover initialization timeout downgrade (be1138d)
- **tags**: cover idempotent scoped creation (f9d7f89)
- **tags**: cover scoped uniqueness migration (bfa3f52)
- **sdk**: cover Markdown note API contract (49f9da4)
- **code-block**: separate case and autodetect checks (30f07a0)
- **code-block**: cover MAXScript picker label (f1252fc)
- **markdown**: cover MAXScript fences (89c5b0a)
- **code-block**: cover MAXScript registration (304fec0)
- **import**: require current admin role for permission undo (348e513)
- **export**: resolve data manager workspace scope (dc31740)
- **import**: read postgres import batch migration (e8cfe39)
- **import**: verify postgres permission schema contract (beea4ac)
- **import**: accept normalized markdown block ids (ecf8229)
- **import**: cover permission review and request payloads (1504186)
- **import**: cover v2 permission transfer and undo (e113372)
- 修正窗口化选择测试类型 (8d1387c)
- **editor**: send inline image Block patches (9baa4e8)
- **blocks**: cover image replacement route transactions (e1bfdba)
- **editor**: plan inline image Block replacements (f5d7e15)
- **blocks**: cover inline image replacement patches (71d005d)
- **editor**: type list structure API fixtures (88d77a2)
- **editor**: cover list structure API contract (8bba0ac)
- **editor**: reject conflicting list structure identities (f47d223)
- **blocks**: keep truly unrelated rows stable (0b45e11)
- **editor**: send list item structure Block patches (efb6bca)
- **editor**: cover list item structure planning (6042f6e)
- **blocks**: cover list item structure patch transactions (2cbc3d2)
- **blocks**: cover controlled list item structure patches (9e9c72d)
- **editor**: accept list subtree index responses (bbc26aa)
- **blocks**: cover incremental list subtree indexes (af01cba)
- **editor**: cover list moves with large subtrees (7acdd84)
- **editor**: align deterministic adjacent list move (40817fe)
- **editor**: cover ordered attrs and equivalent list moves (0df7ee7)
- **blocks**: preserve ordered list attrs on sink (86f86f6)
- **editor**: fall back after rejected list moves (5ef3b88)
- **editor**: send list hierarchy Block patches (c7cd8de)
- **blocks**: cover list hierarchy patch transactions (1e62559)
- **editor**: cover controlled list hierarchy planning (77e9349)
- **blocks**: cover controlled list hierarchy moves (b6411ba)
- **editor**: preserve undo across empty Block ID reconciliation (844c753)
- **editor**: expect empty document Block patch (d7a890b)
- **editor**: reconcile server empty Block identity (5099932)
- **editor**: plan empty document Block reconciliation (a7c48b2)
- **ai**: isolate embedding queue hardening cases (48ad3b5)
- **blocks**: cover create-then-move mixed identities (b1a6309)
- **editor**: align rich planner with unified top-level batches (556dd53)
- **ai**: cover embedding queue recovery (9c27cde)
- **blocks**: cover mixed incremental patch indexes (5988237)
- **editor**: plan rich mixed structural batches (9c7aa5b)
- **editor**: expose structural index update kind (b746651)
- **blocks**: cover incremental top-level structural indexes (901bde7)
- **blocks**: expose incremental index response metadata (b24d0b2)
- **blocks**: cover ancestor and type index updates (c36c785)
- **blocks**: cover incremental patch indexes (752523c)
- **blocks**: type route V2 count assertions (38380c2)
- **editor**: route rich block changes through patch V2 (c36e630)
- **editor**: plan safe rich block replacements (cb0da33)
- **blocks**: cover rich replacement transactions (9c5fe01)
- **blocks**: cover safe rich block replacements (5e4af1c)
- **image-hosting**: enforce repository-backed legacy cleanup (fb6c991)
- **image-hosting**: verify retired backend surface (abc9c75)
- **attachments**: lock third-party image hosting retirement (b7be8cc)
- **desktop**: cover connection-first server navigation (d0950c8)
- **import**: cover permission mapping client requests (5320cfc)
- **import**: cover permission export and guarded mapping (d3d058b)
- **editor**: cover rich node fallback classification (aa835bc)
- **editor**: cover rich block patch planning (81e9206)
- **blocks**: cover rich block replacements (5decf7c)
- **blocks**: preserve version history transactionally (3e4955d)
- **editor**: scope Block Patch runtime to owning note (8998259)
- **editor**: keep delete-all on whole-save fallback (a6d510c)
- **editor**: serialize title saves after Block Patch (dfc3cd1)
- **editor**: keep public Tiptap outside AppContext (47bbdc6)
- **editor**: cover Tiptap Block Patch runtime shell (efca5d1)
- **blocks**: cover authoritative patch response (bea1d9d)
- **blocks**: assert authoritative patch snapshots (332e46e)
- **editor**: cover Block Patch rollout policy (0aa797a)
- **editor**: cover safe Tiptap patch planning (486e1bc)
- **blocks**: reject cross-note operation ID reuse (666d9f4)
- **blocks**: cover confirmed frontend patch client (3e7d6b5)
- **blocks**: keep nested containers valid after patch deletes (8aa6696)
- **blocks**: cover atomic batch patch route (a64a716)
- **blocks**: cover pure Tiptap batch patch engine (213d8a8)
- **editor**: cover optimized Tiptap derived policy (06d61d8)
- **editor**: cover immutable derived snapshot cache (7fdf233)
- **editor**: cover Tiptap derived runtime aliases (a260aa7)
- **editor**: mirror runtime shell aliases in vitest (c833f4b)
- **editor**: avoid decoration implementation details (f2812d9)
- **editor**: cover lightweight search runtime policy (6a0f04d)
- **editor**: cover deferred math rendering (98d53ab)
- **block-links**: cover Markdown split redirects (0d34e72)
- **block-links**: cover redirected client navigation (df31de1)
- **block-links**: exercise a real two-hop block chain (fd6c0e1)
- **block-links**: cover split redirect resolution (8b90ab2)
- **note-split**: cover empty Tiptap chapter bodies (1f1dba8)
- **note-split**: cover rich-text risk confirmation (0418f31)
- **note-split**: cover Tiptap preview boundaries (2642e35)
- **note-split**: cover Tiptap planning and transactions (77a9f95)
- **note-split**: strip persisted block ids from titles (527622c)
- **note-split**: strip heading block ids in preview (728f028)
- **note-split**: verify valid directory backlinks (b9b5c1f)
- **note-split**: submit selected chapter indexes (5a80f1b)
- **note-split**: cover selected chapters and retained attachments (b961ee7)
- **docker**: guard hardened backup entrypoint (#352) (d1b97ad)
- **note-split**: preserve markdown line breaks while stripping block ids (bf61383)
- **note-split**: compare restored markdown semantically (f9265ba)
- **note-split**: verify transactional split attachment and undo flow (c9f4ed4)
- **editor**: verify format-aware mode staging (1601cca)
- **desktop**: cover markdown editor selection (bcca496)
- **note-split**: cover client split preview (6470ea1)
- **note-split**: cover markdown split planning (726172c)
- **markdown**: validate real Y.Text event deltas (a6fe049)
- **markdown**: cover incremental collaboration runtime (27b60f9)
- **editor**: make bilibili paste assertion resilient (86df640)
- **editor**: cover bilibili link paste embedding (52fefbd)
- **markdown**: cover incremental Y.Text mapping (ecd9414)
- **markdown**: cover viewport editor routing (44806ec)
- **markdown**: cover stale-safe worker controller (f4b4215)
- **markdown**: cover worker-safe analysis (63e933b)
- **editor**: stabilize deferred media node coverage (f2c64d3)
- **editor**: cover deferred video and mermaid shells (290361e)
- **editor**: cover interaction-gated heavy nodes (016bce8)
- **editor**: make viewport highlight timing deterministic (817cc0e)
- **editor**: cover runtime notice session restore (231d552)
- **editor**: cover viewport-scoped code highlighting (57cb100)
- **editor**: correct structural node expectation (41034f0)
- **editor**: avoid global act environment type conflict (2454d09)
- **editor**: cover heavy-node viewport activation (46000bb)
- **editor**: run runtime store tests in jsdom (ae53012)
- **editor**: cover progressive rich-text routing (351c580)
- **editor**: cover runtime store and capability changes (df7c4ad)
- **editor**: cover progressive runtime modes (4c91d39)
- **editor**: cover rich-text safe mode thresholds (206e28a)
- **search**: cover full-text spinner animation fallback (64b3678)
- **search**: cover sidebar spinner animation (f220471)
- **search**: cover buffered sidebar input policy (2996e2b)
- **search**: cover progressive query delay (b35dba6)
- **search**: cover progressive short query policy (2dc881a)
- **editor**: cover large Markdown safe mode thresholds (920c448)
- **editor**: add large Markdown freeze reproducer (e669742)
- **android**: 修正 findLast 回调类型约束 (02354e3)
- **android**: 稳定旧 WebView 编辑器兼容用例 (fcea8d9)
- **editor**: 覆盖 WebView 兼容错误提示 (6a76d22)
- **android**: 覆盖旧 WebView Tiptap findLast 回归 (43aaef0)
- **editor**: remove obsolete task DOM identity test (#361) (dae12bc)
- **editor**: guard against task list observer loops (#361) (7100c33)
- **sync**: cover failed recovery without success signal (#350) (2faed86)
- **sync**: cover visibility and real recovery states (#350) (3b3ba30)
- **editor**: cover code block NodeView indent (#327) (94665ce)
- **electron**: reject stale updater binaries (#329) (8dfd0e7)
- **embed**: cover acknowledged cross-origin password delivery (#284) (37ade57)
- **siyuan**: make issue 284 fixture path runner-independent (#284) (81e5697)
- **embed**: use the active jsdom origin (#284) (f6c4372)
- **siyuan**: align fixture block IDs with Spec 2 (#284) (665ca16)
- **siyuan**: cover issue 284 package import end to end (#284) (1691f73)
- **siyuan**: document issue 284 regression fixture (#284) (7a8beb1)
- **siyuan**: add valid issue 284 SiYuan AST fixture (#284) (b4f80e5)
- **embed**: cover DOM fill and password-free handshake offer (#284) (2dc9d14)
- **markdown**: render live callouts through real preview (#284) (0750027)
- **markdown**: cover imported callout aliases and IAL (#284) (8cb604b)
- **note-transfer**: cover preview guard and reference alignment (#325) (e1f8c87)
- **note-transfer**: await staged attachment transfers (#325) (585835d)
- **note-transfer**: cover cross-workspace copy and move (#325) (d1f835c)
- **android**: cover editor selection fallback decision (#335) (a4a92d2)
- **android**: cover Diary and editor media scope isolation (#338) (64aa10e)
- **updater**: cover image restrictions and config preservation (#330) (9b093e0)

### 📦 构建

- **blocks**: register batch patch route (d0befe3)
- **editor**: route Tiptap derived reads through runtime guards (1357974)
- **editor**: route math and search through runtime shells (e0a5a2b)
- **markdown**: emit classic analysis worker (64d2934)

### 🤖 CI

- **ai**: add embedding index copy regression gate (340e634)
- **issue-455**: upload typecheck diagnostics (82fb71e)
- **issue-455**: upload focused test diagnostics (011597b)
- **issue-455**: add permanent safe format painter gate (aca37ce)
- **knowledge-tree**: finalize context-menu regression gate (29f8f9c)
- **issue-468**: add one-time duplicate declaration fix runner (56a30af)
- **issue-468**: add one-time panel syntax fix runner (2ffd638)
- **knowledge-tree**: publish context-menu typecheck diagnostics (c9e3ede)
- **knowledge-tree**: cover restored context-menu capabilities (3d14924)
- **issue-468**: add controlled context-menu patch runner (5716cd7)
- **shortcuts**: use the repository typecheck command (93e5970)
- **shortcuts**: expose typecheck diagnostics (a0ac34f)
- **shortcuts**: minimize diagnostic setup output (09adfe9)
- **shortcuts**: keep failure logs compact (e1db641)
- **shortcuts**: run registry and override tests (ead8420)
- **knowledge-tree**: remove temporary Yjs patch job (7947c40)
- **note-split**: force exit after known tests finish (7eb1f2c)
- **note-split**: restore focused regression gate (9a01c57)
- **issue-370**: patch Yjs flush from branch workflow (4e1dd65)
- **note-split**: patch no-op Yjs flush before regression gate (f2e176c)
- **issue-370**: run Yjs patch on PR updates (5262d90)
- **issue-370**: apply Yjs no-op flush fix (5fcc533)
- **note-split**: expose failing test tail in diagnostics (cc747a4)
- **note-split**: print focused timeout diagnostics (098efac)
- **note-split**: expose per-suite failure status (8ea7449)
- **note-split**: publish bounded failure diagnostics (d996f02)
- **note-split**: upload diagnostics only on failure (2b6c76a)
- **note-split**: bound and isolate backend diagnostics (a56e32e)
- **note-split**: capture backend failure diagnostics (442329c)
- **knowledge-tree**: retrigger validation after restore fix (eecae9a)
- **knowledge-tree**: publish backend failure diagnostics (e2db313)
- **knowledge-tree**: report branch validation to epic (f6d8e5d)
- **knowledge-tree**: validate feature branch before PR (b6596c8)
- **shares**: document final V1 gate (#447) (22d174b)
- final sync main for issue 447 (cf4fcae)
- **shares**: retain backend diagnostics (#447) (31e34fe)
- **shares**: add management route contract test (#447) (ec9d753)
- sync latest main for issue 447 (d972108)
- **shares**: add share management regression gate (#447) (339a896)
- apply and verify issue 210 sign-off hardening (5d0f360)
- rerun issue 447 with nullable title fix (f7098b8)
- align issue 447 nullable note title (d2296d7)
- capture issue 447 TypeScript diagnostics (5ad96e0)
- upload issue 210 test diagnostics (6fee820)
- verify issue 210 performance sign-off tooling (89173fc)
- capture issue 447 frontend diagnostics (54e2eb4)
- rerun issue 447 bootstrap after test fix (7acb151)
- verify issue 447 implementation (f365a99)
- bootstrap issue 447 integration (d9ae8bf)
- **issue-370**: add layout and split checks (fa4d40e)
- bootstrap shared notebook tree patch (9127715)
- **issue-355**: sync latest main before final review (812c26f)
- **issue-355**: complete api mock shape (c77c0b2)
- **issue-355**: capture gate repair failures (83c6fb6)
- **issue-355**: repair and verify block patch gate (6bf5c73)
- **issue-355**: upload diagnostic logs (737ea8b)
- **issue-355**: diagnose block patch regression (19cb0f8)
- **issue-355**: include REST content-view contract test (ad26977)
- **editor**: add initialization timeout regression gate (5fbf00a)
- **issue-355**: verify API and projection boundaries (18f0080)
- **issue-355**: add content-format regression gate (0e23b2a)
- **issue-355**: commit verified source outside workflow paths (c172a05)
- **issue-355**: checkout source branch before rework (097f1e0)
- **issue-355**: allow PR-triggered verified rework (b998e9f)
- **issue-355**: run verified content-format rework (4980176)
- **tags**: add idempotency regression gate (d2e6f65)
- **sdk**: finalize read-only contract gate (7a6afca)
- **sdk**: capture contract test diagnostics (bb665e6)
- **sdk**: report build diagnostics on pull requests (a771393)
- **sdk**: split build and contract test steps (c4b72de)
- **sdk**: add public API contract gate (3b1849c)
- **search**: add regression gate for issue #340 (84da9c4)
- **code-block**: remove temporary diagnostics workflow (1d61f7a)
- **code-block**: split case and autodetect checks (6e385b2)
- **code-block**: isolate MAXScript grammar checks (9b8ef72)
- **editor**: isolate MAXScript validation steps (b639a7b)
- **editor**: validate code-block language extensions (4e9af99)
- **import**: cover permission undo authorization (09d9ae7)
- **import**: watch primary package import flow (627a794)
- **import**: validate postgres permission schema contract (83476d5)
- **import**: validate permission transfer v2 (c8b4c22)
- **blocks**: cover image route and runtime integration (1e9edc2)
- **blocks**: cover inline image Block patches (0c9fddf)
- **editor**: allow manual focused workflow runs (04873f4)
- **blocks**: allow manual focused workflow runs (8df1925)
- **blocks**: cover list structure client contract (c9caaf2)
- **blocks**: cover list item structure patches (69aaa01)
- **blocks**: cover list subtree index planning (6f67bd5)
- **blocks**: cover controlled list hierarchy patches (32bf59b)
- **blocks**: cover no-history empty Block reconciliation (8e1884b)
- **blocks**: cover empty document reconciliation (ac85394)
- remove embedding queue trigger (2e4276d)
- **blocks**: cover mixed incremental indexes (de71d75)
- remove one-shot embedding queue script (c3c2408)
- remove one-shot embedding queue workflow (8342a80)
- prepare embedding queue fix run (79d0d45)
- trigger embedding fix from merge push (d442816)
- run embedding queue fix validation (70bab12)
- add one-shot embedding queue fix script (6d6923f)
- replace embedding queue validation workflow (b1c9012)
- validate embedding queue recovery fix (4b3b02c)
- **blocks**: cover incremental patch indexes (be473a6)
- **blocks**: cover rich replacement patch V2 (d284ca8)
- remove verified removal artifact workflow (e99393a)
- remove one-shot image hosting removal workflow (7468644)
- **pg**: remove obsolete image hosting validator (2567b69)
- **pg**: remove image hosting final-sync hooks (da786d5)
- **pg**: remove image hosting restoration hooks (6522627)
- apply verified image hosting removal artifact (fc562cb)
- include verified hidden removal bundle (b03d15d)
- publish verified image hosting removal artifact (3e0b8ff)
- publish verified image hosting removal to result branch (d8647b4)
- trigger image hosting removal from one-shot PR (27b1bf6)
- trigger image hosting removal from issue comment (d87d7ba)
- trigger complete image hosting removal (ca67e21)
- add one-shot image hosting removal workflow (c3fe58d)
- **image-hosting**: remove retired migration trigger (710d7f1)
- **image-hosting**: remove retired migration workflow (e1372dc)
- **import**: validate round-trip permission mapping (f6f9ec7)
- **pg**: remove temporary round-trip C-1 validator (7f48e5a)
- **pg**: validate round-trip C-1 through pull requests (2ff7d15)
- **pg**: add round-trip batch metadata migration gate (a3e9342)
- **editor**: cover public Tiptap runtime context (a3aa9ed)
- **blocks**: cover public Tiptap context isolation (617877e)
- **editor**: run Tiptap Block Patch shell test (ab7395e)
- **pg**: use final synchronization gate on stable trigger (16c4dba)
- **blocks**: run Tiptap runtime shell regression (fa34f26)
- **pg**: add final latest-main synchronization gate (23c6f14)
- **editor**: cover Tiptap Block Patch rollout (5ed495f)
- **blocks**: validate Tiptap grey rollout (a44da36)
- **pg**: validate image hosting migration batch (afb021b)
- **pg**: trigger image hosting runtime migration (0063229)
- **pg**: add deterministic image hosting migration runner (f36b25a)
- **pg**: finalize image hosting runtime migration (38d013e)
- **pg**: migrate image hosting settings through runtime repository (a56ff09)
- **pg**: sync main from verified Yjs fix head (ce93fc1)
- **pg**: make Yjs fix resilient to indentation (295df2c)
- **pg**: apply verified Yjs fix to migration branch (7686e2a)
- **pg**: fix Yjs no-op version accounting (cf8e02e)
- **pg**: add note split undo diagnostics (ae5046e)
- **blocks**: validate frontend patch contract (6274d03)
- **pg**: rerun synchronized main validation with Yjs fix (bb1b3dc)
- **blocks**: validate batch patch engine and route (f21084c)
- **pg**: patch Yjs version semantics during synchronization (847bca2)
- **pg**: push Yjs fix before validation (112d6bf)
- **pg**: validate Yjs fix before main synchronization (86cda5b)
- **editor**: cover Tiptap derived runtime guards (0853664)
- **pg**: trigger Yjs fix from sync PR comment (16e198f)
- **pg**: trigger Yjs version fix (dd741ad)
- **pg**: add one-shot Yjs version fix runner (73b001a)
- **pg**: trigger synchronized main validation (023cc1a)
- **pg**: add deterministic push trigger for synchronization (cf12b08)
- **pg**: make main synchronization deterministic (d09ab16)
- **editor**: trigger when runtime test aliases change (3d25d41)
- **editor**: cover math and search runtime shells (4dc2f45)
- reconcile remaining main sync regressions (ee6de23)
- **block-links**: cover split redirect resolution (5ac89be)
- preserve reconciled PG files and upload SQLite diagnostics (a7fabd5)
- rerun failed SQLite files with detailed diagnostics (443d873)
- **note-split**: include empty Tiptap chapter regression (baa84b3)
- publish SQLite regression diagnostics during PG sync (3cae1d2)
- **note-split**: cover Tiptap split workflow (1bb24b1)
- publish PostgreSQL schema parity diagnostics during sync (4944f8e)
- publish SQLite boundary diagnostics during PG sync (87547f2)
- preserve reconciled PostgreSQL files during main sync (fcd0543)
- publish PostgreSQL sync status to fixed comment (d4436cc)
- validate token resources during PostgreSQL branch sync (cbc7995)
- include merged token route source diagnostics (5bcdfbb)
- **note-split**: include title normalization test (337ff12)
- publish PostgreSQL sync typecheck diagnostics (4acf57f)
- add one-time main to PostgreSQL branch sync workflow (0dee261)
- **note-split**: cover selected chapter workflow (6ecdca7)
- **note-split**: add frontend and backend regression workflow (cea8ecf)
- **markdown**: cover incremental Y.Text synchronization (4442bfb)
- **markdown**: cover viewport worker analysis (d28b4d0)
- **editor**: cover deferred media runtime shells (6ace8a5)
- **editor**: cover viewport highlight and runtime notice (31eabf1)
- **editor**: include code highlight runtime regression (6d249fb)
- **editor**: add progressive runtime regression checks (05f57a3)

### 🔧 其他

- ignore frontend/dist.bak build backup (e36b8dc)
- **issue-455**: remove one-shot nested block workflow (74ee0ec)
- **issue-455**: remove one-shot hook scope workflow (54a6b16)
- **issue-455**: remove one-shot test fixture workflow (7ba0e8b)
- **issue-455**: remove one-shot hook-order workflow (f379594)
- **issue-455**: remove one-shot format painter workflow (05db9d6)
- **issue-455**: add one-shot format painter integration workflow (b465f0b)
- **issue-455**: add controlled format painter integration (cadc116)
- **android**: remove one-shot immersive focus workflow (9a9640a)
- **android**: add one-shot immersive toolbar focus integration (b276f81)
- **android**: add final immersive toolbar focus fix (4afdfb8)
- **android**: remove one-shot Markdown cutover workflow (d5c22e0)
- **android**: add one-shot Markdown immersive integration (5fdbffa)
- **android**: add one-shot Markdown immersive patch (9fc2dcc)
- **editor**: remove one-shot immersive cutover workflow (cbd0974)
- **editor**: use unique immersive editor patch anchor (be543e4)
- **editor**: capture immersive patch diagnostics (41da241)
- **editor**: add one-shot Android immersive editor integration (cfc5515)
- **editor**: add one-shot Android immersive editor patch (736b964)
- **issue-468**: remove one-time duplicate declaration workflow (e578ac3)
- **issue-468**: add one-time duplicate declaration fix (a427634)
- **issue-468**: remove one-time panel syntax workflow (72a5a2a)
- **issue-468**: add one-time panel syntax fix (1a9e6bc)
- **issue-468**: remove one-time context-menu patch workflow (d442a4e)
- **issue-468**: add controlled context-menu integration patch (882e983)
- **shortcuts**: remove one-shot customization workflow [skip ci] (93486dd)
- **shortcuts**: run one-shot patch from pull request (9df5a13)
- **shortcuts**: run one-shot customization patch (a3640c0)
- **shortcuts**: add one-shot patch script (7e7ba35)
- **shortcuts**: trigger integration patch (b84a2d6)
- **shortcuts**: add one-shot customization patch (756daa7)
- **issue-370**: remove temporary Yjs auto-fix workflow (0e62ddd)
- **issue-370**: remove temporary Yjs patch workflow (18a614c)
- **issue-370**: add temporary Yjs flush auto-fix workflow (efe131d)
- **knowledge-tree**: remove restore diagnostics (e369ccc)
- **shares**: remove final main sync workflow (8b6c4f7)
- **shares**: remove temporary main sync workflow (3662257)
- **perf**: remove temporary issue 210 hardening script (d72b969)
- **shares**: remove temporary bootstrap workflow (5da94f4)
- **ci**: remove temporary issue 210 hardening workflow (8e4f66e)
- **shares**: remove temporary type fix script (de3f8a2)
- **shares**: remove temporary integration script (6bbc49f)
- **perf**: add temporary issue 210 hardening patch (d055f96)
- **ci**: remove temporary issue 210 verification workflow (cc32b32)
- **perf**: add issue 210 sign-off commands (9d11b4a)
- remove issue 365 bootstrap workflow (e643850)
- remove issue 365 bootstrap script (8b6dd61)
- add issue 365 branch patch bootstrap (34b92a7)
- **issue-355**: remove temporary main sync workflow (6247e08)
- **issue-355**: remove temporary gate repair workflow (6231c90)
- **issue-355**: remove temporary gate repair script (4327dd5)
- **issue-355**: add block patch gate repair script (c49c31b)
- **issue-355**: remove temporary boundary script (4cfbc78)
- **issue-355**: remove temporary boundary workflow (e9fe614)
- **issue-355**: add boundary verification script (3f968ee)
- **issue-355**: remove temporary rework script (a27d704)
- **issue-355**: remove temporary rework workflow (1e50013)
- **issue-355**: add verified rework script (1cd94f3)
- remove accidental file (3dc9740)
- remove accidental placeholder (573c1ae)
- placeholder (7634ac7)
- **import**: sync permission centers with latest main (4397551)
- remove unused search hotfix workflow (a0133bd)
- apply search input hotfix on main (56a8f4b)

### ⏪ 回滚

- remove accidental placeholder file (fcbe300)

### 📌 杂项

- placeholder (072420e)
- 优化分享管理的公开地址风险提示 (#457) (6649fcf)
- noop (9310bde)


## v1.4.1 - 2026-07-17

### 📝 文档

- design markdown live preview image auth fix (eaf611e)

### 🤖 CI

- remove temporary PostgreSQL access/session validator (abec8f3)
- temporarily validate PostgreSQL access and sessions (38251e6)

### 📌 杂项

- fix preserve protocol-relative markdown images (c394870)
- fix markdown live preview attachment images (13f5822)
- fix notebook export attachment auth (9bd3dd8)
- fix clipboard copy (03b2c68)
- fix notebook publication routes (5b02e06)


## v1.4.0 - 2026-07-17

### 🐛 修复

- **db**: migrate share comment source fields before indexing (ee86795)

### 📝 文档

- **db**: plan share comments migration fix (080b955)
- **db**: document share comments migration fix (7cbaf4e)


## v1.3.9 - 2026-07-17

### 🐛 修复

- **release**: 发版前校验环境与登录状态 (bb7879a)

### 🤖 CI

- remove temporary PostgreSQL permissions validation (e4dd96e)
- add temporary PostgreSQL permissions validation (91fbc00)

### 🔧 其他

- **ci**: remove temporary PostgreSQL batch B validator (162d9f6)
- **ci**: expose latest PostgreSQL validation result (fa02ec7)
- **ci**: validate PostgreSQL unified batch B (4939808)


## v1.3.8 - 2026-07-17

### ✨ 新增

- **sdk**: attach binary APIs to NowenClient (#148) (f593438)
- **cli**: register attachment commands (#148) (aacd8b8)
- **cli**: add attachment commands (#148) (44de067)
- **cli**: add attachment client (#148) (9324c04)
- **sdk**: export attachment client (#148) (72a2f58)
- **sdk**: expose attachment API client (#148) (52e809a)
- **share**: publish runtime origin to all link builders (#318) (c588191)
- **share**: share runtime origin across all public links (#318) (6f0b018)
- **share**: let admins configure public origin in modal (#318) (1e3fe19)
- **share**: load runtime public origin into site config (#318) (1302344)
- **share**: resolve and explain public link origin (#318) (69e851c)
- **share**: expose runtime public origin setting (#318) (13978dd)
- **share**: resolve runtime public web origin (#318) (4e08054)
- **sync**: serialize versioned note updates (#319) (3fdb7f0)
- **sync**: add latest-only versioned save queue (#319) (488b7dc)
- **import**: route Word imports through safe worker pipeline (#76) (1bf4059)
- **import**: mount global DOCX import center (#76) (241c24d)
- **import**: add DOCX progress, cancel, and retry center (#76) (9871562)
- **import**: add verified attachment-backed DOCX import (#76) (b8061fe)
- **import**: add cancellable DOCX import task coordinator (#76) (3e0df44)
- **import**: parse DOCX files off the main thread (#76) (7903d0b)
- **import**: add DOCX safety and integrity guards (#76) (dfacd40)
- **import**: embed WeChat favorites export guide (340d6bb)
- **import**: restructure import hub sources (#310) (a302b86)
- **sharing**: complete sharing management workflows (#308) (63d483e)
- **workspace**: reuse emoji picker in admin workspace editor (#309) (d922f58)
- **workspace**: select emoji icons in create and edit dialogs (#309) (39dca86)
- **workspace**: persist and broadcast emoji icons (#309) (251e4b5)
- **workspace**: add reusable emoji icon field (#309) (ca02760)
- **workspace**: validate emoji workspace icons (#309) (5a4e789)
- **db**: add imported note origin mapping schema (#303) (ea125ee)
- **import**: expose WeChat favorites in migration hub (#303) (5abe02d)
- **import**: add WeChat favorites import UI (#303) (922a05a)
- **import**: add WeChat favorites import client (#303) (d1543d1)
- **import**: mount WeChat favorites package endpoint (#303) (27e7791)
- **import**: add streaming WeChat favorites import route (#303) (8ca32e8)
- **import**: implement WeChat favorites package import (#303) (c07e442)
- **import**: add WeChat favorites package adapter (#303) (fd2b3f2)
- **import**: expose Obsidian Vault migration in data manager (#195) (e642299)
- **import**: add Obsidian Vault import UI (#195) (c80175a)
- **import**: import Obsidian notes and attachments (#195) (dde475e)
- **import**: resolve and rewrite Obsidian attachment links (#195) (5171cae)
- **import**: scan Obsidian folders and ZIP archives (#195) (b6e238a)
- **import**: add Obsidian path and media helpers (#195) (8c524be)
- **import**: add Obsidian import data model (#195) (b4346b2)
- **knowledge**: complete backlink UX, graph and block embeds (#165) (e9d86e0)
- **editor**: localize remote images and warn on risky paste colors (#302) (863544e)
- **knowledge**: add universal block links and MCP block tools (#165) (6381781)
- **postgres**: add API token resource scope schema (b92015e)
- **mcp**: wire knowledge tool scope context (31b20bb)
- **mcp**: inject notebook scope into knowledge tool (f95cf6d)
- **mcp**: allow notebook-scoped knowledge ask (fdb65fb)
- **settings**: manage token notebook resources (31bbc7e)
- **auth**: mount API token resource enforcement (721292f)
- **tokens**: manage notebook resource grants (f2cd75a)
- **auth**: persist API token resource mode (07202f0)
- **auth**: enforce API token notebook resources (4a5aef7)
- **mcp**: enable scoped token entrypoint (ed359a3)
- **mcp**: enforce scoped token requests (8cf351b)
- **mcp**: add notebook scope policy (d186155)
- **publication**: surface public space in signed-in workspace (#215) (9fe3bae)
- **publication**: add signed-in public-space entry (#215) (6fb4de3)
- **audit**: classify notebook publication events (#215) (c21c211)
- **publication**: mount public knowledge-space routes (#215) (5cf1fe8)
- **publication**: expose public modes and directory permissions (#215) (946ceb2)
- **publication**: add public notebook knowledge-site view (#215) (7cb3bd7)
- **publication**: add notebook publishing API client (#215) (7a6d8ad)
- **publication**: activate notebook publishing routes (#215) (ea3f70a)
- **publication**: add public notebook publishing and directory ACL (#215) (b344923)
- **permissions**: support directory comment and manage overrides (#215) (00df2fd)
- **permissions**: inherit notebook ACL through directory tree (#215) (d153519)
- **publication**: authorize notebook publication attachments (#215) (a6bb1e8)
- **code-block**: load wrapping overrides (#287) (98289a3)
- **code-block**: enable automatic line wrapping (#287) (0b4ed2d)
- **ai**: resolve AI settings by user (482e572)
- **ai**: add per-user AI settings storage (ec45751)
- **backup**: activate automatic full backups (#291) (7d07948)
- **backup**: make automatic backups attachment-safe (#291) (05b6463)
- **ai**: mount embedding settings in AI preferences (d01e31d)
- **ai**: add embedding settings panel (f86b5b3)
- preserve SiYuan custom icons on import (#245) (a033eec)

### 🐛 修复

- **cli**: normalize attachment query typing (#148) (ae21ad6)
- **sdk**: normalize attachment query typing (#148) (9474c03)
- **editor**: resolve list rendering regressions (#322) (c3a93e2)
- **export**: preserve native Markdown in single-note exports (#320) (4d826ea)
- **tasks**: 修复任务详情模块编译错误 (4909726)
- **share**: warn when public links use protected origin (#318) (7061e18)
- **sync**: install per-note update serialization (#319) (d212ede)
- **editor**: install global NodeView mutation guard (#317) (8d7ae28)
- **editor**: guard all NodeView mutations in read-only mode (#317) (223e21f)
- **editor**: enforce code block read-only toolbar permissions (#317) (c64e6ab)
- **editor**: block code dissolve transactions in read-only mode (#317) (49d251f)
- **editor**: define code block read-only action policy (#317) (3cd02e7)
- **tasks**: save custom repeat rules with current values (#315) (ef3ec24)
- **tasks**: install task update safety bridge (#315) (2601594)
- **tasks**: normalize repeat requests and surface update failures (#315) (1397c9c)
- **tasks**: centralize custom repeat rule construction (#315) (98029a1)
- **import**: return void from DOCX progress cleanup (#76) (88c2dde)
- **import**: keep DOCX worker compatible with bundled JSZip types (#76) (51871b4)
- **import**: accept optional normalized format snapshot (#76) (1993ffe)
- **import**: tolerate block whitespace during DOCX verification (#76) (b90686c)
- **import**: verify normalized DOCX persistence safely (#76) (55bae5b)
- **import**: distinguish DOCX semantic and persistence checks (#76) (7818bfa)
- **export**: normalize image export timestamps as UTC (#314) (94d03b8)
- **export**: preserve wide table columns in note images (#312) (b2d4d61)
- **editor**: stabilize outline heading navigation (#313) (0d6dc30)
- **editor**: keep table and text bubble menus mutually exclusive (#311) (8962262)
- **sharing**: keep counted sessions valid at view limit (#308) (020cf60)
- **sharing**: enforce share security and lifecycle (#308) (942236a)
- **sharing**: enforce public notebook read-only permissions (d74015c)
- **ci**: fetch issue 165 branches with explicit refspecs (2764eb7)
- **ci**: source issue 165 patches from preserved branch (19098dd)
- **ci**: apply issue 165 on latest main tree (51cdf41)
- **editor**: make issue 302 patch resume from diagnostics (d462dd9)
- **ci**: capture issue 165 patch failures (c727bd6)
- **knowledge**: preserve markdown block links and HTML notes (#165) (3b8fccb)
- **knowledge**: correct block idempotency and shared test fixture (e44705e)
- **knowledge**: align issue 165 migration and backlink types (6aad2f8)
- **knowledge**: structurally rewrite backlink excerpt patch (56e23ab)
- **knowledge**: correct backlink panel patch nesting (beb91e5)
- **knowledge**: normalize content format block patch spacing (0632b2b)
- **knowledge**: repair issue 165 client fixer syntax (eae9f06)
- **knowledge**: make issue 165 MCP search patch structural (cbc28cc)
- **editor**: preserve async insert position after dividers (#301) (7075187)
- **auth**: preserve compatibility and restricted boundaries (62b5af4)
- **test**: initialize token scope fixtures without top-level await (24a193a)
- **frontend**: include ES2022 library typings (1717ff1)
- bug (2a63fbf)
- **tasks**: 排除已删除任务的统计动态 (a8b402b)
- **frontend**: 使用 pdf.js 预览 PDF 附件 (ac543eb)
- **frontend**: 修正公开笔记本预览导入 (fcd42ef)
- **notes**: 保持置顶分组手动排序一致 (ff22434)
- **publication**: normalize public note formats and server URLs (#215) (d418b63)
- **publication**: keep public reader build-safe and responsive (#215) (11e84f8)
- **frontend**: 修正浏览器定时器类型 (9f4952c)
- **notes**: 同步置顶笔记到所有视图 (f3eba84)
- **ai**: normalize embedding fallback values (6a0c6d0)
- **ai**: prevent embedding queue starvation (e4948e0)
- **ai**: preserve defaults and safe migration boundaries (b86cab9)
- **ai**: isolate task and embedding configuration (137ef94)
- **editor**: 恢复视频控件交互 (9bdd0ef)
- **ai**: isolate settings and profiles by user (db28ef2)
- **backup**: avoid private-member typing in runtime tests (#291) (3c4439a)
- **backup**: keep automatic full-backup patch type-safe (#291) (d837416)
- **notebooks**: cover legacy parent updates in reconciliation (#211) (7e21011)
- **notebooks**: activate database tree guards (#211) (dc16019)
- **notebooks**: enforce tree integrity at database boundary (#211) (21756a9)
- **notebooks**: reconcile tree and note scope after moves (#211) (52ffb73)
- **notebooks**: invalidate tree after confirmed moves (#211) (902c411)
- **notebooks**: add authoritative tree invalidation event (#211) (6b1dcec)
- align SiYuan imported previews (#284) (a6f98e7)

### ♻️ 重构

- **sdk**: use public client entry (#148) (20ec838)
- **share**: keep origin resolver storage-lazy (#318) (f176a26)
- **import**: align Youdao component name (#310) (697a021)
- **import**: preserve Youdao folder importer alongside Obsidian (#195) (f01b405)

### 📝 文档

- **attachments**: document SDK and CLI workflows (#148) (a281a2b)
- **docker**: expose runtime public share origin (#318) (87e445b)
- **import**: write complete WeChat Favorites export tutorial (109a125)
- **import**: document WeChat favorites migration (#303) (82cde11)
- **mcp**: update for server token resource scopes (8feb232)
- **mcp**: document server-enforced token resources (a2aaaf0)
- **mcp**: document token notebook scopes (38c5e13)
- 添加删除任务动态过滤实现计划 (06bce80)
- 记录删除任务动态过滤设计 (3237f9d)
- 添加置顶实时重排实现计划 (d1f4708)
- 设计置顶笔记实时重排 (6d6c894)
- 规划视频控件事件修复 (0f86e91)
- 设计视频控件事件隔离 (ba2f33a)
- align AI isolation migration version (fcdec71)
- 规划用户 AI 配置隔离 (eb6dad0)
- 设计用户 AI 配置隔离 (4bc5a77)

### 💄 样式

- **share**: use supported warning background opacity (#318) (7bbcd8b)

### ✅ 测试

- **sdk**: add attachment contract test script (#148) (ace8a96)
- **sdk**: cover attachment API workflows (#148) (3f20048)
- **share**: cover shared runtime origin registry (#318) (21b760c)
- **share**: cover runtime public origin priority (#318) (8418ad8)
- **share**: cover public web origin resolution (#318) (837065b)
- **sync**: cover latest-only versioned save queue (#319) (cad79e9)
- **editor**: cover global NodeView read-only guard (#317) (7b24051)
- **editor**: type code block transaction regression (#317) (ab83581)
- **editor**: cover code block read-only mutations (#317) (19ff130)
- **tasks**: verify repeat payload object at API boundary (#315) (89ba532)
- **tasks**: cover custom repeat current-value regression (#315) (1ec4d58)
- **import**: cover safe DOCX conversion and integrity (#76) (9fd3d43)
- **export**: cover UTC image export timestamps (#314) (e1f2d96)
- **workspace**: cover emoji icon validation and permissions (#309) (12e464a)
- **import**: initialize WeChat import schema after test DB setup (#303) (a61bf6c)
- **import**: cover WeChat favorites adapter and idempotency (#303) (62248b0)
- **import**: cover Obsidian paths and attachment rewrites (#195) (f01f21e)
- **editor**: record issue 302 implementation diagnostics (146ed9b)
- **knowledge**: update issue 165 implementation diagnostics (d854162)
- **knowledge**: record issue 165 implementation diagnostics (fb2d972)
- **editor**: record issue 301 fix diagnostics (988c8c3)
- **auth**: record final token boundary validation (066d695)
- **auth**: cover restricted boundaries and legacy compatibility (40f38ab)
- **mcp**: record Phase 2-3 revalidation (0e04395)
- **mcp**: record final Phase 2-3 validation (bab2dc5)
- **auth**: cover API token notebook resource enforcement (042881f)
- **mcp**: record Phase 2-3 validation (5fe8965)
- **mcp**: cover notebook scope policy (49e3003)
- **tasks**: 确保初始化失败时清理临时库 (a09e362)
- **tasks**: 确保活动路由测试清理临时库 (724888f)
- **tasks**: 复现删除任务动态残留 (1dbd71a)
- **permissions**: cover inherited directory ACL overrides (#215) (1c52a8c)
- **editor**: 覆盖视频 NodeView 事件链 (1fbb2aa)
- **backup**: cover automatic full backup retention (#291) (91a0a87)
- **notebooks**: cover confirmed tree invalidation (#211) (b0f5763)
- **notebooks**: cover root moves and tree safety (#211) (e97d78e)

### 🔧 其他

- **ci**: remove temporary PostgreSQL unified validator (6d74d2b)
- **ci**: validate packaged PostgreSQL parity migration (a2f46df)
- **ci**: trigger PostgreSQL validation by PR command (7711dd4)
- **ci**: report PostgreSQL unified validation to PR (b59a230)
- **ci**: trigger unified PostgreSQL validation on PR edits (8d25c2b)
- **ci**: validate PostgreSQL unified branch (10b138d)
- **issue-322**: expose validation diagnostics (643542a)
- **issue-322**: use PR event runner (34586ec)
- **ci**: execute issue #322 migration (19c5501)
- **issue-322**: register deterministic runner (813315d)
- **issue-322**: add deterministic main migration (29eeff0)
- **ci**: run issue #322 implementation (6a5e883)
- **ci**: simplify issue #322 runner (bf55ed8)
- **ci**: diagnose issue #322 patch application (7356a38)
- **ci**: enable issue #322 command trigger (f1a4ca8)
- **ci**: apply issue #322 on main (ac79974)
- **issue-322**: stage regression tests (e349bc7)
- **issue-322**: stage export css patch (9601917)
- **issue-322**: stage list css patch (6aa4686)
- **issue-322**: stage editor patch (afee353)
- **ci**: remove issue 320 trigger (a3279c8)
- **ci**: remove unused issue 320 workflow (88adfa5)
- **ci**: allow PR-triggered issue 320 validation (b719f6d)
- **ci**: trigger issue 320 validation (1062bd8)
- **ci**: add one-shot issue 320 validation (0dcf096)
- **ci**: remove issue 319 trigger file (78b8f8c)
- **ci**: remove issue 319 trigger workflow (bd52153)
- **ci**: remove issue 319 apply workflow (105751b)
- **ci**: trigger issue 319 validation (ab32d56)
- **ci**: add issue 319 workflow trigger (cb46f9e)
- **ci**: apply and validate issue 319 fix (e6a3554)
- **issue-76**: remove inactive validation trigger (c2e3c5e)
- **issue-76**: remove inactive validation workflow (9ca91f4)
- **issue-76**: trigger DOCX import validation (db4bf1b)
- **issue-76**: stage DOCX import validation (1823fd3)
- clean issue 314 trigger (b4199e4)
- remove unused issue 314 workflow (a4596d9)
- retrigger issue 314 implementation (96415d9)
- trigger issue 314 implementation (3ac3c8f)
- stage issue 314 validation workflow (bec45fe)
- stage issue 312 implementation (ff58fb5)
- trigger issue 313 implementation (18a53b7)
- stage issue 313 validation workflow (7ab80d1)
- **import**: validate inline WeChat favorites guide (69666e3)
- **import**: stage inline WeChat favorites guide (2de144a)
- **issue-311**: make fix validation observable (06991ea)
- **issue-311**: add deterministic bubble fix script (769914b)
- **issue-310**: remove final one-time workflow log (cd4cc86)
- **issue-310**: capture import hub migration failure (12624a7)
- **issue-310**: remove one-time validation workflow (276833b)
- **issue-310**: remove one-time migration script (23bc621)
- **issue-310**: remove duplicate-run diagnostic (73c46d5)
- **issue-310**: make migration validation observable (982d650)
- **issue-310**: run validated import hub migration (f151475)
- **issue-311**: run robust bubble fix validation (2b8a2b5)
- **issue-310**: stage import hub IA migration script (7abd873)
- **issue-311**: diagnose failed bubble fix run (b34dd49)
- **issue-311**: stage bubble menu fix validation (83332c4)
- **issue-311**: capture selection handler excerpt (be11521)
- **issue-311**: inspect editor selection handling (0cf94e0)
- **issue-308**: validate final share-session consistency (6f9f0f6)
- **issue-308**: stage final session-limit consistency fix (f714beb)
- **issue-308**: rerun sharing validation with public comment alignment (0aa8024)
- **issue-308**: align public comment form patch (301a1bf)
- **issue-308**: record sharing management validation failure (c0fe1c8)
- **issue-308**: rerun sharing validation with literal-safe patch (1b07238)
- **issue-308**: finalize literal type patch helper (6e4a9d3)
- **issue-308**: preserve literal escapes in type patch (0795544)
- **issue-308**: rerun sharing validation with fixed helper syntax (150422c)
- **issue-308**: fix scoped type patch syntax (d885d4a)
- **issue-308**: rerun sharing validation with scoped type patch (0577af3)
- **issue-308**: narrow share-link type patch (40c66f8)
- **issue-308**: validate sharing management implementation (4ca1af1)
- **issue-308**: preserve share-link repository async API (757754d)
- **issue-308**: stage sharing management implementation (6c98469)
- **issue-308**: rerun backend validation with migration repair (0bde7c5)
- **issue-308**: repair migration sequence for validation (cd44469)
- **issue-308**: record backend validation failure (54f551b)
- **issue-308**: rerun backend validation with type fixes (d79ed21)
- **issue-308**: fix validation type surfaces (f7acfc4)
- **issue-308**: rerun backend validation with publication alignment (2793b6b)
- **issue-308**: align publication scope patch (bf98a6f)
- **issue-308**: rerun backend validation with PG alignment (bee32cf)
- **issue-308**: align PostgreSQL patch markers (032e55d)
- **issue-308**: persist backend validation diagnostics (9f21e3f)
- **issue-308**: validate share security implementation (fe421d8)
- **issue-308**: stage share security implementation (786682f)
- **ci**: remove stale branch cleanup workflow (8aff574)
- **ci**: trigger stale branch cleanup (2c5181b)
- **ci**: add one-shot stale branch cleanup (4862936)
- **ci**: trigger public notebook read-only fix (aa63272)
- **ci**: stage public notebook read-only fix (d8f3068)
- **ci**: trigger validated issue 165 promotion (2706a3a)
- **ci**: promote validated issue 165 feature tree (9df14fd)
- **ci**: retry issue 165 explicit branch fetch (3f4289e)
- **ci**: rerun issue 165 from preserved patch branch (89d38c6)
- **ci**: run issue 165 against latest main (dd8838b)
- **ci**: retry repaired issue 165 normalizer (11dec1f)
- **ci**: retry escaped issue 165 patch (db2a42e)
- **ci**: retrigger issue 302 implementation (5368b5f)
- **ci**: resume validated issue 302 implementation (00e4382)
- **ci**: retry structural Markdown note-link patch (c31fdaa)
- **ci**: retry normalized issue 165 patches (47523f6)
- **ci**: retrigger issue 165 with patch diagnostics (91f0b9d)
- **ci**: trigger issue 165 remaining-feature runner (406a90a)
- **ci**: add issue 165 remaining-feature runner (3598316)
- **ci**: trigger issue 302 implementation (5975b56)
- **ci**: validate and apply issue 302 (73fc7a4)
- **editor**: add issue 302 implementation script (951999e)
- **ci**: trigger issue 165 markdown HTML follow-up (16c4d10)
- **ci**: validate issue 165 markdown and HTML follow-up (966260a)
- **knowledge**: add issue 165 markdown follow-up patch (9b576ea)
- **ci**: trigger final issue 165 validation (85c0cb9)
- **ci**: retry issue 165 final backend assertions (fda837f)
- **ci**: trigger compile-fixed issue 165 patch (c0000ca)
- **ci**: retry issue 165 after compile fixes (5a0b96b)
- **ci**: trigger structural issue 165 patch (d407eab)
- **ci**: retry issue 165 with structural client patches (9991aa4)
- **ci**: trigger backlink-corrected issue 165 patch (4a787a6)
- **ci**: retry issue 165 after backlink patch fix (f27e838)
- **ci**: trigger normalized issue 165 patch (d858666)
- **ci**: retry issue 165 after patch normalization (c63b127)
- **ci**: retrigger issue 165 implementation (95dc3c6)
- **ci**: retry issue 165 implementation workflow (37b2f7a)
- **ci**: trigger issue 165 implementation (7ee80a1)
- **ci**: add issue 165 implementation workflow (7dc8b37)
- **knowledge**: add issue 165 client patch script (b1f1c69)
- **knowledge**: add issue 165 backend patch script (c7aa293)
- **ci**: trigger deterministic issue 301 fix (fb06f09)
- **ci**: add deterministic issue 301 apply workflow (51ff88a)
- **editor**: add deterministic issue 301 patch script (1729a26)
- **ci**: trigger issue 301 fix diagnostics (178db0c)
- **ci**: add issue 301 fix diagnostics (5ce042c)
- **ci**: retrigger direct fix for issue 301 (8e8be29)
- **ci**: trigger direct fix for issue 301 (5b72769)
- **ci**: add direct main fix workflow for issue 301 (a438539)
- **ci**: trigger final token boundary validation (4871786)
- **ci**: add final token boundary validation (786e706)
- **auth**: remove completed compatibility workflow (2e59294)
- **auth**: remove completed compatibility trigger (f7f0167)
- **auth**: retrigger compatibility boundary patch (d6be5ff)
- **auth**: include restricted tag boundary patch (a53d065)
- **auth**: trigger unrestricted compatibility patch (9363753)
- **auth**: add one-shot unrestricted compatibility patch (2357cae)
- **ci**: trigger Phase 2-3 revalidation (2229dda)
- **ci**: add Phase 2-3 revalidation (429ea3f)
- **mcp**: remove completed closeout workflow (75e52c2)
- **mcp**: remove completed closeout trigger (8cf6790)
- **ci**: trigger final Phase 2-3 validation (1e505a9)
- **ci**: add final Phase 2-3 validation (a8e4707)
- **mcp**: retrigger Phase 2-3 closeout (134cb35)
- **mcp**: trigger Phase 2-3 closeout (7a181a4)
- **mcp**: add one-shot Phase 2-3 closeout patch (428da1e)
- **ci**: trigger Phase 2-3 validation (924bfb4)
- **ci**: add one-shot Phase 2-3 validation (c4150d5)
- **auth**: trigger token scope mount (ed3c4e8)
- **auth**: add one-shot token scope patch workflow (5d29f5f)
- **db**: remove temporary unified regression patch workflow (b0d679c)
- **db**: trigger unified regression patch from validation PR (303f405)
- **db**: patch unified migration regression conflicts (9528dcb)
- **db**: remove PostgreSQL unified branch bootstrap workflow (586016b)
- **db**: bootstrap unified PostgreSQL migration branch (3b30b7c)


## v1.3.7 - 2026-07-14

### ✨ 新增

- **标签栏**: 添加全部标签快速切换 (88ec3ac)
- **笔记体验**: 添加打印与紧凑侧栏布局 (e414baf)

### 🐛 修复

- **notebooks**: apply inherited sort to notes (6d6bfc5)
- **editor**: 全端关闭文档拼写检查（任务 1） (04ff8a4)
- 修复反代部署附件刷新后变成 127.0.0.1 裂图 (#295) (f02f14a)
- **export**: 延迟释放导出文件地址 (c243d06)
- **export**: 允许浏览器重试下载 (dfecf4f)
- **标签栏**: 完善标签列表收起与焦点行为 (e43ea81)

### 📝 文档

- 规划笔记排序继承修复 (eac2edc)
- 设计笔记排序继承修复 (e8b0ec2)
- 添加全端关闭拼写检查实现计划 (38de780)
- 设计全端关闭文档拼写检查 (b7d844e)
- **export**: 添加浏览器下载重试计划 (dbe91ba)
- **export**: 设计浏览器下载重试修复 (27b87ba)
- **计划**: 记录顶部标签快速切换实现步骤 (6706849)
- **设计**: 记录顶部标签快速切换方案 (31e4154)

### ✅ 测试

- **notebooks**: cover sidebar sort inheritance (96249db)

### 🔧 其他

- **git**: 忽略本地工作树 (15c73f0)


## v1.3.6 - 2026-07-14

### 🐛 修复

- 完成版本冲突处理闭环并停止重复弹窗 (#274) (b10c2cb)
- 简化全局同步状态，隐藏普通用户队列概念 (#275) (c222bfb)
- 修复安卓主题切换抖动与图片旋转缩放 (#270) (7510060)


## v1.3.5 - 2026-07-13

### ✨ 新增

- 用户偏好跟随账号同步 (#209) (1cc78c6)
- **移动端**: 优化图片操作菜单（任务 2/3） (bd6b701)

### 🐛 修复

- **Android**: 修复笔记列表轻触无响应 (f0ad5ce)
- **search**: rebuild stale FTS index on upgrade (#212) (1d1ab84)
- **search**: require explainable matches and cover metadata (#212) (a0bb18a)
- **search**: normalize literal query terms (#212) (8e32aeb)
- **移动端**: 提供 Markdown 预览入口 (b1da1f0)
- **Markdown**: 渲染行内与块级公式 (e70c612)
- **移动端**: 消除图片菜单切换闪烁 (04b3629)
- **移动端**: 兼容通用编辑器选区类型（任务 3/3） (ed0a91c)
- **移动端**: 保持图片操作菜单可见（任务 1/3） (3749ece)

### 📝 文档

- **移动端**: 记录图片菜单实现计划 (c633e03)
- **移动端**: 记录图片操作菜单设计 (c51c5fe)

### 💄 样式

- **移动端**: 缩小图片操作面板 (6f77dc6)

### ✅ 测试

- **search**: cover query normalization (#212) (b6168da)
- **search**: cover reliable full-text retrieval (#212) (ee6ddde)


## v1.3.4 - 2026-07-13

### 🐛 修复

- **桌面端**: 避免失效令牌登录循环 (e647d03)
- **附件**: 为上传与文件列表签发访问地址 (d51d603)
- **笔记**: 重命名时携带服务端版本 (69dbabe)


## v1.3.3 - 2026-07-13

### ✨ 新增

- **统计**: 重设计仪表盘概览 (14bd5ec)
- **sync**: expose failed queue diagnostics and retries (#208) (827bcd3)
- 思维导图折叠按钮显示子节点数量，移除 CSP 中的 frame-ancestors 限制 (6ed0f9c)
- **tasks**: 完善任务与习惯统计视图 (a77091a)
- **mobile**: install Android startup request coalescer (#237) (7804729)
- **mobile**: collapse Android cold-start reads (#237) (e795f05)
- **mobile**: mount compact startup snapshot (#237) (15f303f)
- **mobile**: add compact Android startup snapshot (#237) (c51286d)
- **导入**: 提升 H4-H6 标题级别保真 (4f98153)
- **export**: route image exports through reliable preview renderer (#221) (b717c6f)
- **export**: mount note image export center (#221) (2b11a07)
- **android**: add export file picker and native sharing (#221) (0289bc5)
- **android**: support gallery, files, share and open for exports (#221) (f231993)
- **export**: add cross-platform image export center (#221) (4bdb7b6)
- **export**: render faithful raster and SVG note exports (#221) (4eb4d15)
- **export**: add note image export request bridge (#221) (7e2e7a2)
- **desktop**: support multi-server profiles and safe NAS migration (#207) (3ebe73f)
- **siyuan**: 安全补齐导入保真并修复表格属性丢失 (#224) (6823598)
- **media**: enable attachment range responses (#214) (426ca86)
- **media**: mount mobile media experience bridge (#214) (c183e33)
- **media**: add mobile media picker and inline video UX (#214) (a4698a7)
- **media**: add mobile media selection helpers (#214) (f48e25e)
- **media**: report video upload lifecycle (#214) (5008cfb)
- **media**: report image upload lifecycle (#214) (bf828f7)
- **media**: expose per-file upload lifecycle (#214) (2314895)
- **media**: stream attachment video ranges (#214) (852f132)
- **media**: add strict single-range parser (#214) (9a76986)
- **android**: mount share import center (#220) (de83a1c)
- **android**: add system share import sheet (#220) (d5e43c5)
- **android**: build safe note content for shared items (#220) (a1f7498)
- **android**: expose native share import bridge (#220) (438f00a)
- **android**: register share and open-with targets (#220) (72e8dcb)
- **android**: route share intents into Nowen (#220) (0cab0a8)
- **android**: receive and stream shared files (#220) (a99f287)
- **android**: add share import validation helpers (#220) (08e38b6)
- **folder-sync**: add stop-tracking conflict control (#222) (bf80024)
- **folder-sync**: stop tracking edited notes on conflict (#222) (329e96b)
- **folder-sync**: expose detached conflict result (#222) (3546f3b)
- **folder-sync**: add stop-tracking conflict policy (#222) (3c04dd5)
- **folder-sync**: expose safety and conflict controls (#222) (f333ff9)
- **folder-sync**: process conflicts renames and source deletion (#222) (1648937)
- **folder-sync**: add conflict and deletion policies (#222) (c1d2b0f)
- **folder-sync**: harden incremental scanner and rename tracking (#222) (fb5f5dc)
- **folder-sync**: add conflict-aware transport (#222) (5a8547b)
- **folder-sync**: add advanced sync preferences (#222) (4c0c23d)
- **ai**: mount reliability UI shells (#218) (2a64b21)
- **ai**: add explicit manual configuration switch (#218) (33a7db5)
- **ai**: expose context modes and diagnostics in chat (#218) (d326db5)
- **ai**: add reliable ask client and diagnostics parser (#218) (0206e9e)
- **ai**: mount reliable context routes (#218) (ad20cf4)
- **ai**: add explainable reliable ask pipeline (#218) (621b0ed)
- **ai**: add explainable context preparation (#218) (216bf4f)
- **clipper**: persist image limits and reset account state (#217) (667c57f)
- **clipper**: expose lazy image limits and reset controls (#217) (aed4113)
- **clipper**: add quick note and target picker UI (#217) (a7646e2)
- **clipper**: redesign popup as unified capture entry (#217) (f50d15e)
- **clipper**: mount enhanced background entry (#217) (9aa1fce)
- **clipper**: implement unified quick note and clip pipeline (#217) (a8a282c)
- **clipper**: support workspace targets and note metadata (#217) (c2a9cab)
- **clipper**: define unified capture protocol (#217) (888bb2a)
- **clipper**: persist account-scoped capture preferences (#217) (933fe88)
- **clipper**: add bounded image localization pipeline (#217) (9a67963)
- **data**: mount full system transfer controls (ad0f6c3)
- **data**: replace database-only transfer with full system archive (ef4527f)
- **tasks**: enable image-aware transfer center (#206) (dd60910)
- **tasks**: expose full backup with task images (#206) (71969f1)
- **tasks**: add image-aware task backup archive (#206) (b8fb1f2)
- **tasks**: mount task data transfer center (#206) (08615b3)
- **tasks**: add responsive import export center (#206) (2b737ba)
- **tasks**: add task backup and import engine (#206) (e7a099c)
- **android**: mount mobile drawer UX bridge (7b56924)
- **auth**: mount persistent 2FA challenge center (#158) (3a3fe36)
- **auth**: add resilient 2FA challenge center (#158) (8d03e0a)
- **images**: 保留图片旋转/翻转状态并修复图片节点 inline 模式 (206344e)
- **updater**: mount desktop update center (#202) (8530330)
- **updater**: add global in-app update center (#202) (4be7f34)
- **updater**: add update presentation helpers (#202) (f6c76bb)
- **updater**: add consent-driven in-app update state machine (#202) (8e048b2)
- **images**: mount persistent editor transform bridge (#201) (86b712b)
- **images**: add compact editor transform controls (#201) (6579bf0)
- **images**: add persistent image transform attributes (#201) (00f30df)

### 🐛 修复

- **任务提醒**: 修复鉴权与路由匹配 (44640e0)
- **editor**: let IME composition commit through slash fallback (#213) (3884c83)
- **editor**: reset and scope slash command menu (#213) (53a8619)
- **editor**: make slash activation transaction-driven (#213) (de85615)
- **同步**: 改善冲突队列与删除后清理 (1535ba3)
- **tasks**: 加固任务统计历史与兼容性 (#244) (ebbd1c6)
- **sync**: keep queue replay compatible with CORS allowlist (#208) (9f48bf0)
- **sync**: report pending queue and refresh authoritative snapshot (#208) (d4954e4)
- **sync**: preserve failed queue items and serialize flush (#208) (f339f9f)
- **sync**: add stable mutation ids to queue replay (#208) (76f34f5)
- 下载附件时使用附件访问桥，确保跨域场景也能正确下载 (e7cbbac)
- **mermaid**: 禁用 htmlLabels 使用原生 SVG text，避免 DOMPurify 清空节点文字 (4c6d499)
- **markdown**: include H4-H6 in editor outline (#236) (b54c09a)
- **ai**: 优化 AI 连接测试逻辑，允许模型未返回文本时也判定连接成功 (b850f8a)
- **export**: install reliable download bridge (#235) (3005f79)
- **export**: bridge all browser exports to HTTP downloads (#235) (6a2fb32)
- **export**: enforce bounded requests and one-time cleanup (#235) (45853cb)
- **export**: add bounded reliable export routes (#235) (9cba9c4)
- **export**: harden reliable export jobs (#235) (b2683fc)
- **mobile**: coalesce NAS startup reads in mobile web (#237) (886d4b8)
- **导出**: 让 PDF 和 Word 使用真实下载地址 (6ca71fa)
- **导出**: 覆盖单篇笔记附件流式下载 (18e37a0)
- **导出**: 使用后端流式任务避免压缩卡在99% (c975d58)
- **sharing**: authorize shared note attachments (#216) (45b91f0)
- **media**: recover legacy video MIME for playback (#214) (48ac1c1)
- **media**: infer missing video MIME from filenames (#214) (de7ee48)
- **media**: type file picker cancel events (#214) (36ee1e9)
- **media**: keep byte-range responses uncompressed (#214) (6ec3c53)
- **media**: treat prevented editor drops as handled (#214) (1310dbb)
- **android**: reject untrusted MIME header injection (#220) (f8c87f7)
- **android**: preserve legacy note formats during share import (#220) (d5ac04d)
- **android**: guard missing share import plugin (#220) (04500c2)
- **android**: accept open-with intents without MIME (#220) (e5f5832)
- **android**: harden shared executable detection (#220) (3ce0596)
- **android**: neutralize shared raw HTML in markdown (#220) (be78ac9)
- **folder-sync**: store desktop attachments under userData (#222) (966c237)
- **folder-sync**: detach entries removed from configured scope (#222) (55bd20d)
- **folder-sync**: protect notes when sync scope narrows (#222) (c2e3e8d)
- **folder-sync**: normalize root-compatible double-star rules (#222) (4bc8cf0)
- **folder-sync**: persist rename metadata despite unchanged hash (#222) (ec1174a)
- **auth**: invalidate cached identity before issuing sessions (#223) (14cb276)
- **ai**: harden scoped retrieval and full-note budgeting (#218) (e0e63a0)
- **clipper**: migrate username-scoped capture preferences (#217) (cd96777)
- **tasks**: use safe PNG for missing-image placeholders (#206) (9d989ad)
- **tasks**: keep fallback marker type-safe (#206) (6a668e3)
- **tasks**: install missing-image backup fallback (#206) (95946e0)
- **tasks**: tolerate missing images during backup export (#206) (8ad94ad)
- **tasks**: refine task transfer UX and observer cost (#206) (a277746)
- **tasks**: harden task backup integrity and imports (#206) (f692bb3)
- **android**: improve drawer search and safe top controls (6b8e342)
- **notebooks**: narrow nested sort resolver type (#190) (496285c)
- **notebooks**: apply inherited sort to nested notes (#190) (d7ab88c)
- **notebooks**: inherit root sort through nested tree (#190) (e81eee3)
- **auth**: cap pending 2FA challenges at five minutes (#158) (d1a541c)
- **auth**: preserve safe redirect after 2FA login (#158) (61adc42)
- **auth**: avoid extra CORS headers in 2FA verification (#158) (ac65c07)
- **auth**: harden 2FA challenge storage access (#158) (bc5aa5e)
- **auth**: let pending 2FA bypass quick login (#158) (ea43acd)
- **auth**: persist pending 2FA login challenges (#158) (5b107ed)
- **search**: keep Android sidebar focus during search transition (#203) (8450bca)
- **search**: hydrate remounted sidebar from bridge state (#203) (dfa2cc8)
- **search**: restore query after sidebar remount (#203) (c9c98fe)
- **search**: unify mobile sidebar and full search state (#203) (379f33c)
- **search**: decouple sidebar input from synthetic events (#203) (691fe1c)
- **search**: add mobile sidebar search state bridge (#203) (2aec04f)
- **search**: keep IME fallback compatible with older webviews (#203) (639ba47)
- **search**: commit IME text without synthetic input loss (#203) (5a7a9e5)
- **search**: preserve IME composition in sidebar search (#203) (3c5fa6c)
- **import**: route siyuan zip by suffix (480bc77)
- **images**: keep drag resize aligned after rotation (#201) (298d37c)
- **images**: preserve transforms in markdown exports (#201) (1ecf1b3)
- **images**: keep legacy replacement payloads stable (#201) (f68f74e)
- **images**: avoid symbol-key type errors in transform bootstrap (#201) (7619a8a)
- **images**: preserve transforms when replacing images (#201) (fdd7703)

### ♻️ 重构

- **export**: fold hardening into compatibility service (#235) (4ecc794)
- **media**: reuse pure video MIME helper (#214) (9673d8b)
- **media**: isolate video MIME inference (#214) (8df5142)
- **ai**: preserve user preference routes for reliability wrapper (#218) (4807345)

### 📝 文档

- **统计**: 明确仪表盘重设计方案 (9e4898f)
- 设计同步冲突处理流程 (ba1d63e)
- **export**: document reliable note image export (#221) (8559a6b)
- **media**: document mobile image and video workflow (#214) (ab8f6f0)
- **android**: clarify pending share retention budget (#220) (c7bc35b)
- **android**: document system share import (#220) (a3c277f)
- **folder-sync**: document conflict detach behavior (#222) (efaa4a7)
- **folder-sync**: document safe one-way sync v2 (#222) (c62f8e1)
- **clipper**: document unified capture workflow (#217) (737f9c9)
- add image editor regression screenshot (46acaf4)

### 💄 样式

- **clipper**: polish unified capture popup (#217) (9edbdf2)

### ✅ 测试

- **editor**: 兼容新版文本输入回调 (dda9472)
- **editor**: cover repeated slash command activation (#213) (8f359dd)
- **sync**: cover queue races, preservation and idempotency (#208) (eecec45)
- **export**: cover reliable download compatibility bridge (#235) (fe3d24a)
- **export**: cover quotas and one-time downloads (#235) (5dde2cf)
- **export**: preserve legacy helper coverage (#235) (50fb353)
- **mobile**: cover compact startup filtering and sorting (#237) (affcccd)
- **export**: cover safe long-image and pagination planning (#221) (36c6188)
- **sharing**: stabilize shared attachment validation (#216) (847e56f)
- **media**: cover lazy repair of legacy video MIME (#214) (af07a2d)
- **media**: verify empty mobile video MIME normalization (#214) (d90863a)
- **media**: isolate video MIME helper coverage (#214) (9436220)
- **media**: cover mobile video MIME inference (#214) (130f6fb)
- **media**: cover mobile media preparation helpers (#214) (c37119b)
- **media**: cover strict HTTP range parsing (#214) (329fee3)
- **media**: cover attachment video byte ranges (#214) (c23d12d)
- **android**: cover malicious shared MIME metadata (#220) (84d7d56)
- **android**: cover legacy note formats and unsafe share text (#220) (96f53d8)
- **android**: cover disguised executable shares (#220) (9bb7d8d)
- **android**: align share filename normalization (#220) (b591e90)
- **android**: cover shared note content fidelity (#220) (947dcd3)
- **android**: cover shared file validation (#220) (0dfa305)
- **folder-sync**: cover Electron attachment storage path (#222) (aafe59a)
- **folder-sync**: cover exclusion scope matching (#222) (6c72f42)
- **folder-sync**: cover advanced preference normalization (#222) (e5b53a6)
- **folder-sync**: cover stop-tracking conflict flow (#222) (b0d2f0a)
- **folder-sync**: cover hash-stable source rename (#222) (59e9a39)
- **folder-sync**: preserve sync marker in manual edit fixture (#222) (31c4383)
- **folder-sync**: cover conflict and source deletion policies (#222) (c96edd0)
- **folder-sync**: cover safety rename and advanced preferences (#222) (f681515)
- **auth**: cover fresh session cache invalidation (#223) (e36c08e)
- **ai**: cover disabled configuration guard and restore (#218) (6a85b97)
- **ai**: cover full note conversion and visible truncation (#218) (e0324be)
- **notes**: cover attachment cleanup on permanent deletion (0eabf88)
- **tasks**: assert PNG placeholder bytes (#206) (1d1a711)
- **tasks**: stabilize missing-image fallback assertions (#206) (14352e2)
- **tasks**: cover missing-image export fallback (#206) (11b4519)
- **tasks**: cover image backup archive parsing (#206) (775212a)
- **tasks**: cover backup integrity and import rollback (#206) (19119c9)
- **tasks**: cover cyclic hierarchy and note-link warnings (#206) (56d5fdf)
- **tasks**: cover task backup CSV and validation (#206) (43b897e)
- **android**: cover drawer search completion and safe controls (e1fb200)
- **notebooks**: cover nested sort inheritance (#190) (82a00b2)
- **auth**: enforce five-minute 2FA challenge cap (#158) (e3a08e9)
- **auth**: cover persistent 2FA login challenges (#158) (346ee2b)
- **search**: cover sidebar remount state (#203) (260b269)
- **search**: cover mobile sidebar bridge routing (#203) (e818ce9)
- **search**: cover sidebar IME event routing (#203) (177de30)
- **updater**: cover update state presentation (#202) (c28a31f)
- **images**: cover transformed markdown exports (#201) (3b1ac4b)
- **images**: preserve transforms during replacement (#201) (24c86b3)
- **images**: cover persistent editor transforms (#201) (948c95b)

### 🤖 CI

- add one-shot PR 236 fix trigger (f4bcdd8)

### 🔧 其他

- **ci**: bootstrap issue 221 export integration (43ae00f)
- **media**: rely on DOM cancel event typing (#214) (41485f6)
- 更新浏览器剪藏插件0.2.0发布包 (2df0ab3)
- **clipper**: publish manifest 0.2.0 (#217) (51b564d)
- **clipper**: bump unified capture release to 0.2.0 (#217) (c1ccf3f)
- remove unused issue 201 verification workflow (1c7a092)
- remove unused issue 201 patch script (9b2a97d)
- apply and verify image transform implementation (#201) (9958f76)
- stage image transform implementation (#201) (01a4645)

### 📌 杂项

- 统一桌面开发与网页端本地数据源 (2652eb5)
- 修复桌面端本地登录后导航被拦截 (ce0384e)
- 修复本地迁移登录会话失效 (a239c5c)
- 修复桌面端原生模块 ABI 不匹配 (343270c)
- 修复客户端登录后个人笔记未加载 (4ab392f)
- 调整服务端入口至左侧导航栏 (9d2b5e3)
- 修复桌面端导航栏与窗口按钮重叠 (d10c3f6)
- 修复桌面端左上角展示和原生模块兼容 (1c28cfd)
- Add siyuan directory (bc3ada5)
- testability(media): export video MIME inference (#214) (4d15d0f)


## v1.3.2 - 2026-07-10

### ✨ 新增

- **images**: mount mobile and share image experience (#199) (553eb59)
- **images**: add compact mobile sheet and share lightbox controls (#199) (8a6a873)
- **images**: add mobile sheet and lightbox helpers (#199) (882614c)
- **markdown**: mount experience bridge (#198) (176894c)
- **markdown**: bridge live preview and split sync (#198) (37791f9)
- **markdown**: unify preview tasks code and anchors (#198) (95ee809)
- **markdown**: add block live preview extension (#198) (e2865b5)
- **markdown**: add mapped split scroll sync (#198) (befcd6b)
- **markdown**: add shared enhanced code block (#198) (15cb544)
- **sidebar**: replace notebook icon picker (#170) (3bd414a)
- **ui**: add searchable emoji picker with recents (#170) (2cf7066)
- **emoji**: add comprehensive local emoji dataset (#170) (fae2995)
- **markdown**: safely render imported HTML and sandboxed iframes (#196) (a9a3968)
- **ai**: mount AI profile switcher bridge (#197) (6ad8151)
- **ai**: manage multiple AI service profiles (#197) (8d9b583)
- **ai**: add chat profile switcher (#197) (e9f8fdd)
- **ai**: add AI profile client (#197) (bb76db1)
- **ai**: add reusable AI profiles and model discovery (#197) (a13e2c6)
- **search**: mount persistent search center (#166) (34327fa)
- **search**: return match counts and notebook metadata (#166) (7c1edef)
- **search**: add full-width search center (#166) (2dc53ea)
- **notes**: mount note icon feature bridge (#171) (fedc653)
- **notes**: add note icon picker and list rendering (#171) (f1fb17a)
- **notes**: add batched note icon client store (#171) (ed692a5)
- **notes**: add persistent note icon metadata API (#171) (b5859a9)
- **notes**: add rename action to note context menus (#172) (772e912)
- **notes**: add context menu rename dialog (#172) (c6276f8)
- **tasks**: add habit check-in module (#191) (18da154)

### 🐛 修复

- **build**: accept missing image action grids (ab2637d)
- **build**: narrow active note before rename update (eebee72)
- **sync**: mark only confirmed detail responses as cached (#200) (c6267b2)
- **sync**: preserve cache detail markers on metadata writes (#200) (02c848d)
- **sync**: preserve offline base fingerprints across queue acknowledgements (#200) (4676c75)
- **sync**: limit safety snapshots to destructive overwrites (#200) (fcb0401)
- **sync**: require complete server note responses (#200) (92a18a6)
- **sync**: require server identity fields for cached details (#200) (e27caa6)
- **sync**: reject list placeholders as note details (#200) (b216739)
- **sync**: distinguish cached details from list placeholders (#200) (2698bd0)
- **sync**: install complete note response guard (#200) (860ae6a)
- **sync**: reject incomplete update responses (#200) (065c8ae)
- **sync**: reject incomplete note detail cache writes (#200) (433fd17)
- **sync**: validate offline base content fingerprints (#200) (79f028b)
- **sync**: fingerprint offline note bases (#200) (1f1dd73)
- **sync**: finalize stale-base validation and conflict drafts (#200) (e6b2ffa)
- **sync**: mark identical draft rebases as conflicts (#200) (7b2b1e5)
- **sync**: preserve conflicted draft base revisions (#200) (86de7c0)
- **sync**: install revision safety trigger (#200) (a8a2e20)
- **sync**: preserve every overwritten note revision (#200) (204b67b)
- **sync**: install note write safety before render (#200) (4b22240)
- **sync**: guard stale and unconfirmed note writes (#200) (91b02ed)
- **sync**: stop blind conflict replays (#200) (68ca026)
- **sync**: distinguish offline note snapshots (#200) (fb97b2c)
- **markdown**: provide live block decorations from state field (#198) (7f23848)
- **images**: install mobile image focus guard (#199) (d1911d1)
- **images**: blur editor when mobile image sheet opens (#199) (3d71a49)
- **images**: use a strict-safe lightbox guard key (#199) (922912d)
- **images**: keep lightbox rotation during zoom (#199) (55a1480)
- **images**: preserve lightbox rotation across zoom updates (#199) (c52b8bc)
- **markdown**: align preview when split mode opens (#198) (1025238)
- **markdown**: stabilize bridge persistence and observers (#198) (2d2425e)
- **siyuan**: bound metadata scans and align document mapping (#196) (db045b5)
- **siyuan**: index assets referenced from imported HTML (#196) (1a47d2b)
- **siyuan**: preserve notebook order and emoji metadata (#196) (7f23f72)
- **siyuan**: preserve emoji and iframe nodes during markdown conversion (#196) (8975f9a)
- **ai**: preserve connection testing for profiles (#197) (fe0c164)
- **ai**: keep profile switcher compact on mobile (#197) (98e25a0)
- **ai**: normalize AI profile request headers (#197) (c6af9fe)
- **ai**: harden profile persistence and preserve icon validation (#197) (7be2687)
- **ai**: reload profiles when chat opens (#197) (d70b413)
- **android**: limit native bridge to JSON reads (d39b27a)
- **android**: install native-first API bridge (e690f83)
- **android**: prefer native HTTP for API reads (64ca208)
- **search**: preserve destination notebook after opening a result (#166) (8f06e93)
- **notes**: show rename in notebook tree context menu (e92279d)
- **notes**: make icon picker race-safe and keyboard friendly (#171) (1c25488)
- **notes**: recreate note icon table after database reset (#171) (e20e4b7)
- **habits**: respect read-only workspace permissions (816827a)
- **habits**: preserve history and validate check-in dates (b24db8c)
- **ui**: load global overlay layer contract (#192) (6558af4)
- **ui**: define settings modal overlay layer (#192) (9c56278)

### ♻️ 重构

- **siyuan**: preserve legacy import implementations (#196) (b243f34)
- **notes**: remove superseded note icon bridge (#171) (6f83dd2)
- **notes**: use stable note icon bridge (#171) (769d3a1)
- **notes**: make note icon DOM integration idempotent (#171) (c8314e8)
- **notes**: isolate note icon picker dialog (#171) (c5aa0db)

### 📝 文档

- add share lightbox control reference (cc4a0e7)
- add mobile image menu issue evidence (0a6653e)
- add live-preview reference screenshot for issue #198 (b1b7021)
- add code-block reference screenshot for issue #198 (e3e98ac)
- add task-list screenshot for issue #198 (16f4e4f)
- add screenshot for issue #198 (dd6853f)

### ✅ 测试

- **sync**: preserve same-revision offline fingerprints (#200) (01fcfd1)
- **sync**: exercise large-body shrink threshold (#200) (1a6d22d)
- **sync**: cover scoped destructive snapshots (#200) (dd804fd)
- **sync**: require identity fields in update responses (#200) (520a818)
- **sync**: require server identity fields for detail cache (#200) (52ca0c9)
- **sync**: distinguish cached details and placeholders (#200) (95f2dca)
- **sync**: reject incomplete cached note details (#200) (08defa4)
- **sync**: reject incomplete update acknowledgements (#200) (c4fa4f3)
- **sync**: cover same-version body mismatches (#200) (9d0fbdd)
- **sync**: use live timestamps for conflict drafts (#200) (e3e3400)
- **sync**: update optimistic-lock expectations (#200) (d5d3d01)
- **sync**: verify guarded note writes end to end (#200) (24582b3)
- **sync**: preserve draft conflict baselines (#200) (9cf3e71)
- **sync**: cover automatic pre-overwrite snapshots (#200) (2c8e376)
- **sync**: cover note write confirmation and conflicts (#200) (ca2ea5d)
- **sync**: prevent blind optimistic-lock replays (#200) (06198d4)
- **markdown**: cover live block decoration installation (#198) (bbbcf26)
- **images**: cover mobile image focus release (#199) (e068437)
- **images**: cover mobile sheet and lightbox navigation (#199) (17a39b9)
- **markdown**: cover tasks and enhanced code blocks (#198) (fd83cb3)
- **markdown**: cover mapped scroll interpolation (#198) (84eafd0)
- **emoji**: start issue 170 validation (c9f0b2d)
- **emoji**: cover categories search and recents (#170) (022a16c)
- **markdown**: isolate HTML preview globals (#196) (7d2c968)
- **markdown**: cover sanitized HTML and iframe rendering (#196) (6427be1)
- **siyuan**: cover order emoji HTML and iframe fidelity (#196) (e498496)
- **ai**: assert normalized profile request headers (#197) (237558f)
- **ai**: cover AI profile client (#197) (4f01866)
- **ai**: cover profiles and model discovery (#197) (24fd351)
- **android**: keep binary API reads on fetch (f4613cf)
- **android**: cover native-first API transport (7ac3627)
- **search**: cover match counts and result metadata (#166) (abf42df)
- **notes**: cover note icon metadata permissions (#171) (d84ec1f)
- **habits**: cover archived stats and validation regressions (2cce98d)

### 🔧 其他

- simplify question issue form (e53f492)
- simplify feature request form (0abd199)
- simplify bug issue form (74da975)
- remove unused issue 198 workflow (5a1256b)
- remove unused issue 198 codemod (b94f4c0)
- run issue 198 implementation and validation (bdd6c56)
- add one-shot markdown experience codemod (#198) (a119e85)
- remove issue 170 validation workflow (39f80a0)
- run one-shot sidebar emoji picker codemod (#170) (bd6960e)
- add one-shot sidebar emoji picker codemod (#170) (b8e759c)
- add usage question issue form (ba24df6)
- add structured feature request form (907cf41)
- add structured bug report form (6448da8)
- configure GitHub issue templates (38a408b)
- remove unused issue #171 PR workflow (37ac2b2)
- remove unused issue #171 apply workflow (26dc740)
- add one-shot PR trigger for issue #171 (659a4c2)
- apply issue #171 implementation (8743075)


## v1.3.1 - 2026-07-09

### ✨ 新增

- **editor**: 优化分屏拖拽 UI 并添加国际化支持 (b0fd101)
- **editor**: 支持分屏宽度拖拽调整、GFM任务复选框交互，优化标题保存逻辑 (96fe728)
- **editor**: 新增分屏拖拽和GFM任务复选框工具模块及测试 (da43c6f)
- **notebooks**: support drag reorder and per-level sort in notebook tree (50eeb2b)
- **notebooks**: add notebook tree sorting (c5b33ec)
- **tasks**: support delayed quick-add reminders (ff023b7)
- **editor**: add canvas image editor (62e627a)
- **editor**: add image action toolbar (a4e62b1)
- **tasks**: smart quick-add recognition (2e0ea40)
- **import**: safely preserve advanced Siyuan rich-text nodes (62e10c2)
- **import**: preserve Siyuan tables in rich-text import (19aab69)
- **import**: improve Siyuan rich-text tiptap fidelity (696e2c4)
- prompt for desktop data directory on first run (#168) (eab97d2)

### 🐛 修复

- **editor**: support line breaks in code blocks (d03a828)
- **editor**: copy image address with origin (c9e0852)
- **editor**: place image toolbar outside image (c179ae9)
- **editor**: keep note sort menu content aligned (327f392)
- **editor**: harden canvas image loading (57bf39c)
- **editor**: guard image replace target (f60fd65)
- **tasks**: require separators for smart recognition (a01d99c)
- 优化思源包导入服务与测试 (a88eb1f)
- guard siyuan zip entry and decompressed size budgets (4418a2c)
- add upload size limits for siyuan package import (891953a)
- keep backend bundle compatible with unzipper s3 helper (c3ed8c3)
- **import**: surface siyuan downgrade report and clean temp artifacts (9d81832)
- **import**: improve md rendering and downgrade reporting (a6c9781)
- **import**: support RT/MD siyuan media rendering (0305b28)
- **ci**: sync backend lockfile for npm ci (0b8551b)

### ✅ 测试

- cover backend siyuan package import (b5fe890)

### 🔧 其他

- 将开发期错误日志加入忽略列表 (84547a1)
- commit all local changes (b80bc3b)

### 📌 杂项

- 功能: 新增用户偏好设置接口与前端集成 (37a24b2)
- 功能: 接口层增加 Android 原生 HTTP 回退机制 (1a08701)
- 功能: AI 设置面板新增自定义 API 预设并优化 Ollama 预设 (8682237)


## v1.3.0 - 2026-07-07

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_


## v1.2.9 - 2026-07-07

### ✨ 新增

- support custom desktop data directory (#168) (82babec)


## v1.2.8 - 2026-07-07

### ✨ 新增

- combine notebook tree expand toggle (5a283c6)
- add notebook tree expand collapse actions (#162) (add6eba)
- 标题输入框增加 IME 输入法状态感知，避免拼音串被误保存为标题 (9051ece)
- add browser-side size check and asset reference filtering for Siyuan import (fd6879a)

### 🐛 修复

- align notebook tree toggle icon state (3d37362)
- restore cross-device editor sync (da772b4)
- scroll markdown preview outline headings (#163) (b385fb9)
- support markdown default preview and siyuan callouts (#164) (4e94e0a)


## v1.2.7 - 2026-07-06

### ✨ 新增

- HTML 预览资源/大纲提取与编辑器联动优化 (8f46ae0)
- 任务重复/到期计算、导入导出、编辑器与任务面板优化 (25c6050)


## v1.2.6 - 2026-07-06

### ✨ 新增

- add EditorSplitView component (e574cbd)
- add NoteTabsBar and tab navigation system (b4dbfe9)
- add SiYuan SY parser and enhance import service (7d5d4c9)
- add SiYuan note import service (28cd137)

### 🐛 修复

- support manual note sorting (510bed7)
- 修复安全设置、任务中心及分享笔记等问题 (8f2565d)
- 优化登录页组件 (4c8be41)
- 优化登录页组件与国际化 (797be4c)
- 优化桌面端登录与导航组件 (539faf9)
- 优化Electron构建、日记中心及笔记列表 (865dc02)
- 优化笔记列表与标签页组件 (adec6f1)
- improve NoteTabsBar and AppContext integration (6a589a8)
- update Sidebar component (8b0ece9)
- update DataManager and i18n (aea3ac0)
- handle deleted notebooks in export/import flow (bf74ff9)
- enhance SiYuan import media asset handling (dd1d64a)
- improve SiYuan import service and i18n (ad29c60)


## v1.2.5 - 2026-07-03

### ✨ 新增

- 添加笔记本创建笔记功能 (6fe2abd)
- 添加任务日期 SQL 模块和附件 API 测试 (34b9ccd)
- add task calendar feed settings (6934d39)

### 🐛 修复

- 修复任务日历订阅带时间事件无法显示 (08b33b6)
- update Capacitor config (8ffe1a1)

### 📝 文档

- clarify arm64 docker and desktop support status (e59b3ee)

### 📦 构建

- add experimental linux arm64 desktop packaging entry (f86ff27)

### 📌 杂项

- Fix packaged app startup and client connectivity (f9befe7)


## v1.2.4 - 2026-07-02

### ✨ 新增

- source ICP filing from docker env (8eabf91)
- render database ICP filing on login page (6816e29)
- add ICP filing input in appearance settings (46f22a1)
- expose ICP filing site setting (f5deabd)
- add ICP filing setting (3dbfad6)
- add configurable ICP filing footer (15f7f53)
- copy personal notebooks to workspace (d06a70a)
- add rich text line height controls (86c5079)
- 添加Markdown视频预览与思维导图视口支持 (df167f8)
- support markdown preview in task details (df480f2)
- add postgres database adapter (PG-ADAPTER-02) (84acd7f)
- add database dialect helpers (PG-DIALECT-01) (aa6230b)
- add remaining async methods for task projects repository (FINAL) (6a9ef71)
- add remaining async methods for note links repository (C-A.5) (63fc2f1)
- add async replace links transaction for note links repository (C-A.4) (e7ca15a)
- add multi statement transaction support to sqlite adapter (C-A.1.1) (5fd016d)
- add async sort order update for task projects repository (C-A.3) (044500f)
- use executeBatch for system settings async setMany (C-A.2) (11e5ac9)
- add executeBatch to sqlite adapter (C-A.1) (5532f45)
- add bulk revoke and cleanup async methods for user sessions repository (B3-B2) (c7401a2)
- add revoke and list active async methods for user sessions repository (B3-B1) (bf4226a)
- add basic async methods for user sessions repository (B3-A) (bd3dc99)
- add async methods for workspace members repository (8d8bf12)
- **editor**: localize remote images on paste (PASTE-REMOTE-IMAGE-LOCALIZE-01) (296d138)
- **tasks**: add select all/deselect all in batch mode (0c1f688)
- **calendar**: schedule S3 export target refresh (TASK-CALENDAR-EXPORT-STORAGE-01-TIMER) (ffd5129)
- **calendar**: add S3 export target settings UI (TASK-CALENDAR-EXPORT-STORAGE-01-UI) (f343060)
- **say**: support markdown rendering in posts (SAY-MARKDOWN-INPUT-01) (87ff599)
- **calendar**: add S3 export target backend (TASK-CALENDAR-EXPORT-STORAGE-01-BE) (3bf11d5)
- **editor**: 点击块级引用后跳转到目标 heading 并高亮 (BLOCK-LINKS-JUMP-01) (b19b961)
- **editor**: [[ 引用时支持选择目标笔记标题块 (BLOCK-LINKS-UI-01) (ddebbb3)
- **db**: note_links 扩展块级引用支持 (BLOCK-LINKS-01) (b242e4c)
- **editor**: heading blockId 稳定生成 (BLOCK-ID-01) (1aaca83)
- **tasks**: lunar UI, i18n, tests (TASK-RECURRENCE-LUNAR-01) (1e39699)
- **tasks**: support lunar yearly recurrence (TASK-RECURRENCE-LUNAR-01) (9145328)
- **db**: add foreign keys to note_links table (NOTE-LINKS-FK-MIGRATION-01) (ba114d0)
- **backlinks**: add backlinks panel for note references (BACKLINKS-02) (d20df77)
- **tasks**: support custom recurrence rules (TASK-RECURRENCE-CUSTOM-01) (f3683f0)
- **tags**: auto-prune unused tags after note delete (TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01) (8381830)
- **editor**: add note link reference with [[ trigger (BACKLINKS-01) (251666a)
- **journal**: add year-month archive view (JOURNAL-YEAR-MONTH-01) (056d651)
- **table**: improve mobile table editing toolbar (MOBILE-TABLE-EDITING-UX-01) (1c86d55)
- **journal**: add one-click today journal creation (JOURNAL-AUTO-DATE-01) (3cb743c)
- **table**: smart actions for phone numbers in table cells (TABLE-CELL-SMART-ACTIONS-01) (8c96fd9)
- **diary**: support custom publish date for moments (MOMENT-PUBLISH-DATE-01) (0929f08)
- **ui**: redesign diary layout with sidebar for desktop (SAYING-UI-DESKTOP-RV1) (e1dd92b)
- **auth**: add QR code for 2FA setup (AUTH-2FA-QR-01) (7eccea4)
- **tags**: multi-tag AND filtering (TAG-FILTER-MULTI-01) (c46aa33)
- add calendar button to sayings filter bar (SAYING-CALENDAR-PANEL-01) (6030714)
- **files**: show attachment folders in file manager (FILE-MANAGER-FOLDER-VIEW-01) (4806c17)
- show last saved time in editor sync status (SAVE-STATUS-LAST-SAVED-01) (831a060)
- file upload dialog with folder support (FILE-UPLOAD-DIALOG-FOLDER-01) (16e13e5)
- unify note creation menu in notebook tree (NOTE-CREATE-MENU-UNIFY-01) (90565ba)
- add collapsible code blocks (CODE-BLOCK-COLLAPSE-01) (8d2e682)
- add markdown note creation from notebook tree (NOTE-TREE-MARKDOWN-CREATE-01) (badb00e)
- group file manager attachments by notebook path (ATTACHMENT-DIRECTORY-ORGANIZE-01-E) (5d81115)

### 🐛 修复

- prevent title-only observer from freezing login (fabefcf)
- keep note list title toggle compact (8223b24)
- defer note list title-only observer until note list mounts (35e4a5a)
- load note list title-only mode with app bootstrap (17a812b)
- auto-start note list title-only mode (4969674)
- add note list title-only display mode (3cf78bc)
- **mcp**: create markdown notes with contentFormat (bd420d7)
- add issue 145 global UI guards (1db2eff)
- add issue 145 UI guard styles (f07fad9)
- allow larger custom font uploads (b80eb3e)
- prevent cached site settings on login page (dbf2b5a)
- persist and show ICP filing on desktop login (b533096)
- show database ICP filing on login page (ea16fbe)
- render database ICP filing on login page (97ad302)
- show ICP filing only on login page (a9a4aa7)
- keep ICP footer visible after login (b006428)
- preserve icp setting in settings responses (6583d57)
- refresh site settings on server url change (1fb54bf)
- disable mobile haptics and support pull refresh (2fa2c22)
- default ICP footer link when URL env is absent (ee35b46)
- rollback database when backup restore fails (b40fe16)
- show boot loading during remote startup (b76074e)
- move selected mind map nodes together (c9d95a6)
- use DOM hit testing for mind map selection (016c8aa)
- correct mind map selection hit testing (5b41888)
- make uploaded video previews compact (5e64fbc)
- support uploaded video previews in editor (431f4e2)
- harden note save conflict handling (7fdde21)
- improve note version history recovery flow (280f0e2)
- preserve content format in note version history (9c8e106)
- stop offline queue overwriting version conflicts (3837084)
- render markdown notes correctly when exporting images (88d4cf7)
- use sqlite string literal in task batch completion (ca49da5)
- resolve backend typecheck release blockers (b537dd2)
- repair user sessions SQL string quoting (f4b02ae)
- quote camelCase columns in folder sync files repository (929bf90)
- quote camelCase columns in embedding queue repository (2ee8837)
- quote camelCase columns in workspace invites repository (94b40e6)
- quote camelCase columns in task templates repository (8dd7af8)
- quote camelCase columns in task projects repository (1f9ade4)
- quote camelCase columns in calendar export targets repository (38e58e5)
- quote camelCase columns in api tokens repository (cca0b31)
- quote camelCase columns in share comments repository (2ca4ce2)
- quote camelCase columns in notebook share links repository (2a4ec85)
- quote camelCase columns in notebook members repository (42343b1)
- quote camelCase columns in user sessions repository (e66c3e2)
- quote camelCase columns in workspace members repository (813f706)
- quote camelCase columns in note versions repository (1b00230)
- quote camelCase columns in note links repository (b446abd)
- quote camelCase columns in attachment references repository (c58ef87)
- quote camelCase columns in tags repository (929efab)
- quote camelCase columns in note tags repository (5d9ef9d)
- quote camelCase columns in favorites repository (c8d2a29)
- quote camelCase columns in custom fonts repository (019e696)
- quote postgres camelCase column in system settings pilot (15622a2)
- **db**: fix null vs undefined type mismatch in share comments (DB-REPOSITORY-ACCEL-01-PARTIAL-FIX-BATCH-RV-FIX1) (be57e9a)
- **db**: migrate acl and notebook-permissions to repository pattern (DB-REPOSITORY-ACCEL-01-ACCEL-BATCH1) (18a4d3a)
- **db**: partial workspace members repository migration (DB-REPOSITORY-ACCEL-01-WORKSPACE-MEMBERS-FIX1) (7b675fe)
- **db**: complete share comments repository migration (DB-REPOSITORY-ACCEL-01-SHARE-COMMENTS-FIX1) (3a2477c)
- **db**: complete note versions repository migration (DB-REPOSITORY-ACCEL-01-NOTE-VERSIONS-FIX2) (95764c3)
- **db**: fix syntax error in workspaces.ts (DB-REPOSITORY-ACCEL-01-POST-B6-BULK-RV-FIX1) (c198729)
- **db**: complete task templates repository migration (DB-REPOSITORY-ACCEL-01-B-TASK-TEMPLATES-FIX1) (99b1589)
- **db**: complete note versions migration for users.ts (DB-REPOSITORY-ACCEL-01-B-NOTE-VERSIONS-FIX1) (31bc29c)
- **db**: complete notebook members migration for list and get operations (DB-REPOSITORY-ACCEL-01-B15-FIX1) (10d25b2)
- **db**: complete share comments migration for users.ts (DB-REPOSITORY-ACCEL-01-B16-FIX1) (17a4534)
- **db**: complete task attachments migration for data-file.ts (DB-REPOSITORY-ACCEL-01-B9-FIX2) (efe55d6)
- **db**: complete workspace members repository migration for users.ts (DB-REPOSITORY-ACCEL-01-B14-FIX1) (a7e34b8)
- **db**: add attachment references check methods (DB-REPOSITORY-ACCEL-01-B10-FIX1) (13635fc)
- **db**: add task attachments backup methods (DB-REPOSITORY-ACCEL-01-B9-FIX1) (baf2f1b)
- **db**: complete note yjs tables repository migration (DB-REPOSITORY-ACCEL-01-B11-B13-FIX1) (25175f2)
- **db**: complete workspace invites repository migration (DB-REPOSITORY-ACCEL-01-B6-FIX1) (b472637)
- **db**: complete mindmap folders repository migration (DB-REPOSITORY-ACCEL-01-B3-FIX2) (71446c4)
- **db**: complete folder metadata repository migration (DB-REPOSITORY-ACCEL-01-B3-FIX1) (fd6bf29)
- **build**: SEC-ELECTRON-01-E4.2 收敛 Electron 打包文件配置 (853c3ab)
- **security**: SEC-ELECTRON-01-E3.4 修正 meta CSP 兼容性 (66eaa7a)
- **security**: SEC-ELECTRON-01-E3.2 添加 CSP Report-Only 注入 (a1a6d19)
- **security**: SEC-ELECTRON-01-E2 添加权限请求拦截 (a23d5a1)
- **security**: add electron CSP meta policy (SEC-ELECTRON-01-E1-B1) (98d5ef0)
- **typecheck**: TYPECHECK-DEBT-01 清理预存类型错误 (e0d7903)
- **security**: harden folder sync file read boundary (SEC-ELECTRON-01-D4-B1) (3f65a25)
- **security**: SEC-ELECTRON-01-D3.2 收敛 PDF iframe sandbox 权限 (5b06d5f)
- **security**: SEC-ELECTRON-01-D3 附件预览安全 - PDF iframe sandbox + highlight.js DOMPurify (c83d3f7)
- **security**: SEC-ELECTRON-01-D4 folder-sync 扫描跳过 symlink 文件 (0298ebe)
- **security**: SEC-ELECTRON-01-D2 文件打开边界 - symlink 拒绝 + 路径脱敏 (6392325)
- **security**: SEC-ELECTRON-01-C-RV1 补齐 IPC 与 preload 双层校验 (f3925a7)
- **security**: SEC-ELECTRON-01-C IPC 与 preload 权限收敛 (c60888f)
- **security**: SEC-ELECTRON-01-B-RV1 sender 严格绑定 + setup IPC 校验 + 日志脱敏 (98a97c9)
- **electron**: deny window.open in data windows (SEC-ELECTRON-01-C-B2-B3) (7122e1b)
- **electron**: tighten main window navigation guard (SEC-ELECTRON-01-C-B1-FIX1) (3985aae)
- **electron**: guard main window navigation (SEC-ELECTRON-01-C-B1) (8b44ec7)
- **electron**: confirm before resetting local auth (SEC-ELECTRON-01-B2-B1) (ca3839c)
- **security**: SEC-ELECTRON-01-B Electron 最小高危修复 (1925304)
- **electron**: validate external URL protocols (SEC-ELECTRON-01-B1) (74feeba)
- **security**: SEC-XSS-01-E-RV1 parseVideoUrl 协议白名单修复 (e65c862)
- **security**: SEC-XSS-01-E Video iframe / Mermaid / KaTeX 安全兜底 (0cc0842)
- **security**: SEC-XSS-01-D 剪贴板粘贴 HTML 清洗 (1d712a6)
- **security**: SEC-XSS-01-C-RV1 CSP 生效位置修复 + data: 协议收紧 (c3f208a)
- **security**: 安全加固复审验收 (SECURITY-HARDENING-RV1) (f142992)
- **tasks**: 已完成任务的日期标签不再显示"已逾期" (e71c67b)
- **tasks**: remove duplicate batch route (TASK-BATCH-ACTION-500-01-RV2) (d9a5dd3)
- **tasks**: return safe errors for batch actions (TASK-BATCH-ACTION-500-01-RV1) (2c55e64)
- **tasks**: add comprehensive error handling for batch endpoint (d09cd25)
- **tasks**: add try-catch in batch complete to prevent 500 error (9f87408)
- **electron**: open associated markdown files directly (PC-MD-FILE-ASSOCIATION-OPEN-01) (960d461)
- **tags**: limit tag name length and truncate display (TAG-LENGTH-LIMIT-01) (7c736d2)
- **editor**: 修复 LaTeX 公式导致刷新后笔记内容丢失 (4a398b0)
- **editor**: replace HeadingItem with NoteEditorHeading in EditorPane (50d1f5f)
- **editor**: resolve HeadingItem type conflict in TiptapEditor (e529e4c)
- **calendar**: show absolute ICS subscription URL (BUG-CALENDAR-ICS-ABSOLUTE-URL-01) (6c66f11)
- **electron**: 修复 macOS ARM Traffic Light 按钮错位和拖拽问题 (e4afe02)
- **auth**: 退出登录时清除自动登录凭据 (c82c7c0)
- **journal**: 修复点击今日日记时 AnimatePresence 重复 key 警告 (bf992a9)
- **calendar**: correct S3 signing path for export targets (TASK-CALENDAR-EXPORT-STORAGE-01-BE-RV1) (ea5cfa4)
- **editor**: 显式引入 Link 扩展并配置 note: 协议 (BLOCK-LINKS-UI-01-RV3-LINK-PERSIST-DEEP-CHECK) (70b87ac)
- **editor**: 在 tiptapExtensions 中允许 note: 协议 (BLOCK-LINKS-UI-01-RV3-LINK-PERSIST-DEEP) (670cee0)
- **editor**: 允许 Link mark 使用 note: 协议 (BLOCK-LINKS-UI-01-RV2-LINK-PERSIST) (fc6e3e2)
- **diary**: prevent mood filter 'All moods' text wrapping (SIDEBAR-DIARY-SECTION-REMOVE-01) (6e76a21)
- **sidebar**: remove diary section from notes sidebar (SIDEBAR-DIARY-SECTION-REMOVE-01) (05380df)
- **db**: 添加 v39 迁移 (calendar-export-targets) (60c1d0f)
- **editor**: BLOCK-LINKS-UI-01-RV1 修复 triggerFrom 删除范围 (e8286be)
- **editor**: BLOCK-ID-01-RV1 修复 appendTransaction 和 schema 兼容性 (2445e20)
- **mindmap**: ensure schema for folders and reload list (BUG-MINDMAP-RELOAD-500-01) (d9352a1)
- **backlinks**: RV1 fixes for note_links cleanup and linkText (BACKLINKS-02-RV1) (be40897)
- **tasks**: prevent month/year overflow in custom recurrence (TASK-RECURRENCE-CUSTOM-01-RV1) (2118109)
- preserve viewMode context when pruning invalid selectedTagIds (TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01-RV2) (dd52e9d)
- **tags**: cleanup invalid selectedTagIds after prune (TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01-RV1) (678609e)
- **editor**: fix note link search and trigger position (BACKLINKS-01-RV1) (9677b0b)
- **tags**: refresh tags after note delete/trash (TAG-CLEANUP-ON-NOTE-DELETE-01) (9ddc763)
- **calendar**: support token-based public ICS subscription (TASK-CALENDAR-SUBSCRIBE-01-RV1) (09e1c6d)
- **journal**: add refresh token for archive data (JOURNAL-YEAR-MONTH-01-RV1) (0f11186)
- **table**: add toggleHeaderColumn and remove dead state (MOBILE-TABLE-EDITING-UX-01-RV1) (394dcc2)
- **journal**: change GET to POST and add unique index (JOURNAL-AUTO-DATE-01-RV1) (f01eb53)
- **diary**: desktop layout cohesion and visual noise reduction (SAYING-UI-DESKTOP-RV2) (2448059)
- **diary**: fix timezone offset in custom date (MOMENT-PUBLISH-DATE-01-RV1) (042d5a0)
- **share**: align image layout with editor rendering (BUG-SHARED-NOTE-IMAGE-LAYOUT-01) (2c18683)
- **files**: add missing ListView props in grouped view (FILE-MANAGER-TSC-DEBT-01) (69d97e9)
- **tags**: RV1 regression fixes for multi-tag filtering (TAG-FILTER-MULTI-01-RV1) (758a2a2)
- **i18n**: add diary calendar title translation (SAYING-CALENDAR-PANEL-01) (ed7f090)
- **desktop**: support api-only remote servers (BUG-DESKTOP-REMOTE-API-ONLY-01) (9af904e)
- **files**: show empty attachment folders in folder view (FILE-MANAGER-FOLDER-VIEW-01-RV1) (444c328)
- **files**: invalidate cache before refreshing after upload (BUG-FILE-UPLOAD-LIST-REFRESH-01) (4fa7522)
- **files**: update folderId on hash dedup hit (b188eff)
- **auth**: prevent account data leakage on user switch (13ddde0)
- **security**: prevent account data leak after switching users (AUTH-ACCOUNT-SECURITY-CACHE-01) (2e4bd36)
- extract parseServerTime to shared dateTime utility (NOTE-EXPORT-TIME-01-RV1) (5b890e1)
- parse backend timestamps as UTC in note export (NOTE-EXPORT-TIME-01) (0b2276c)
- **files**: deduplicate items to prevent repeated group rendering (cbde17b)
- use correct translation alias in MarkdownEditor status bar (MARKDOWN-EDITOR-RUNTIME-01) (2b85dc3)
- merge create note split-button into unified dropdown trigger (NOTE-LIST-NEW-MENU-01) (fc9783c)
- **files**: remove extra closing div causing JSX error (aaac0cf)
- **files**: toolbar layout regression - missing closing div + search overflow (a8e208b)
- **ui**: move storage badge inline with title in FileManager header (FILE-MANAGER-HEADER-UI-01) (98a5c8b)
- **editor**: markdown status bar char/word count display (0656e04)
- close unclosed div tag in FileManager.tsx (0cc6c94)
- remove duplicate ChevronDown import in FileManager.tsx (63c83e7)
- **files**: mobile layout + download compatibility (9239047)

### ♻️ 重构

- clean appearance settings after ICP removal (b078379)
- hide ICP input in appearance settings (08ac7f7)
- make ICP filing read-only site config (5a39fab)
- remove ICP filing from editable settings (cf1fd3b)
- hide global ICP footer outside login page (8ff2b24)
- define DatabaseAdapter interface (PG-ADAPTER-01) (5200851)
- **db**: add async methods for workspace members repository (B2-C) (93b7763)
- **db**: add async methods for note acl repository (B2-B) (53d2a01)
- **db**: add async methods for notebookMembersRepository (B2-A) (bf83c39)
- **db**: add batch 07 B1 remaining async repository pilots (32cd139)
- **db**: add batch 07 B1 async repository pilots (79e540e)
- **db**: add batch 06 A-level async repository pilots (8aa710d)
- **db**: add batch 05 A-level async repository pilots (decc07b)
- **db**: add batch 04 A-level async repository pilots (e432b63)
- **db**: add calendar export targets async repository pilot (DB-SQLITE-ASYNC-REPOSITORY-PILOT-BATCH-03-CALENDAR-TARGETS) (106c7af)
- **db**: add batch async repository pilots (DB-SQLITE-ASYNC-REPOSITORY-PILOT-BATCH-02) (90943d3)
- **db**: add custom fonts async repository pilot (DB-SQLITE-ASYNC-REPOSITORY-PILOT-02-CUSTOM-FONTS) (9fbf2b4)
- **db**: add sqlite async adapter pilot (DB-SQLITE-ASYNC-ADAPTER-PILOT-01A) (a8e1b54)
- **db**: add member query service pilot (DB-QUERY-LAYER-02-MEMBER-PILOT) (333f23c)
- **db**: add attachment query service pilot (DB-QUERY-LAYER-01-ATTACHMENT-PILOT) (c2d99cc)
- **db**: move embedding queue into repository (DB-REPOSITORY-ACCEL-01-B18) (548fd8d)
- **db**: move diary attachments into repository (DB-REPOSITORY-ACCEL-01-B17) (73d6e62)
- **db**: move share comments into repository (DB-REPOSITORY-ACCEL-01-B16) (b104973)
- **db**: move notebook members into repository (DB-REPOSITORY-ACCEL-01-B15) (27058fa)
- **db**: move workspace members into repository (DB-REPOSITORY-ACCEL-01-B14) (7f6c19c)
- **db**: move note Y-updates into repository (DB-REPOSITORY-ACCEL-01-B13) (2159237)
- **db**: move attachment chunks into repository (DB-REPOSITORY-ACCEL-01-B12) (0f1a355)
- **db**: move note Y-snapshots into repository (DB-REPOSITORY-ACCEL-01-B11) (9a7443e)
- **db**: move attachment references into repository (DB-REPOSITORY-ACCEL-01-B10) (9c1a1b5)
- **db**: move task attachments into repository (DB-REPOSITORY-ACCEL-01-B9) (58b6e56)
- **db**: move note ACL into repository (DB-REPOSITORY-ACCEL-01-B8) (e14cd19)
- **db**: move notebook share links into repository (DB-REPOSITORY-ACCEL-01-B7) (d4a1247)
- **db**: move workspace invites into repository (DB-REPOSITORY-ACCEL-01-B6) (8983d46)
- **db**: move task dependencies into repository (DB-REPOSITORY-ACCEL-01-B5) (1e546e4)
- **db**: move task calendar feeds into repository (DB-REPOSITORY-ACCEL-01-B4) (7960a2b)
- **db**: move folder metadata tables into repositories (DB-REPOSITORY-ACCEL-01-B3) (3138eb8)
- **db**: move task metadata tables into repositories (DB-REPOSITORY-ACCEL-01-B2) (9dec2e3)
- **db**: DB-REPOSITORY-ACCEL-01-B1 迁移 favorites + user_sessions Repository (90bddd7)
- **db**: move note_versions delete cleanup into repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B2-B3) (a8ea3ae)
- **db**: move note_versions insert into repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B2-B2) (db51d49)
- **db**: move note version reads to repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B2-B1) (efe04bd)
- **db**: move ai custom prompts to repository (DB-REPOSITORY-NEXT-CANDIDATES-01-B1) (0b4ecf8)
- **db**: move note tag filtering to repository (DB-REPOSITORY-TAGS-COMPLETE-01-B2) (e119b38)
- **db**: move note tag links to repository (DB-REPOSITORY-TAGS-COMPLETE-01-B1B3) (c20eb53)
- **db**: move tag deletion to repository (DB-REPOSITORY-PILOT-NEXT-D1-C3) (4e1c810)
- **db**: move tag update to repository (DB-REPOSITORY-PILOT-NEXT-D1-C2) (d599f38)
- **db**: move tag creation to repository (DB-REPOSITORY-PILOT-NEXT-D1-C1) (54e4f57)
- **db**: move single tag query to repository (DB-REPOSITORY-PILOT-NEXT-D1-B) (7ce30c5)
- **db**: move tag list query to repository (DB-REPOSITORY-PILOT-NEXT-D1-A) (e38948d)
- **db**: move note link delete cleanup to repository (DB-REPOSITORY-PILOT-NEXT-C3) (10e1eff)
- **db**: move note link sync writes to repository (DB-REPOSITORY-PILOT-NEXT-C2) (68fa5c3)
- **db**: move note backlinks query to repository (DB-REPOSITORY-PILOT-NEXT-C1) (6edba78)
- **db**: migrate calendar export targets to repository (DB-REPOSITORY-PILOT-NEXT-B) (fb9bf88)
- **db**: add calendar export targets repository (DB-REPOSITORY-PILOT-NEXT-B) (73c1df9)
- **db**: route api token usage pruning through repository (DB-REPOSITORY-PILOT-02-C3) (cfe6fe3)
- **db**: route api token usage recording through repository (DB-REPOSITORY-PILOT-02-C2-B) (5266f36)
- **db**: route api token last-used update through repository (DB-REPOSITORY-PILOT-02-C2-A) (c7f2f81)
- **db**: route api token lookup through repository (DB-REPOSITORY-PILOT-02-C1) (0879a79)
- **db**: add api tokens repository for token routes (DB-REPOSITORY-PILOT-02-B) (5dd578c)
- **db**: route vec_dim setting through repository (DB-REPOSITORY-PILOT-01-B) (81e2bf7)
- add system_settings and custom_fonts repositories (DB-REPOSITORY-PILOT-01-A) (71aab0c)

### 📝 文档

- document ICP filing docker env (4a0511f)
- mark PG-PILOT-03 fully closed (150a253)
- mark PG-PILOT-02 fully closed (75cd60d)
- mark PG-PILOT-01 fully closed (1f4cffd)
- document postgres pilot validation blocker (5c43575)
- add postgres schema sql draft (PG-SCHEMA-02) (b176cac)
- add postgres schema migration plan (PG-SCHEMA-01) (ac6fe31)
- add repository pilot guide and migration rules (bed266b)

### 💄 样式

- **css**: 修复 Traffic Light 相关注释乱码 (ef71944)

### ✅ 测试

- assert ICP env source is documented in seed (b0a067a)
- cover ICP docker env source (a8474b5)
- update ICP site settings expectations (a77105b)
- cover rich text note version restore (4b9efd7)
- add postgres pilot for note tags repository (4bfaf3e)
- add postgres pilot for favorites repository (837b022)
- add postgres pilot for custom fonts repository (766356e)
- align postgres pilot test environment (a1d801d)
- add postgres pilot coverage for system settings repository (PG-PILOT-01) (8f16968)
- fix known isolation test failures (1edc05c)
- add repository-level atomicity rollback test for replaceLinksForSourceAsync (8b7ae9c)
- add serial test script for db isolation (TEST-ISOLATION-01-A) (841884b)
- **db**: add sqlite adapter behavior tests (DB-SQLITE-ASYNC-ADAPTER-PILOT-01B-TEST) (5d5b573)

### 🔧 其他

- tune sidebar layout constants (22e3ebf)
- define default ICP footer env values (09fc815)
- add postgres local development environment (PG-DOCKER-01) (776d35e)
- **journal**: 移除今日日记按钮 (af399c1)
- 从版本控制中移除 tsconfig.tsbuildinfo (78c7ddd)
- 将 tsconfig.tsbuildinfo 加入 .gitignore (f518a5f)
- **skills**: 添加中文提交规范 skill (9d2f2a1)
- exclude dist-electron-lite build artifacts from git (3c72186)

### 📌 杂项

- @ fix(security): SEC-XSS-01-C 分享页渲染清洗 + CSP 头 (9d07b6c)
- @ fix(security): SEC-XSS-01-B HTML 安全清洗最小实施 (19cb69b)


## v1.2.3 - 2026-06-26

### 🐛 修复

- ensure uploaded images render after local fallback (BUG-IMAGE-UPLOAD-PREVIEW-01) (b94deff)

### ♻️ 重构

- unify local attachment upload paths (ATTACHMENT-DIRECTORY-ORGANIZE-01-B) (bdf1431)

### 🔧 其他

- remove accidental noop file (f8b27a2)

### 📌 杂项

- noop (309d536)


## v1.2.2 - 2026-06-25

### ✨ 新增

- integrate image hosting into editor paste/drag/insert flows (IMAGE-HOSTING-INTEGRATE-01) (7865550)
- extraction status and logging for PDF/DOCX sync (DESKTOP-FOLDER-KB-SYNC-02-E.3) (eecb94e)
- extract PDF/DOCX text into contentText for search (DESKTOP-FOLDER-KB-SYNC-02-E.2) (35fb01c)
- third-party image hosting with S3-compatible storage (IMAGE-HOSTING-ENHANCE-01) (c5ed326)
- PDF/DOCX attachment sync UI and docs (DESKTOP-FOLDER-KB-SYNC-02-D) (67d0d85)
- support PDF/DOCX attachment upload in folder sync (DESKTOP-FOLDER-KB-SYNC-02-B) (d59f258)
- auto sync observability and safety (DESKTOP-FOLDER-KB-SYNC-01-E.2.1) (d46340d)
- folder sync file import with attachment support (DESKTOP-FOLDER-KB-SYNC-01-C.2) (19114c1)
- auto folder sync during app runtime (DESKTOP-FOLDER-KB-SYNC-01-E.2) (a5b1ab1)
- add folder sync interval config UI (DESKTOP-FOLDER-KB-SYNC-01-E.1) (0809ba5)
- enhance folder sync status display and logs (DESKTOP-FOLDER-KB-SYNC-01-D) (f702777)
- desktop folder sync upload for text files (DESKTOP-FOLDER-KB-SYNC-01-C.3) (ffe6661)
- add folder sync backend import endpoint (DESKTOP-FOLDER-KB-SYNC-01-C.2) (7f2822a)
- Nowen package import with ID remapping (NOWEN-PACKAGE-IMPORT-01) (7a6c2af)
- local folder scan, sha256 index, sync logs (DESKTOP-FOLDER-KB-SYNC-01-C.1) (edd218d)
- add notebook selection and config editing for folder sync (DESKTOP-FOLDER-KB-SYNC-01-B.1) (ba855fe)
- desktop folder selection and local sync config (DESKTOP-FOLDER-KB-SYNC-01-B) (f9f5a51)
- Markdown source/preview/split view modes (MARKDOWN-PREVIEW-MODE-01) (46a4fb7)
- Nowen package export for lossless migration (NOWEN-PACKAGE-EXPORT-01) (10effe8)
- show note format badge in list, sidebar and editor (NOTE-FORMAT-BADGE-01) (3f7a470)
- 原生 Markdown 笔记创建入口 + 回收站锁定 + 文档更新 (e339e17)
- **v1.2.2**: contentFormat 原生 Markdown 笔记 + 回收站锁定 + 文档扩充 (1207194)
- 增加笔记列表更新时间显示开关 (NOTE-LIST-TIME-VISIBILITY-01) (8b4b043)
- 附件按上传年月分目录存储 (ATTACHMENT-STORAGE-DATE-PATH-01) (2baa097)
- 移动端编辑器支持保存单张图片到相册 (NOTE-EDITOR-IMAGE-SAVE-01) (7c2a440)
- 安卓端导出图片保存到相册 (NOTE-IMAGE-EXPORT-02) (b8ab9af)
- 分享页 Lightbox 支持图片缩放 (SHARE-IMAGE-LIGHTBOX-01.4) (9a1ad5b)
- 分享页图片支持 Ctrl+滚轮缩放 (SHARE-IMAGE-LIGHTBOX-01) (8b2f154)
- Sidebar ?????????? PNG/JPG (NOTE-IMAGE-EXPORT-01.1 ??) (6d83bbe)
- ?????? PNG/JPG ?? (NOTE-IMAGE-EXPORT-01) (9bca066)
- ?????????? (TASK-FULLSCREEN-01) (39de523)
- ???????????? (TASK-CALENDAR-SUBSCRIBE-01-C) (891e4fd)
- ?????????? ICS Feed (TASK-CALENDAR-SUBSCRIBE-01-B) (b62538a)
- 说说模块增加日历记事视图 (SAY-CALENDAR-01) (40ce3e3)
- 待办模块移动端交互适配 (TASK-MOBILE-UX-01) (eab94bd)
- 沉浸式视频浏览模式 (DIARY-FEED-01) (5c51055)
- 说说草稿自动保存 (DIARY-DRAFT-01) (0d32e58)
- 说说时间线筛选增强 (DIARY-TIMELINE-FILTER-01) (4337fc3)
- 说说编辑器支持完整媒体编辑 (DIARY-EDITOR-MEDIA-01) (8d3ab2d)
- 说说视频 Range 请求支持 (DIARY-VIDEO-RANGE-01) (a13e2a8)
- 编辑器页面内全屏 + 分享页大纲清理 (0d4a649)
- show attachment storage mode in file manager (d382e59)
- add shared note outline (8dc5150)

### 🐛 修复

- pre-existing TypeScript errors across multiple components (7d1e9d8)
- add extracted/extractionError fields to importAttachment return type (4bd5b8a)
- remove remaining orphaned folderSync checkDedup code (dfdcb62)
- remove orphaned importAttachment code from api.ts merge (dc71eaa)
- merge duplicate folderSync API, add missing exports, fix imageUploadService (676705f)
- TypeScript errors for Docker build (Buffer, broadcastToUser, ImageHostingConfig) (e2e1b6b)
- check note read permission for attachment download (BUG-SHARED-ATTACHMENT-DOWNLOAD-01) (eee27ac)
- image hosting encryption key production validation (IMAGE-HOSTING-ENHANCE-01.2) (ee93827)
- image hosting security audit fixes (IMAGE-HOSTING-ENHANCE-01.1) (7dd2c2e)
- rename Image import to avoid DOM constructor conflict (1bb6d4f)
- add workspaceId/hash/uploadSource to folder sync attachment import (DESKTOP-FOLDER-KB-SYNC-02-C) (89fb580)
- folder sync attachment import, HTML format, security (DESKTOP-FOLDER-KB-SYNC-01-C.2.1) (0789358)
- folder sync scan bugs and security (DESKTOP-FOLDER-KB-SYNC-01-C.1) (6b9fac2)
- move rootNotebookId declaration outside try block (8093160)
- folder sync skipped status and sourcePathHash namespace (DESKTOP-FOLDER-KB-SYNC-01-C.3.1) (4cfdecd)
- import order, effective attachment map, workspace passthrough (NOWEN-PACKAGE-IMPORT-01.1) (f96a285)
- store sync notes as plain Markdown, add folder_sync_files table (DESKTOP-FOLDER-KB-SYNC-01-C.2.1) (edadd9a)
- add explicit Markdown preview styles without typography plugin (MARKDOWN-PREVIEW-MODE-01.2) (bbc2b07)
- render MarkdownPreview in editor area for source/preview/split modes (MARKDOWN-PREVIEW-MODE-01.1) (592a3dc)
- **i18n**: clean up garbled zh-CN calendarFeed and remove hardcoded bilingual dict (a1b8301)
- add toast import and fix buildHeaders in Nowen package export (d854cad)
- Nowen package attachment refs, schemaVersion, unknown format warning (NOWEN-PACKAGE-EXPORT-01.1) (b031a74)
- **auth**: clear remembered credentials after password change (3a1dbdf)
- use existing helpers in processMarkdownAttachments (EXPORT-CONTENT-FORMAT-01.2) (38e6e11)
- Markdown export scope, image processing and notebook export (EXPORT-CONTENT-FORMAT-01.1) (7bc32cb)
- export pipeline supports contentFormat (EXPORT-CONTENT-FORMAT-01) (dac4b28)
- **editor**: replace ? text with Sparkles icon for AI classify button (bf2d4e1)
- add contentFormat to GET notes list and search results (ce742a8)
- propagate contentFormat in noteToListItem and addNoteToList (NOTE-FORMAT-BADGE-01.1) (44cc79a)
- **sidebar**: add useTranslation to SidebarNoteItem for format badge (bb2333a)
- **mindmap**: remove read-only ref assignment for React 19 compat (3fade3d)
- **NoteList**: update CreateMenu onPick type to accept markdown (c78634c)
- **types**: add _noteId to NoteEditorUpdatePayload (a44bf5d)
- **tasks**: add explicit type annotations to fix Docker tsc build (b7d307f)
- **mindmap**: use non-passive wheel listener for zoom (4d4ea94)
- **notes**: allow user to clear document content, monitor only (6c8558c)
- **mindmap**: keep minimap fixed during pan and zoom (9c11174)
- **mindmap**: bind wheel zoom via onWheel prop after canvas mounts (b847188)
- **notes**: refine empty content guard to allow manual clear (ad62254)
- **notes**: add noteId snapshot to editor onUpdate callbacks (0a64965)
- **mindmap**: enable wheel zoom on canvas (061d907)
- **notes**: create favorite note from favorites view (73364a0)
- **notes**: prevent accidental empty content overwrite (d414eb2)
- **notebook**: allow revoking share links (566fbcf)
- **ai**: add missing toast import in AIWritingAssistant (72170be)
- **ai**: use parseAiTags for proper JSON array parsing in tag generation (bc98bbd)
- **sync**: broadcast note:deleted when deleting notebook + add diagnostic logs (b180a22)
- **todo**: remove blank gap beside task detail panel (2a75aaa)
- **ai**: sanitize reasoning content from generated outputs (507c365)
- **search**: prevent false positive note results (f0628f7)
- **sync**: handle note deletion events globally (e111ab7)
- **todo**: refine task workspace layout (6bdb14c)
- **sync**: 全局监听 note:deleted 触发列表刷新 (SYNC-DELETE-01-B) (298a135)
- **context-menu**: add export image formats to note list submenu (90a3f43)
- zh-CN 补齐 noteList.export 导出子菜单文案 (bb5cda6)
- 导出子菜单真正生效 — 替换 displayItems 中旧平铺结构 (BUG-CONTEXT-MENU-EXPORT-SUBMENU-01) (47e1770)
- 修复树形目录右键 PNG/JPG 导出无响应 (NOTE-IMAGE-EXPORT-01.2) (bc692fc)
- 防止孤儿清理误删待办图片附件 (TASK-ATTACHMENT-ORPHAN-CLEANUP-01) (b8f6ec5)
- 树形笔记目录联动更新时间显示开关 (NOTE-LIST-TIME-VISIBILITY-01.2) (8d5a8a4)
- 设置页联动笔记列表更新时间开关 (NOTE-LIST-TIME-VISIBILITY-01.1) (63d79d9)
- 附件路径校验拒绝反斜杠并支持两层月份递归扫描 (ATTACHMENT-STORAGE-DATE-PATH-01.1) (fd85706)
- 加强附件路径校验并跳过 .thumbs 扫描 (ATTACHMENT-STORAGE-DATE-PATH-01) (7b7f39a)
- 优化移动端图片预览工具栏布局 (EDITOR-IMAGE-PREVIEW-MOBILE-01) (44bfaf6)
- 安卓相册保存路径使用 Environment.DIRECTORY_PICTURES (13a07eb)
- 修复编辑器图片间距与换行兼容 (EDITOR-IMAGE-LAYOUT-01) (1c60ac3)
- 分享页图片缩放调试日志 (d86804b)
- 增强分享页图片 width 链路排查日志 (SHARE-IMAGE-LIGHTBOX-01.4) (db258f9)
- 添加分享页图片缩放排查日志 (SHARE-IMAGE-LIGHTBOX-01.4) (0f615f8)
- 修复分享页图片缩放源数据丢失问题 (SHARE-IMAGE-LIGHTBOX-01.3) (e61d484)
- 修复分享页 Markdown 图片缩放未生效 (SHARE-IMAGE-LIGHTBOX-01.2) (90b7325)
- 修复分享页图片缩放尺寸未生效 (SHARE-IMAGE-LIGHTBOX-01.1) (f735be1)
- 分享页图片按缩放尺寸显示并支持预览 (SHARE-IMAGE-LIGHTBOX-01) (c85aa9c)
- ???????????? (TASK-CALENDAR-FEED-UX-01) (b35453d)
- ???????????????? (AUTH-FIRST-CHANGE-LOOP-01) (c2a58e3)
- ????????????????? (TASK-QUICKADD-IMAGE-01) (249b73b)
- ????????? i18n hotfix (NOTE-IMAGE-EXPORT-01.1) (c8af5ff)
- 修复待办日历订阅多语言显示 (I18N-CALENDAR-FEED-01) (3425f60)
- ???????????????????? (BUG-TALK-FILTER-UI-01) (1076cdf)
- DiaryEditor 补回 cameraInputRef + DiaryCard forwardRef 修复 (dce654d)
- 补回 DiaryCenter 缺失的 calendarOpen state 声明 (181642b)
- 补回 EditorPane 缺失的 buildAiContext/extractFinalAnswer 导入 (6de024a)
- complete inline note context menu actions (d579df8)
- expose latest context menu target (91f9c20)
- 移动端抽屉导航后自动关闭 (MOBILE-DRAWER-CLOSE-01) (1a87d8c)
- 待办移动端遗漏交互补丁 (TASK-MOBILE-UX-01.1) (d3201e8)
- 已初始化实例隐藏默认账号提示 (AUTH-LOGIN-DEFAULT-CREDS-01) (0fd885d)
- 草稿清空时释放已上传媒体 + 移除 BOM (DIARY-DRAFT-01.1) (32db2c3)
- 筛选空状态与心情筛选交互优化 (DIARY-TIMELINE-FILTER-01.1) (8b51ed3)
- 编辑器多文件选择时混发漏检 (DIARY-EDITOR-MEDIA-01.2) (3701679)
- DiaryEditor addFiles 编译错误 + 逻辑修正 (DIARY-EDITOR-MEDIA-01.1) (2fb843d)
- 移除 DiaryEditor 中重复的 input refs 声明 (3a52540)
- VideoBlock 错误占位 React 化 + i18n (DIARY-VIDEO-RANGE-01.1) (ebd88f7)
- 文件存储国际化与Diary路由修复 (5abe992)
- normalize English locale encoding (afec86b)
- ignore stale notebook note fetches (92a3ce9)
- **tasks**: V1.2.1 待办功能修正——截止时间拆分、自定义提醒、子任务拖拽排序、按截止时间排序 (8d0e6d8)

### ♻️ 重构

- 折叠笔记右键菜单导出项 (CONTEXT-MENU-COMPACT-01) (395951f)

### 📝 文档

- finalize PDF/DOCX folder sync documentation (DESKTOP-FOLDER-KB-SYNC-02-Z) (855d7bb)
- desktop folder sync documentation and MVP sign-off (DESKTOP-FOLDER-KB-SYNC-01-Z) (582357a)

### 💄 样式

- 表格单元格默认水平垂直居中 (EDITOR-TABLE-CELL-CENTER-01) (d8b9cdb)

### 🔧 其他

- clean up MarkdownEditor header comment encoding (MARKDOWN-EDITOR-CLEANUP-01) (b9987d6)
- 移除最近提交中的 UTF-8 BOM (ca97d74)
- 清理分享页图片调试日志 (6f57cab)
- remove temporary mobile layer stack workflow (9848048)
- trigger mobile layer stack auto fix (05cb80a)
- add temporary workflow for mobile layer stack fix (955f2f4)
- remove temporary auto fix workflow (afbc17b)
- trigger notebook tree note menu auto fix (be3fabc)
- add temporary auto fix workflow for notebook tree note menu (410f1fd)
- remove duplicate comment in DiaryCenter (fe0c809)

### 📌 杂项

- 优化：接入长笔记AI上下文预算与分块处理 (AI-LONG-NOTE-CONTEXT-01) (96d7e10)
- 优化：新增长笔记AI上下文构建工具 (ebad1d4)
- 新增：AI推理输出清洗工具 (176e11b)
- 修复：清洗AI推理输出并忽略reasoning流 (43e6a14)

### ✨ 新增

- Android 导出图片保存到相册，导出的 PNG/JPG 文件会自动写入系统相册方便查看和分享 (NOTE-IMAGE-EXPORT-02)
- 移动端编辑器支持单张图片保存到相册，长按或点击图片即可一键保存 (NOTE-EDITOR-IMAGE-SAVE-01)
- 笔记列表支持隐藏更新时间显示，在设置中可切换是否展示每条笔记的最后更新时间 (NOTE-LIST-TIME-VISIBILITY-01)
- 表格单元格默认水平和垂直居中对齐，新插入的单元格内容自动居中显示 (EDITOR-TABLE-CELL-CENTER-01)
- 附件按上传年月自动分目录存储，新增的附件会存入 `年/月` 子目录，便于管理和备份 (ATTACHMENT-STORAGE-DATE-PATH-01)

### 🐛 修复

- 修复孤儿清理机制可能误删待办任务中图片附件的问题，清理前增加引用检查 (TASK-ATTACHMENT-ORPHAN-CLEANUP-01)
- 修复删除笔记或清空回收站后其他设备不同步的问题，跨端删除操作现在能实时同步 (SYNC-DELETE-01-B)
- 修复树形目录右键菜单点击 PNG/JPG 导出时无响应的问题 (NOTE-IMAGE-EXPORT-01.2)
- 修复搜索结果偶尔误报无关内容的问题，提高搜索结果准确性 (f0628f7)
- 过滤 AI 回复中的思考过程内容，避免用户看到模型内部推理细节 (507c365)
- 笔记本分享链接支持撤销，分享者可随时取消已生成的分享链接 (566fbcf)
- 修复思维导图使用滚轮缩放时缩放方向和灵敏度异常的问题 (4d4ea94)
- 回收站中的笔记自动锁定，禁止编辑、收藏和加锁操作，防止误操作恢复被删内容
- 修复偶发的笔记内容被意外清空问题，增强编辑器内容保护机制 (d414eb2)

## v1.2.1 - 2026-06-16

### ✨ 新增

- **tasks**: 增加待办任务详情描述（TASK-DESC-01） 背景/目标：当前待办任务仅保留标题，缺少更完整的上下文与验收说明。本次变更为任务引入 description 字段，用于记录步骤、备注、验收标准等详细信息，不扩展富文本与协作功能。 主要变更：数据库：在 backend/src/db/migrations.ts 新增 v28 迁移 tasks-add-description，通过 PRAGMA table_info(tasks) 检查并执行 ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''，保持幂等，旧任务自动兼容。后端接口：在任务创建流程写入 description；在任务更新流程支持 description 更新（含清空）；重复任务生成时复制 description；模板相关路径同步透传 description。类型：为 Task 新增 description: string，为 TaskTemplateItem 新增 description?: string，前端统一使用 task.description ?? '' 兼容历史数据。详情面板：在 TaskDetailPanel 新增纯文本 textarea，支持多行输入，onBlur 保存并保留本地输入；新增成功/失败提示文案。列表与看板：FlatTaskRow、TaskTreeRow、TaskBoardView 增加轻量摘要，避免打断紧凑布局。搜索：将任务检索范围扩展到 title 与 description，不改变现有搜索入口。国际化：补充 tasks.fields.description、tasks.fields.descriptionPlaceholder、tasks.toast.descriptionUpdated、tasks.toast.descriptionUpdateFailed，并对齐 en/zh-CN。测试：新增 task-description、taskSearch、TaskTemplateEditor 相关测试，补齐测试 mock 中 description 字段。 验证：frontend tsc/vite build 通过；frontend test 通过；backend build:tsc 通过；任务描述相关后端与前端测试通过。 (e06dfdf)
- Phase 7.1.1 空状态 + 操作反馈 + 重试按钮 (9667ab2)
- Phase 6.4 轻量自动化提醒 — 依赖完成通知、逾期每日提醒 (267958a)
- Phase 6.2 轻量提醒操作 — 稍后提醒、关闭/开启提醒、跳转任务 (450c289)
- Phase 6.1 提醒中心增强 V1 (26194a5)
- Phase 5 - 甘特图 / 时间轴 V1 (cde9c29)

### 🐛 修复

- Phase 7.1.0 P0 清理 — 通知文案 i18n + BOM 清理 (69e7d6e)
- Phase 6.4.1 自动化提醒稳定化 — 依赖全部完成才通知、dueAt 用 JS 时间比较 (aae9ae8)
- Phase 6.2.3 补齐 TaskReminder.snoozedUntil 类型 (a668eed)
- Phase 6.2.2 snoozedUntil 后端接线修复 — PUT 写入、SELECT 扫描、测试补齐 (33b1feb)
- Phase 6.2.1 提醒操作稳定化 — snoozedUntil 字段、可靠 snooze、button 嵌套修复 (cae5e8d)
- Phase 6.1.1 提醒中心 Electron 环境识别与 offset 国际化 (5b0adde)
- Phase 5.0.1 - 甘特图/时间轴稳定化 (0a998af)
- Phase 4.7.1 - 任务模板稳定化 (84bf28f)

### 🔧 其他

- **repo**: 同步本次会话中的其他本地改动 背景/目标：在完成 TASK-DESC-01 后，一并提交剩余本地工作区改动，便于代码库保持整洁。 主要变更：新增/更新 shareOutline、ShareOutline、ReminderCenter、DiaryCenter、SharedNoteView、taskTitleTokens 及其测试产物；补充 docs/screenshots 与 .playwright-mcp 相关记录文件。 验证：在提交前已确认 TASK-DESC-01 单独完成提交，本次提交仅包含与任务详情描述无关的其余本地改动。 (7dd4437)

### 📌 杂项

- Phase 6.0.2: add TaskReminder.updatedAt to frontend type (3c4829e)
- Phase 6.0.1: reminder type + test fixes (e2d5877)
- Phase 6.0: reminder infrastructure stabilization (d98ccf6)
- Phase 5.5.1: cascade delete cleanup for task_dependencies on child task removal (455ac38)
- Phase 5.5: task center regression + tech debt cleanup (a90a1e3)
- Phase 5.4: dependency-driven lightweight reschedule suggestions (8ba21f0)
- Phase 5.3: dependency status indicators - blocked task visual hints (e41979c)
- Phase 5.2.1：任务依赖线稳定化 hotfix — 修复 6 个 P0/P1 (f5427e7)
- Phase 5.2：任务依赖线 V1 — 数据模型 + 循环检测 + 甘特图依赖线 + 详情面板管理依赖 (c8e1488)
- Phase 5.1：甘特图体验增强 — resize 调整日期范围 + 跨区间显示 + 一键排期 + today 指示器修复 + BOM/编码清理 (dd9f8ce)


## v1.1.20 - 2026-06-12

### ✨ 新增

- Phase 4.7 - 任务模板 V1 (84c92c4)
- Phase 4.6 - AI 拆任务 (f4bee48)
- Phase 4.5 - 重复任务 (f161c89)
- Phase 4.4 - 日历拖拽改截止日期 (7bd2ea5)
- Phase 4.3 — 任务日历视图 (a153357)
- Phase 4.2 — 项目编辑弹窗、移动端项目选择、看板拖拽、卡片增强 (bd9defe)
- 补充 v22 迁移 — task_projects 表 + tasks 新增 projectId/status 字段（Phase 4 数据层遗漏修复） (c6cb7a3)
- Phase 4 - task projects, kanban board view, status field, project sidebar (7d740bb)
- frontend reminder system (b6fe42b)
- **编辑器**: 选区气泡菜单增强——复制、全选、手机号拨号、URL 识别、横向滚动 (84b6f76)
- **textActions**: 新增文本动作识别工具库，支持手机号拨号和 URL 检测 (4b3fbdb)
- Phase 4 — 搜索、快捷键、批量操作、拖拽排序 (c2db189)
- 任务中心 Phase 3 — 提醒系统 (1ffc575)
- 任务中心 Phase 2 — 截止时间精确到分钟 + 倒计时 (813ba68)
- 任务中心 Phase 1.5 — 子任务快捷新增、删除确认、详情子任务列表、父任务路径 (cd16252)
- 任务中心 Phase 1 — 顶部概览、树形任务、进度条、详情进度 (45b44d7)

### 🐛 修复

- 修复 FlatTaskRow.tsx 编码损坏导致构建失败 (da530a0)
- 修复 6 个 TypeScript 编译错误 (860f44f)
- Phase 4.6.1 - AI 拆任务稳定化 (fa6a362)
- **AI思维导图**: 修复 AI 返回思考过程导致 Mermaid 解析失败的问题 (5acd442)
- Phase 4.5.2 - 重复任务收口 (4b0c008)
- Phase 4.5.1 - 重复任务 hotfix (e1c6fd5)
- 任务中心多语言修复 (f125cee)
- Phase 4.4.3 - 拖拽成功后 loadTasks 刷新筛选视图 (aec282f)
- Phase 4.4.2 - 拖拽后筛选刷新、BOM清理、注释修正 (4e59ac9)
- Phase 4.4.1 - 日历拖拽稳定化 (515904a)
- Phase 4.4 hotfix - 修复嵌套函数和缺失 prop (bcddcc8)
- Phase 4.3.1 - 日历逾期统一、英文日期格式、空日期状态 (c442575)
- Phase 4.2.2 — MobileProjectPicker 打不开、移动端新建项目旧 state、看板 dueAt-only 逾期 (1b3eb19)
- Phase 4.2.1 — 移动端项目入口接入、工作区切换刷新、看板逾期判断、拖拽保护 (96ea808)
- Phase 4.1.1 — status 枚举校验、批量完成同步、批量删除 descendants、工作区切换刷新项目 (5cd94cf)
- Phase 4.1 — 项目绑定/权限/状态同步/计数刷新全面修复 (6c4ac43)
- overdue filter and stats use datetime precision for dueAt (7ab46b0)
- Phase 3.5 stability audit - reminder auth, overdue precision, notification status (3e006d8)
- **EditorPane**: 修复移动端按钮 title 乱码和乱序问题 (44b6746)
- tasks INSERT VALUES 缺少 dueAt 占位符（9 values for 10 columns） (2f3f37d)
- migration v20 dueAt 列探测失败 — 改用 PRAGMA table_info 安全检测 (0cf18d3)
- migrations.ts 模板字符串丢失反引号导致后端构建失败 (4ddb9e2)
- 任务中心 Phase 1 全面修复 — 删除子任务、orphan 绑定、循环依赖、逾期判断、后端防护 (d7a916b)
- 任务中心 Phase 1 审查修复 — 删除子任务残留、状态同步、循环防护 (f74a9f0)

### ✅ 测试

- Phase 3.5 - taskProgress, DateBadge, reminder scanner unit tests (8b4e0b9)


## v1.1.19 - 2026-06-11

### ✨ 新增

- **前端**: 思维导图标记和主题名称支持多语言 i18n (8f46744)
- add notebook-first collaboration with hidden workspace UX (e6875a1)
- **mindmap**: 侧边栏搜索框旁增加收藏筛选按钮 (df89085)
- **mindmap**: 新建文件夹按钮移到列表顶部 (ccc6425)
- **mindmap**: 文件夹右键菜单 - 重命名/删除 (37313a7)
- **backend**: 新增导图移动到文件夹的 PATCH /:id/move 路由 (770b062)
- **mindmap**: 支持拖拽导图到文件夹 (4213873)
- **mindmap**: 导图模板功能 - 新建导图时可选择预设模板 (09f7f17)
- **mindmap**: 文件夹树前端 UI (1adf85a)
- **mindmap**: 文件夹树后端 + 数据模型 (124562f)
- **mindmap**: 节点聚焦模式 (9c0ed1a)
- **mindmap**: 拖拽节点调整结构 (044cb67)
- **mindmap**: 收藏导图功能 (f1868bd)
- **mindmap**: 节点复制/剪切/粘贴 (a272d4f)
- **mindmap**: Ctrl+滚轮鼠标位置缩放 + 节点搜索 + 列表搜索 (7ffe9eb)
- **mindmap**: 支持 Ctrl+Click 多选节点 (0f0f462)
- **mindmap**: 思维导图模块 5 阶段增强 (e8f3c66)
- **mindmap**: 新增全屏编辑模式 (db3ae8b)
- **mindmap**: 新增添加同级节点 + 快捷键 + 选中节点置顶渲染 (5348b85)
- **mindmap**: 新增 mindmapTransform.ts 独立解析器 (8255b65)
- **editor**: MermaidView 工具栏增强 + MindMapEditor 事件监听 + 编辑器 appendMarkdown (03e7782)
- **ai**: AIChatPanel 支持笔记本级 RAG 作用域 (9a3a4a3)
- **ai**: EditorPane 新增 AI 总结、AI Mermaid、保存为思维导图 (8effbf2)
- **ai**: 前端 API 扩展 + i18n + NoteEditorHandle 类型增强 (54a7b26)
- **ai**: 后端 AI 路由改造 + 笔记本级 AI 端点 (f81d0b8)
- **ai**: 新增 AI Client 适配层，统一 stream/non-stream 调用 (c1e182d)

### 🐛 修复

- **前端**: NoteList 补回 confirm 导入，修复 tsc -b 构建错误 (182c698)
- **前端**: 修复6个TypeScript编译错误 — import缺失、path字段缺失、函数未导出 (76721f1)
- **前端**: 补回缺失的 diagnoseConnection 导出函数，修复 vite build 失败 (bb765a6)
- **Electron**: setupWindow 和 waitForRemoteReady 支持反代路径前缀 (142c990)
- **前端+后端**: 服务器地址支持反代路径、修复Windows频闪、新增连接诊断 (4442716)
- **前端**: 浮动操作条按钮添加细微边框增强轮廓感 (7cb9e70)
- **前端**: 思维导图标记菜单改用带颜色SVG图标，与节点显示一致 (1014ca0)
- **前端**: 浮动操作条按钮增强可见性 — 加深背景色、加粗文字、加大点击区域 (98fbff7)
- **backend**: 修复 mindmaps 相关路由 TypeScript 编译错误 (174f668)
- **mobile**: 修复移动端回收站一键清空按钮无响应 (1f2fb74)
- **mindmap**: 文件夹数量跟随收藏/搜索筛选动态更新 (380d594)
- **i18n**: 修复文件夹右键菜单中文翻译乱码 (e38650f)
- **i18n**: 修复导图模板中文翻译乱码 (42b1d73)
- **backend**: requireWorkspaceFeature 中间件正确放行 personal 空间请求 (a0c4947)
- **backend**: 修复 personal workspaceId 传入时文件夹和导图 API 返回 403 的问题 (164b8d8)
- **mindmap**: Ctrl+滚轮缩放改为原生事件，阻止浏览器页面缩放 (fe67b0f)
- **mindmap**: 修复 FloatingToolbar 定位偏移 (9f4ccc3)
- **mindmap**: 修复数据风险 + UI 扁平化 + 代码拆分 (a789add)
- **mindmap**: 适应视图图标改为 Scan，与全屏 Maximize2 区分 (d988ec1)
- **i18n**: 补全思维导图多语言文案 (ffc33cd)
- **ai**: 标题生成字数限制从10改为20，避免AI输出被截断 (8dfcb05)
- **mindmap**: 保存为思维导图后可靠跳转 + 使用独立解析器 (caff2d6)
- **ai**: 修复 RAG 向量召回未传 notebookIds + /ask 复用 ai-client (9061916)
- **build**: 修复 vite 构建循环 chunk 错误 (9d81de3)

### ♻️ 重构

- **前端**: 思维导图样式收尾 — indigo→blue统一、transition补齐、菜单背景token化、模板弹窗圆角与阴影优化 (e0db228)
- **前端**: 思维导图悬浮状态与创建按钮样式统一收敛 (ef81bea)
- **前端**: 思维导图菜单与激活态样式继续收敛 (dec1717)
- **前端**: 思维导图模块 macOS 风格样式重构 (87a48b3)

### 📝 文档

- 添加完整官网教程体系（47篇教程 + 索引 + 规划） (210f537)


## v1.1.18 - 2026-06-09

### ✨ 新增

- 更新Android组件和Tiptap编辑器功能 (c489050)
- 增强Tiptap编辑器功能并优化用户体验 (ce05f9e)
- 添加鸿蒙ArkWeb原生应用项目 (f63e84f)
- 添加鸿蒙ArkWeb WebView原生适配支持 (f6d4923)

### 🐛 修复

- 移动端Sidebar约束宽度防溢出，移除选择时自动关闭侧边栏的逻辑 (03bb588)
- 移除NavRail点击导航项后自动关闭移动端侧边栏的逻辑 (a429f1a)
- 移动端侧边栏遮罩区分点击/滑动，禁用手势关闭侧边栏，添加overflow-hidden防溢出 (948e447)
- 优化Android WebView选择菜单处理，使用委托模式替代直接返回null (fa20e06)


## v1.1.17 - 2026-06-08

### ♻️ 重构

- 大规模代码精简和架构优化 (60f051b)


## v1.1.16 - 2026-06-05

### ✨ 新增

- 全面增强搜索功能和用户体验 (524cf8c)
- 增强搜索体验和侧边栏布局管理 (14b61c2)
- 增强附件对象存储功能和搜索高亮显示 (7ce7d53)

### 🐛 修复

- 修复 TypeScript 编译错误 - Buffer 类型兼容性 (ff2f4b5)
- 全面优化版本恢复功能和编辑器状态管理 (85783d1)
- 优化侧边栏布局计算和滚动性能 (5e49465)

### 📌 杂项

- 实现对象存储支持和同步中心功能 (d576ec1)


## v1.1.15 - 2026-06-04

### 📌 杂项

- 优化同步引擎和网络状态检测 (a2e6fbd)
- 修复macOS Electron侧边栏拖拽区域CSS (07545f2)


## v1.1.14 - 2026-06-03

### ✨ 新增

- 侧边栏重构、右键菜单优化及多语言支持增强 (3dadbcc)
- 笔记内联到笔记本树，移除独立笔记列表列 (406d599)

### 🐛 修复

- 修复标题聚焦边框问题，使用 node 写入避免 PowerShell UTF-8 BOM 损坏 (94e2061)
- 移除标题输入框聚焦时的粗边框 (b2154b5)
- 修复 JSX style 模板字符串中缺失的反引号 (1da66ed)
- 从原始文件重新应用笔记内联功能，修复 UTF-8 编码损坏 (9a8ed99)
- 修复递归 NotebookItem 调用中 /> 位置错误和缺失 notes prop (bedd28f)
- 恢复被 Set-Content UTF8 编码破坏的 emoji 字符 (a6b9296)
- 修复字号/颜色弹窗点击外部关闭逻辑，优化自定义颜色交互 (cc4bd64)

### 🔧 其他

- 提交剩余改动 (157e2e8)

### 📌 杂项

- 优化用户体验和编辑器功能 (f671a3d)


## v1.1.13 - 2026-06-02

### 🐛 修复

- restrict color-mix focus fallback to form elements only (f9e58ec)
- Backspace at line start now correctly decreases indent (Office-like behavior) (aadc88a)
- add CSS fallbacks for older Android WebViews (Xiaomi 8 black screen) (aa9a2fd)


## v1.1.12 - 2026-06-01

### 🐛 修复

- resolve remaining TS null-check and changeIndent type errors (98fc8fd)
- resolve all 13 TS7006/7022/7023/7031 implicit any errors (732420d)
- clip row resize guide line to table bounds (a5a6c5c)
- clip row resize guide line to editor bounds (45f9342)
- table row height drag now follows mouse in real-time via transaction (1edae9c)
- improve table row height resize UX - wider hit area and real-time visual feedback (539c56c)
- Backspace at line start reduces indent level (437fb38)
- table bubble merge button visibility + mini toolbar (ea6a088)

### 📌 杂项

- Update README.md (4b9a660)


## v1.1.11 - 2026-05-29

### ✨ 新增

- **editor**: 表格交互优化 - 网格选择器与行高丝滑拖拽 (f92168e)


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


