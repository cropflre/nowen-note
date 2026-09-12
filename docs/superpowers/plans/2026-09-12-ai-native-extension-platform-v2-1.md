# AI 原生扩展平台 V2.1 实现计划

**设计依据：** `docs/superpowers/specs/2026-09-12-ai-native-extension-platform-v2-1-design.md`

**目标：** 在保持 Plugin V1/V2、安全供应链和核心应用离线语义不退化的前提下，分四个发布阶段实现声明式插件、受控文件/文档扩展和 AI Plugin Studio。

**目标版本：** 从 Nowen `1.6.0` 开始交付 V2.1 增量能力。不得在 `release/v1.5.0` 中一次性混入全部功能；实施时为每个 Release 建立独立分支或受控 Feature Flag。

**总原则：** 每个阶段必须形成 Capability、接口、实现、测试、文档、示例插件和发布门禁。前一阶段未通过真实验收，不进入后一阶段。

---

## 0. 开工前基线

### 任务 0.1：建立版本、Feature Flag 和成功门禁

**修改：**

- `backend/src/plugins/types.ts`
- `frontend/src/lib/pluginApi.ts`
- 新建 `docs/plugin-platform/ai-plugin-studio.md`
- 新建 `.github/workflows/extension-v2-1-ci.yml`

**步骤：**

- [ ] 确认目标版本和分支策略，V2.1 新插件要求 `engines.nowen >=1.6.0`。
- [ ] 增加服务端 `extensionsV21`、`pluginStudio`、`fileProcessingExtensions` Feature Flag；默认关闭实验性 Document Type。
- [ ] CI 固定运行 Backend plugin tests、SDK/CLI tests、Frontend contribution tests、Backend/Frontend production build 和生成物 `--check`。
- [ ] 记录现有 V1/V2 插件安装、执行、更新、回滚和离线 Marketplace 基线结果。

**验收：** Feature Flag 关闭时行为与当前 `release/v1.5.0` 一致。

**提交边界：** `chore(extensions): establish v2.1 feature gates`

---

## 1. R1 — Declarative Ecosystem + Studio Alpha

### 任务 1.1：扩展统一 Capability Contract

**修改：**

- `packages/nowen-plugin-sdk/host-api-contract.json`
- `scripts/generate-plugin-host-api.mjs`
- `backend/src/plugins/hostApiContract.ts`
- `backend/src/plugins/hostApiContract.generated.ts`
- `packages/nowen-plugin-sdk/src/hostApi.generated.ts`
- `docs/plugin-platform/host-api.generated.md`

**新建：**

- `packages/nowen-plugin-sdk/contribution-contract.json`
- `packages/nowen-plugin-sdk/error-code-contract.json`
- `packages/nowen-plugin-sdk/capability-catalog.json`
- `packages/nowen-plugin-sdk/src/contributions.generated.ts`
- `packages/nowen-plugin-sdk/src/mock.generated.ts`
- `docs/plugin-platform/contributions.generated.md`

**步骤：**

- [ ] 定义 Host API、Contribution、Permission、Error、Platform、Budget 和 Template 的合同结构。
- [ ] 扩展生成器，一次生成 Backend guards、SDK types、Mock、Markdown 和 AI Catalog。
- [ ] `--check` 比较全部生成物，禁止手写生成文件。
- [ ] Catalog 包含版本、digest、输入输出 Schema、权限、示例和限制。
- [ ] AI Catalog 不包含内部路径、Secret、实现代码或用户数据。

**测试：**

- `backend/tests/extension-host-api-contract.test.ts`
- 新建 `backend/tests/extension-capability-catalog.test.ts`
- 新建 `packages/nowen-plugin-sdk/tests/generated-contract.test.mjs`

**验收：** 删除或修改任一合同项后，Backend、SDK、Mock、Docs 和 Catalog 必须同步变化；漂移时 CI 失败。

**提交边界：** `feat(extensions): generate unified capability catalog`

### 任务 1.2：支持纯声明式插件

**修改：**

- `backend/src/plugins/types.ts`
- `backend/src/plugins/manifest.ts`
- `backend/src/plugins/packageValidator.ts`
- `backend/src/plugins/extensionCompatibility.ts`
- `backend/src/plugins/packageInstaller.ts`
- `backend/src/plugins/pluginService.ts`
- `backend/src/plugins/executionManager.ts`
- `frontend/src/lib/pluginApi.ts`

