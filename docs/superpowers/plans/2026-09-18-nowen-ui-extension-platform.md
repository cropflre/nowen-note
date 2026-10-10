# Nowen UI Extension Platform 实施计划

**设计依据：** `docs/superpowers/specs/2026-09-18-nowen-ui-extension-platform-design.md`

**状态：** UI-R0/R1 第一段已实现：声明式 Action、Floating Layer Host、受控导航与设备本地布局；布局编辑器和 Sandboxed Custom UI 尚未开始。

**目标：** 先通过声明式 Floating Dock 验证 Slot、Placement、布局恢复和用户控制，再逐步开放声明式 UI SDK 与隔离的自定义 UI Runtime。

**版本原则：** 本轨道使用 `UI-R0` 至 `UI-R4`，不替代 AI 原生扩展平台 V2.1 的 R1–R4。所有能力使用独立、默认关闭的 Feature Flag 增量交付。

---

## UI-R0：合同、Slot Registry 与内部导航能力

### 任务 UI-0.1：建立 UI Contribution Contract

**预计修改：**

- `packages/nowen-plugin-sdk/contribution-contract.json`
- `packages/nowen-plugin-sdk/capability-catalog.json`
- `scripts/generate-plugin-host-api.mjs`
- `backend/src/plugins/types.ts`
- `backend/src/plugins/manifest.ts`
- `frontend/src/lib/pluginApi.ts`
- 生成的 SDK、Backend Schema 和开发者文档。

**步骤：**

- [x] 定义首期 Slot、Action kind、允许位置、平台、图标/导航白名单和稳定错误码。
- [x] Manifest 只描述组件和 `allowedSlots`；用户 Placement 不写回插件 Manifest。
- [x] 为 UI 合同增加版本与 digest，并进入统一 `--check`。
- [x] 增加 `uiExtensions/uiLayoutEditor/sandboxedPluginUi` 依赖式 Feature Flag，全部默认关闭。
- [x] Feature Flag 关闭时不注册 UI Contribution，不改变现有导航与启动路径。

**测试：** 合同生成漂移、未知 Slot/kind、跨插件 ID、平台不匹配、非法样式和 Flag fail-closed。

**验收：** 一个虚拟声明式组件能通过同一 Manifest、SDK、Backend Validator、Frontend 类型和 AI Catalog 表达，且无手写漂移。

### 任务 UI-0.2：建立 Host Slot Registry 和 Navigation Internal API

**预计新建：**

- `frontend/src/lib/uiExtensions/uiSlotRegistry.ts`
- `frontend/src/lib/uiExtensions/uiContributionRegistry.ts`
- `frontend/src/lib/uiExtensions/uiLayoutResolver.ts`
- `frontend/src/lib/uiExtensions/navigationCapability.ts`

**步骤：**

- [ ] 将当前可导航目标提取为 Internal API，复用 `ViewMode` 与现有权限/Feature 判断。
- [ ] 注册 `floating-layer/sidebar/editor-toolbar/dashboard/status-bar`，首期只启用 Floating Layer。
- [ ] Resolver 合并 Host 默认项、插件 Contribution、用户 Placement、平台和工作区 Feature。
- [ ] 保留 Settings、插件管理、安全模式和恢复默认布局的 Host-owned 入口。
- [ ] 不改写 `NavRail` 行为，只建立并行能力与契约测试。

**验收：** Registry 和 Resolver 可以在不渲染新 UI 的情况下稳定解析布局；插件不能导航到用户无权访问的目标。

**UI-R0 发布门禁：**

- [ ] Feature Flag 关闭回归与当前版本一致。
- [ ] Capability Contract、SDK、Backend、Frontend、Docs 和 AI Catalog 无漂移。
- [ ] Slot/Navigation 权限由 Host 判定，插件输入不能伪造当前用户或工作区。

---

## UI-R1：Floating UI Slot 与官方 Floating Dock