**步骤：**

- [ ] 将 Manifest V2 改为 `ExecutableExtension | DeclarativeExtension` 联合类型。
- [ ] 新增 `runtime: declarative`，禁止 executable-only 字段。
- [ ] Package Validator 对声明式包不要求 `main`，仍执行路径、大小、签名、Publisher 和资源校验。
- [ ] 声明式插件启用时不启动 Worker，不进入 Action probation；Contribution Preflight 成功后直接 stable。
- [ ] 列表和详情明确显示“声明式 / 不执行代码 / 零数据权限”。
- [ ] 备份恢复仍进入 quarantine，不能因为零代码跳过来源确认。

**测试：**

- 扩展 `backend/tests/extension-platform-v2.test.ts`
- 扩展 `backend/tests/plugin-platform.test.ts`
- 新建 `backend/tests/declarative-extension-lifecycle.test.ts`

**验收：** 一个只有 Manifest 和安全静态资源的插件可以安装、启用、禁用、更新、回滚和卸载，全程不创建执行进程。

**提交边界：** `feat(extensions): add declarative extension runtime`

### 任务 1.3：Appearance Contribution

**修改：**

- `backend/src/plugins/types.ts`
- `backend/src/plugins/manifest.ts`
- `backend/src/plugins/pluginService.ts`
- `frontend/src/lib/appAppearance.ts`
- `frontend/src/hooks/useSkin.ts`
- `frontend/src/components/SkinSwitcher.tsx`
- `frontend/src/lib/pluginApi.ts`
- `.github/workflows/app-appearance-ci.yml`

**新建：**

- `backend/src/plugins/contributions/appearanceContribution.ts`
- `frontend/src/lib/pluginAppearanceRegistry.ts`
- `frontend/src/lib/pluginContributionCache.ts`
- `examples/plugins/theme-pack/manifest.json`
- `docs/plugin-platform/appearance-contribution.md`

**步骤：**

- [ ] 定义 `schemaVersion/base/light/dark/customizable/editableTokens`。
- [ ] 安装阶段验证 Token 类型、颜色、圆角、字体类别、对比度和禁用字符串。
- [ ] 前端将内置与已启用插件主题合并为唯一动态 Registry。
- [ ] 持久化 namespaced appearance key；缓存最后一次已验证的规范化 Token，避免冷启动闪烁。
- [ ] 禁用、卸载、撤销或主题 ID 消失时回退默认，并保留 dormant reference。
- [ ] Settings 按“内置 / 来自插件 / 我的定制”分组，显示 Publisher 和管理入口。
- [ ] 用户自定义只保存白名单 override，继续尊重编辑器字体优先级。

**测试：**

- 扩展 `frontend/src/lib/__tests__/appAppearance.test.ts`
- 新建 `frontend/src/lib/__tests__/pluginAppearanceRegistry.test.ts`
- 新建 `backend/tests/appearance-contribution.test.ts`
- 扩展 App Appearance Release Gate。

**验收：** 主题包在 Web/Electron/Android/iOS、Light/Dark/System、冷启动和多标签页恢复一致；非法主题在安装阶段被拒绝。

**提交边界：** `feat(extensions): add safe appearance contributions`

### 任务 1.4：Note Template 与 Prompt Pack

**修改：**

- `backend/src/plugins/types.ts`
- `backend/src/plugins/manifest.ts`
- `backend/src/plugins/pluginService.ts`
- `frontend/src/components/NoteTemplatePickerDialog.tsx`
- `frontend/src/components/AISettingsPanel.tsx`
- `frontend/src/lib/pluginApi.ts`

**新建：**

- `backend/src/plugins/contributions/noteTemplateContribution.ts`
- `backend/src/plugins/contributions/promptPackContribution.ts`
- `frontend/src/lib/pluginTemplateRegistry.ts`
- `frontend/src/lib/pluginPromptRegistry.ts`
- `examples/plugins/productivity-pack/`
- `docs/plugin-platform/note-template-contribution.md`
- `docs/plugin-platform/prompt-pack-contribution.md`

**步骤：**

- [ ] 定义模板内容、变量、标签建议、适用文档类型和大小限制。
- [ ] 定义 Prompt 输入字段、上下文声明、输出模式和平台。
- [ ] Host 在用户操作时创建笔记或提供 AI 上下文；Contribution 本身不获取写权限和 AI 密钥。
- [ ] 插件禁用/卸载时撤销列表项，不删除已经由用户创建的笔记。

**测试：** Contribution Schema、变量替换、非法内容、上下文最小化、禁用回退和移动端渲染。

**验收：** AI Studio 可以生成一个零代码 Productivity Pack，并在 Host UI 中真实使用。

**提交边界：** `feat(extensions): add template and prompt contributions`

### 任务 1.5：Studio 项目与权限模型

**新建：**

- 使用实施时下一个空闲 migration 版本，创建 `backend/src/db/pluginStudioMigration.ts`
- 对应 `backend/src/db/postgres/<next>_plugin_studio.sql`
- `backend/src/plugins/studio/types.ts`
- `backend/src/plugins/studio/projectService.ts`
- `backend/src/plugins/studio/projectPaths.ts`
- `backend/src/routes/plugin-studio.ts`
- `frontend/src/lib/pluginStudioApi.ts`

**修改：**

- `backend/src/db/migrations.ts`
- `backend/src/index.ts`
- `backend/src/index.hardened.ts`
- `backend/src/services/backup-archive.ts`

**步骤：**

- [ ] 建立 `plugin_studio_projects/generations/artifacts` 表。
- [ ] 项目根固定在 `plugin-projects`，所有路径 canonicalize 后验证位于项目根内。
- [ ] 白名单文件类型、单文件大小、项目总大小和资源 MIME。
- [ ] Desktop 管理员可构建/试运行/安装；普通成员只能创建草稿和导出审核包。
- [ ] Studio 项目默认不进入普通备份；另提供明确项目导出。
- [ ] 稳定错误码覆盖路径越界、项目超限、状态冲突和权限拒绝。

**测试：** 路径穿越、符号链接、并发修改、Owner/管理员矩阵、项目导入导出和备份排除。

**验收：** Studio 只能操作自己的项目根，不能读写任意用户目录、已安装插件和 Registry 私钥。

**提交边界：** `feat(plugin-studio): add isolated project workspace`

### 任务 1.6：AI Spec 与生成服务

**新建：**

- `backend/src/plugins/studio/pluginSpec.ts`
- `backend/src/plugins/studio/capabilityPrompt.ts`
- `backend/src/plugins/studio/generationService.ts`
- `backend/src/plugins/studio/generationAudit.ts`
- `backend/tests/plugin-studio-spec.test.ts`

**修改：**

- `backend/src/routes/plugin-studio.ts`
- 复用现有 AI Provider/Client 统一入口，不创建新的密钥存储。

**步骤：**

- [ ] 定义严格 `PluginSpec` Schema 和版本。
- [ ] `POST /api/plugins/studio/projects/:id/spec` 只生成 Spec，不写源码。
- [ ] Spec 必须包含权限理由、网络域名、数据范围、平台和验收测试。
- [ ] 用户确认 Spec 后才允许 Generate。
- [ ] AI Context 只提供 Capability Catalog、选中模板和当前项目必要文件。
- [ ] 把现有项目文件视为不可信数据，防止其中的 Prompt Injection 改变系统约束。
- [ ] 记录模型、Catalog digest、输入摘要和输出 digest；不记录 Prompt 正文、笔记或 Secret。

**测试：** Golden Specs 覆盖主题、Automation、便利 Action、Office 六级范围澄清、过度权限拒绝和不存在 API。

**验收：** AI 无法生成 Catalog 外的方法或绕过 Spec 确认直接安装。

**提交边界：** `feat(plugin-studio): generate capability-bound specs`

### 任务 1.7：固定 Builder、测试与修复循环

**新建：**

- `backend/src/plugins/studio/builder.ts`
- `backend/src/plugins/studio/testHarness.ts`
- `backend/src/plugins/studio/repairLoop.ts`
- `backend/src/plugins/studio/securityScanner.ts`
- `backend/src/plugins/studio/report.ts`
- `backend/tests/plugin-studio-builder.test.ts`