### 任务 UI-1.1：布局持久化与恢复

**预计新建：**

- 下一个空闲 SQLite migration 与 PostgreSQL DDL。
- `backend/src/routes/ui-layouts.ts`
- `backend/src/services/uiLayoutService.ts`
- `frontend/src/lib/uiExtensions/uiLayoutApi.ts`

**步骤：**

- [ ] 布局归属 user/workspace/device scope，默认设备本地。
- [ ] revision 乐观锁保护拖拽与多窗口并发修改。
- [ ] 样式只保存白名单字段，不持久化任意 CSS/HTML。
- [ ] 插件禁用、卸载或组件消失时转 dormant，不删除用户 Placement。
- [ ] 提供恢复默认、撤销本次编辑和安全模式入口。

**测试：** Owner 隔离、revision 冲突、非法组件引用、禁用回退、重新安装恢复、多窗口与移动端 scope。

### 任务 UI-1.2：Floating Layer Host

**预计新建：**

- `frontend/src/components/ui-extensions/FloatingLayerHost.tsx`
- `frontend/src/components/ui-extensions/DeclarativeUiRenderer.tsx`
- `frontend/src/components/ui-extensions/UiExtensionErrorBoundary.tsx`
- 对应组件与 E2E 测试。

**步骤：**

- [ ] Host 负责 safe area、z-index、碰撞边界、最大尺寸和触控命中区域。
- [ ] 支持位置、展开方向、尺寸档位、透明度、模糊等级和自动隐藏。
- [ ] Desktop/Web 支持拖拽及键盘移动；Mobile 使用受控停靠点。
- [ ] 冷启动先显示安全布局，再恢复插件组件，避免白屏和导航丢失。
- [ ] 单组件异常只替换为可恢复错误占位。

### 任务 UI-1.3：官方 Floating Dock 与第三方证明插件

**预计新建：**

- `examples/plugins/floating-dock/`
- `examples/plugins/alternative-floating-launcher/`
- `docs/plugin-platform/ui-contributions.md`
- `.github/workflows/ui-extension-ci.yml`

**步骤：**

- [ ] 官方 Dock 只使用公共声明式 Contribution 和 Command/Navigation 能力。
- [ ] Alternative Launcher 使用不同结构、顺序和表现，禁止 Host 特判。
- [ ] 两个插件覆盖安装、放置、拖拽、禁用、更新、卸载和恢复。
- [ ] 对 `NavRail.tsx` 增加边界测试，禁止加入官方 Dock pluginId 特判。

**UI-R1 发布门禁：**

- [ ] 官方和第三方 Dock 均无需修改 Host 源码。
- [ ] 核心逃生入口在任意用户布局下可达。
- [ ] Web/Electron/Mobile、Light/Dark、缩放、键盘、触控和无障碍通过。
- [ ] Feature Flag 关闭后现有 `NavRail` 行为与视觉不变。

---

## UI-R2：声明式 UI SDK 与零代码布局编辑器

### 任务 UI-2.1：扩展声明式组件

- [ ] 开放 action/group/badge/status/panel 组件。
- [ ] 开放 Sidebar、Editor Toolbar、Dashboard 和 Status Bar Slot。
- [ ] 状态订阅使用 Host allowlist event，不允许插件任意观察 App 状态。
- [ ] 同一组件可由用户放入多个允许 Slot；Host 根据平台生成适配表现。
- [ ] 组件状态、Badge 更新和事件订阅有频率与尺寸预算。

### 任务 UI-2.2：零代码布局编辑器

- [ ] 提供组件库、画布、Slot 高亮、拖拽、键盘排序和实时预览。
- [ ] 提供添加、删除、隐藏、分组、样式面板、撤销、恢复默认。
- [ ] 清楚区分“Nowen 内置”“插件提供”“插件缺失”。
- [ ] 不允许用户配置导致 Settings、安全模式或插件管理不可达。
- [ ] 保存前运行 Layout Validator，失败时保留上一稳定 revision。