**修改：**

- `packages/nowen-plugin-cli/bin/nowen-plugin.mjs`
- `backend/src/routes/plugin-studio.ts`

**步骤：**

- [ ] 内置固定 TypeScript/Bundler/Test Harness，不运行项目 package scripts。
- [ ] 只允许 SDK 和 allowlist imports；禁止 Node builtin、动态 import、eval bridge 和未声明网络。
- [ ] 依次执行 Type Check、Manifest、Contract、Unit、Sandbox、Permission 和 Package Validate。
- [ ] 自动修复最多三轮，只允许 apply patch 到失败相关文件。
- [ ] 禁止通过删测试、改测试为跳过、扩大权限或切换 Node Runtime解决失败。
- [ ] 生成不可变 Build Report 与 package digest，安装时再次核对。

**测试：** 恶意源码、超时、内存、无限 Host Call、删测试、权限扩张、动态依赖和报告篡改。

**验收：** 只有报告与当前源码 digest 完全一致的包才能进入安装确认。

**提交边界：** `feat(plugin-studio): add constrained build and repair loop`

### 任务 1.8：Studio 前端

**新建：**

- `frontend/src/components/settings/plugins/PluginStudio.tsx`
- `frontend/src/components/settings/plugins/PluginSpecReview.tsx`
- `frontend/src/components/settings/plugins/PluginProjectFiles.tsx`
- `frontend/src/components/settings/plugins/PluginBuildReport.tsx`
- `frontend/src/components/settings/plugins/PluginPermissionReview.tsx`
- 对应组件测试文件。

**修改：**

- `frontend/src/components/settings/plugins/PluginSettingsTab.tsx`
- `frontend/src/lib/pluginStudioApi.ts`
- i18n 中文、英文资源。

**步骤：**

- [ ] Developer 页面增加“使用 AI 创建插件”，保持现有 Developer Mode 入口。
- [ ] 完成需求、Spec、Generate、Verify、Install 五步流程。
- [ ] 展示文件 Diff、权限理由、网络域名、Build Report 和失败修复历史。
- [ ] 安装继续调用现有 Package Install/Preflight，不创建旁路。
- [ ] Web/Mobile 只开放声明式草稿与预览；代码构建明确提示需要 Desktop。

**测试：** Loading/Empty/Error、取消、刷新恢复、权限变化、移动端分步 UI、键盘和无障碍。

**验收：** Desktop 管理员从一句需求到安装一个声明式插件和一个 Sandbox Action 插件均可闭环完成。

**提交边界：** `feat(plugin-studio): add spec-first creation workflow`

### R1 发布门禁

- [ ] 现有 V1/V2 插件回归通过。
- [ ] 声明式主题、模板、Prompt Pack 三个官方示例通过。
- [ ] AI 生成 20 个 Golden Request，Spec 有效率 100%，首轮构建率记录但不作为虚假 100% 目标。
- [ ] 自动修复最多三轮且不能扩大权限。
- [ ] Production Build、Electron smoke 和 Web UI E2E 通过。
- [ ] Feature Flag 可独立关闭 Studio，不影响已安装插件。

---

## 2. R2 — File Processing + Import/Export

### 任务 2.1：Opaque File Handle Broker

**新建：**

- 使用下一个空闲 migration 创建 `pluginFileCapabilityMigration.ts` 和 PostgreSQL DDL。
- `backend/src/plugins/files/fileHandleService.ts`
- `backend/src/plugins/files/fileStagingRecovery.ts`
- `backend/src/plugins/files/fileQuota.ts`
- `backend/tests/plugin-file-handles.test.ts`

**修改：**

- `packages/nowen-plugin-sdk/host-api-contract.json`
- `backend/src/plugins/hostApiBroker.ts`
- `backend/src/plugins/hostApiContract.generated.ts`
- `packages/nowen-plugin-sdk/src/hostApi.generated.ts`
- `backend/src/plugins/types.ts`
- `backend/src/plugins/permissions.ts`

**步骤：**