**UI-R2 发布门禁：**

- [ ] 至少三个真实组件跨两个以上 Slot 复用。
- [ ] 插件缺失、平台不支持和工作区 Feature 关闭均有明确占位或回退。
- [ ] Desktop/Mobile 独立布局不会互相覆盖。
- [ ] 声明式 SDK 稳定后才标记 Public；否则继续作为 Experimental Extension API。

---

## UI-R3：Sandboxed Custom UI

### 任务 UI-3.1：受控构建与静态 UI 包

- [ ] 复用 Plugin Studio 固定 Builder，不运行插件 package scripts。
- [ ] React/Vue/HTML/CSS 必须构建为自包含静态资源；依赖和输出受 allowlist、大小和 digest 校验。
- [ ] Manifest 声明入口、允许 Slot、最小/最大尺寸和 Bridge capability。
- [ ] Package Validator 拒绝远程脚本、动态 import、Node builtin 和未声明资源。

### 任务 UI-3.2：iframe Runtime 与 UI Bridge

- [ ] iframe 默认仅 `sandbox="allow-scripts"`，不允许 same-origin、表单、弹窗、下载或顶层导航。
- [ ] CSP 默认 `default-src 'none'`，只加载已验证包内资源。
- [ ] Bridge 同时校验 `event.source`、instance token、生命周期 generation、Schema、权限和预算。
- [ ] 默认无网络；数据读写继续经过现有 Host Broker 和权限确认。
- [ ] 限制消息频率、请求超时、响应大小、挂载数量和后台存活时间。
- [ ] Frame 崩溃或洪泛时熔断单实例，不影响 Host。

### 任务 UI-3.3：安全验证

攻击用例至少覆盖：Host DOM、其他 iframe、Token/Storage、Electron/Capacitor、路径与文件、直接网络、消息伪造、重放、过大消息、无限循环、弹窗/下载、CSP 绕过和焦点劫持。

**UI-R3 发布门禁：** 任一隔离绕过、权限绕过、身份混淆、崩溃扩散或核心入口遮挡未解决时保持 Feature Flag 关闭，不进入 Marketplace。

---

## UI-R4：布局生态与 GA

- [ ] 布局显式导入、导出和预览，导入不携带签名、Secret 或 Publisher 身份。
- [ ] 设备本地与共享布局采用明确选择，接入 Sync Engine 的 revision/冲突模型。
- [ ] Marketplace 展示 Slot、平台、组件类型、权限、性能预算和验证状态。
- [ ] 插件/布局版本迁移失败时保留上一稳定布局。
- [ ] 建立布局模板、Good First UI Plugin、审核清单和安全撤销演练。
- [ ] 只采集固定聚合指标，不记录 HTML、源码、组件内容、Bridge 参数或用户数据。

**UI-R4 发布门禁：** 必须有真实 Registry 安装、更新、撤销、离线缓存、布局恢复和跨设备冲突证据；本地示例不能被描述为 UI Marketplace 已上线。

---

## 推荐首个开发切片

第一轮只实施 UI-R0 和 UI-R1 的最小闭环：

1. UI Contribution Contract 与 Feature Flag。
2. Slot Registry、Layout Resolver 和受控 Navigation Internal API。
3. user/device-scoped 布局持久化与恢复默认。
4. Floating Layer Host。
5. 官方 Floating Dock 与 Alternative Launcher 双示例。
6. 合同、生命周期、无障碍、跨平台和源码边界测试。

本切片不包含 iframe、自定义 React/Vue、任意 CSS、网络、文件或正文访问。

## 统一完成定义

每个 UI 阶段都必须同时产出：Capability Contract、实现、回归测试、开发者文档、官方示例、第三方证明夹具、Feature Flag 和发布门禁。只完成一套四按钮 Dock 不算 UI Extension Platform 完成。