- [ ] 实现 execution-scoped opaque Handle 和 `stat/readChunk/createOutput/writeChunk/commit/discard`。
- [ ] Handle 绑定 plugin/execution/user/mode/TTL，不暴露真实路径。
- [ ] 建立 staging 配额、SHA-256、MIME 和启动清理。
- [ ] 对已有附件增加 `attachments.openFile`；真实写入完成后才开放 V2 `attachments:write`。
- [ ] 取消、超时、Sandbox crash 和 Host restart 都可恢复或清理。

**验收：** 50MB 测试文件可以受控分块处理；跨插件、跨用户、跨执行和过期 Handle 全部失败关闭。

**提交边界：** `feat(extensions): add opaque file capability broker`

### 任务 2.2：Importer/Exporter Contribution 与 Job Pipeline

**新建：**

- `backend/src/plugins/importExport/types.ts`
- `backend/src/plugins/importExport/jobService.ts`
- `backend/src/plugins/importExport/importPlan.ts`
- `backend/src/plugins/importExport/exportSnapshot.ts`
- `backend/src/routes/plugin-import-export.ts`
- `frontend/src/lib/pluginImportExportApi.ts`
- `frontend/src/components/plugins/PluginImportDialog.tsx`
- `frontend/src/components/plugins/PluginExportDialog.tsx`
- `backend/tests/plugin-import-export.test.ts`

**修改：**

- Manifest/Contribution contracts。
- App import/export menus and command registry。
- SQLite/PostgreSQL next-free migration registration。

**步骤：**

- [ ] Importer 按 extension/MIME 匹配，用户选择后创建 invocation-scoped input Handle。
- [ ] 插件返回受 Schema 限制的 `ImportPlan`，Host 生成 Preview。
- [ ] Commit 前校验 preview digest 和源版本，事务写入并记录 undo batch。
- [ ] Exporter 读取只读 `DocumentSnapshot`，返回 committed output Handle。
- [ ] Host 统一处理浏览器下载、Electron 保存、Android/iOS 分享和失败降级。

**验收：** Preview 前不写数据；源变化后旧 Preview 不能 Commit；取消和失败不留临时文件或半成品。

**提交边界：** `feat(extensions): add transactional import export jobs`

### 任务 2.3：Office Adapter 参考插件

**新建：**

- `examples/plugins/office-adapter/`
- `frontend/src/office/__tests__/corpus/` 中可入库小样本。
- Office Round-trip/Compatibility tests。
- `docs/plugin-platform/examples/office-adapter.md`

**修改：**

- `frontend/src/office/index.ts`
- `frontend/src/office/README.md`
- 必要时将纯 TS Parser/Serializer 抽到 `packages/nowen-office-ir`，但只有 Web Worker、Backend 和插件三方真实复用时才执行该拆包。

**步骤：**

- [ ] 先盘点当前 DOCX Parser/Viewer/Serializer 实际完成度并纠正文档漂移。
- [ ] 固定 OPC/DocxIR schema version 和兼容读取策略。
- [ ] 官方 Adapter 提供 DOCX → ImportPlan 与 DocumentSnapshot → DOCX。
- [ ] Excel 只做单 Sheet 只读/导入实验，PPT 只做大纲/只读 ViewModel 实验。
- [ ] 使用真实 Word/WPS/LibreOffice 样本建立语料矩阵。

**验收：** DOCX 导入/导出保持当前能力且通过 Transactional Pipeline；插件失败不会损坏源文件或已有笔记。

**提交边界：** `feat(office): dogfood import export extension contracts`

### R2 发布门禁

- [ ] File Handle 攻击矩阵、配额、Crash Recovery 全部通过。
- [ ] DOCX、PDF/OCR 示例和至少一个非 Office Importer 共用同一 Pipeline。
- [ ] 真实 1MB/10MB/50MB 文件性能与取消测试通过。
- [ ] Web/Electron/Android/iOS 输出保存链路真实验收。

---

## 3. R3 — Document Type Preview

### 任务 3.1：Internal Document Type Registry

**新建：**

- `frontend/src/documentTypes/types.ts`
- `frontend/src/documentTypes/registry.ts`
- `frontend/src/documentTypes/DocumentHost.tsx`
- `frontend/src/documentTypes/viewModelSchemas.ts`
- `frontend/src/documentTypes/__tests__/`
- `docs/architecture/document-type-host.md`

**修改：**

- File Manager and attachment preview routing。
- Manifest Contribution contract and Plugin API response types。

**步骤：**

- [ ] 先注册内置 Markdown/RichText/MindMap/Office Preview，消除新增格式时的散落分支。
- [ ] Host 统一加载、错误、空态、主题、无障碍、缓存和大小门禁。
- [ ] Experimental plugin Document Type 只返回校验后的 ViewModel，不注入 React/DOM。
- [ ] 插件禁用或缺失时保留原始附件并退回下载/外部打开。

**验收：** 新增一种只读文档格式只需注册 Definition 和 ViewModel Renderer，不修改 File Manager 主流程。

**提交边界：** `feat(documents): add internal document type registry`

### 任务 3.2：Word/Excel/PPT Preview 参考实现

**修改/新建：**

- `frontend/src/office/word/*`
- `frontend/src/office/excel/*`
- `frontend/src/office/ppt/*`
- 对应 Worker、ViewModel Schema、Corpus 和性能测试。

**步骤：**

- [ ] Word 使用现有 DocxIR 进入 Document Host。
- [ ] Excel E1 支持单 Sheet、数值、公式结果、合并和基础样式。
- [ ] PPT P1 只读 ViewModel/SVG，明确不支持动画和复杂 SmartArt。
- [ ] 大文件解析放入 Worker；主线程设置取消与进度。
- [ ] 未支持内容保留原始文件，并显示兼容性警告，不静默丢失。

**验收：** 三种 OOXML 格式都能安全预览、失败降级和下载原文件；不声称完整 Office 编辑兼容。

**提交边界：** `feat(office): add document host previews`

### R3 发布门禁

- [ ] Word、Excel、PPT 与第三方格式共四个 Registry 实现。
- [ ] 大文件不阻塞 UI，取消后 Worker/Handle 释放。
- [ ] 跨平台主题、缩放、键盘和无障碍通过。
- [ ] Public Document Type API 仍标记 Experimental，收集至少三个真实实现反馈后再冻结。

---

## 4. R4 — Marketplace 与生态 GA

### 任务 4.1：Marketplace 元数据与发现

**修改：**

- `packages/nowen-extension-registry/src/schema.ts`
- Registry publish/review routes。
- `backend/src/plugins/ecosystemRegistry.ts`
- `frontend/src/components/settings/plugins/PluginSettingsTab.tsx`
- `frontend/src/lib/pluginApi.ts`

**步骤：**

- [ ] 增加 Capability、Contribution、平台、AI-generated metadata 和兼容矩阵。
- [ ] 分类支持 Themes、Templates、Automation、AI Tools、Importer、Exporter、Documents、Connectors。
- [ ] 搜索和详情展示权限、网络域名、Runtime、测试状态和安全公告。
- [ ] “用此插件作为模板”只复制公开源码/模板，不复制签名、Secret 或 Publisher 身份。
- [ ] Marketplace 离线继续使用已签名有效缓存，不影响核心启动。

**验收：** 用户可以按能力而不是只按名称发现插件，并在安装前理解数据边界。

**提交边界：** `feat(marketplace): expose extension capabilities and templates`

### 任务 4.2：脚手架、CLI 与官方模板

**修改：**

- `packages/create-nowen-plugin/`
- `packages/nowen-plugin-cli/`
- `packages/nowen-plugin-sdk/`
- `examples/plugins/`
- `docs/plugin-platform/`

**步骤：**

- [ ] 新增 `theme/template/prompt/importer/exporter/document-preview` 模板。
- [ ] CLI 增加 `spec/check-capabilities/verify-report`，沿用 `validate/doctor/test/pack/sign/publish`。
- [ ] 发布 Theme Pack、Productivity Pack、Office Adapter、PDF/OCR 示例。
- [ ] 模板全部通过同一 CI，不保留只存在于文档的伪 API。

**验收：** 不使用 Studio 的开发者也可以在五分钟内创建并本地验证一个 V2.1 插件。

**提交边界：** `feat(extension-sdk): publish v2.1 templates and tooling`

### 任务 4.3：社区质量与指标

**修改/新建：**

- Registry review/report/telemetry schema。
- Studio 和 Marketplace aggregate event allowlist。
- `docs/plugin-platform/community.md`
- `docs/plugin-platform/extension-v2-1-release-gate.md`

**步骤：**

- [ ] 只采集固定聚合指标，明确排除 Prompt、代码、正文、附件名、Action 输入输出和 Secret。
- [ ] 建立 Verified 审核清单、恶意插件报告、安全公告和撤销演练。
- [ ] 发布插件需求榜、官方模板、Good First Plugin 和案例内容。
- [ ] 每月复盘生成成功率、权限放弃、7 日活跃、失败和回滚，决定下一项 Capability。

**验收：** Registry 发布、签名、下载、更新、撤销和离线缓存均有真实部署证据；本地测试不能被描述为 Marketplace 已上线。

**提交边界：** `docs(extensions): establish v2.1 community release gate`

---

## 5. 跨阶段安全检查

每个任务完成时都必须检查：

- [ ] 没有新增数据库、文件系统、Shell、Process、原始网络或 Secret 直通能力。
- [ ] Community 插件没有退回主进程或 Node Runtime。
- [ ] Permission 与真实 Host 方法一致，不存在只声明未实现权限。
- [ ] 新输入有大小、类型、次数、超时和资源预算。
- [ ] 日志、AI Context、Telemetry 和 Build Report 不包含用户正文或凭据。
- [ ] 禁用、卸载、回滚、撤销、离线和崩溃均有恢复语义。
- [ ] Web/Desktop/Android/iOS 的可用范围明确，不伪装成全平台。

## 6. 每阶段统一验证命令

具体命令以各 package 当前 scripts 为准，实施前先读取 `package.json`；最低门禁：

```bash
node scripts/generate-plugin-host-api.mjs --check
cd packages/nowen-plugin-sdk && npm test
cd packages/nowen-plugin-cli && npm test
cd backend && npm run build:tsc && npm test
cd frontend && npm run test:run -- <targeted suites> && npm run build
```

涉及 Electron/File Handle/Office 时额外执行真实进程和文件验证；涉及移动端时执行 Capacitor sync/build 与真机验收。Node backend tests 前如发生 ABI 不匹配，先 `npm rebuild better-sqlite3`；Electron 验证前再恢复 Electron ABI。

## 7. 推荐首个实施切片

不要从 Office 编辑器或完整 Studio 开始。第一批只执行：

1. 任务 0.1：V2.1 Feature Gate。
2. 任务 1.1：统一 Capability Catalog。
3. 任务 1.2：声明式 Runtime。
4. 任务 1.3：Appearance Contribution。
5. 用 Theme Pack 贯通安装、贡献、预览、选择、禁用、更新和回滚。

这五步能够用最低风险证明整个新架构；通过后再把同一模式扩展到 Template、Prompt 和 AI Studio。

## 8. 资源与周期估算

以下是工程规划估算，不是发布日期承诺；不包含完整 Office 编辑器、多人 Office 协作或任意第三方 UI Runtime。

| 阶段 | 主要结果 | 2–3 名工程师 | 单人配合 AI |
| --- | --- | ---: | ---: |
| R1 | 声明式生态 + Studio Alpha | 6–8 周 | 10–14 周 |
| R2 | File Broker + Import/Export + DOCX Adapter | 5–7 周 | 9–13 周 |
| R3 | Document Type Preview + Office 只读 | 8–12 周 | 14–22 周 |
| R4 | Marketplace、模板、文档与 GA | 4–6 周 | 7–10 周 |

建议最小团队包含：一名 Backend/Security、一名 Frontend/Product、一名 SDK/AI/Developer Experience；Office 真实兼容语料和移动端验收需要专项投入。

### Go / No-Go 检查点

- R1 结束：若主题、模板和简单 Action 仍无法稳定由 AI 生成并安装，不进入文件能力。
- R2 结束：若 File Handle 越权、崩溃清理或事务回滚未通过，不开放第三方 Office/PDF 插件。
- R3 结束：若未出现至少三个真实 Document Type 实现，不冻结 Public Document Type SDK。
- R4 发布：必须具有线上 Registry 拉取、签名验证、安装、更新、撤销和离线缓存的真实证据。
