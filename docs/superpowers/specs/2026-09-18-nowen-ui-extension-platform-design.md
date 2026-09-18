# Nowen UI Extension Platform 设计规格

## 1. 产品定义

Nowen UI Extension Platform 让用户决定功能放在哪里、界面如何组合以及如何交互。它不是 `NavRail` 的皮肤系统，也不是允许插件接管主应用 DOM 的注入机制。

平台提供两种互补模式：

1. **零代码布局编辑器**：所有用户通过拖拽、排序、显隐和样式配置组合 Host 原生组件与插件声明式组件。
2. **自定义 UI 插件**：高级用户和开发者在隔离 iframe 中运行自己打包的 React、Vue 或 HTML/CSS/JavaScript UI，并通过受控 Bridge 请求 Host 能力。

产品目标：

```text
插件声明可用组件与能力
→ Host 注册到 Slot Registry
→ 用户决定 Placement 与外观
→ Layout Resolver 生成当前设备工作空间
→ Host 原生渲染或隔离 iframe 渲染
→ Plugin UI Bridge 执行经过授权的动作
```

## 2. 核心原则

### 2.1 布局归用户，组件归插件

插件可以声明一个组件允许进入哪些 Slot，并提供默认建议；插件不能写死最终位置、覆盖用户顺序或在更新时重置布局。

用户布局保存 namespaced component key：`${pluginId}/${componentId}`。插件失效时保留 dormant reference；重新启用兼容版本后可恢复原位置。

### 2.2 Host 保持外壳控制权

以下能力始终由 Host 掌握：

- Slot 的边界、层级、最大尺寸和安全区域。
- Settings、插件管理、安全模式、恢复默认布局等逃生入口。
- 当前用户、工作区、设备与平台的布局解析。
- 权限确认、导航、数据访问、通知和生命周期。
- iframe 的创建、销毁、CSP、消息校验与异常隔离。

### 2.3 自由绘制不等于自由注入

自定义 UI 可以控制自己 Frame 内的 React/Vue/HTML/CSS，但不能：

- 读取或修改 Host/其他插件 DOM。
- 读取 Host Cookie、Token、LocalStorage、IndexedDB 或数据库。
- 直接访问 Electron、Node、Capacitor 或原生桥。
- 绕过 Bridge 发起未声明的网络、文件或 Host 操作。
- 覆盖系统对话框、权限确认、登录或安全入口。

## 3. UI Slot 模型

首批 Slot：

| Slot | 用途 | 首次开放阶段 |
| --- | --- | --- |
| `floating-layer` | 悬浮导航、快捷工具、迷你状态组件 | UI-R1 |
| `sidebar` | 导航分组、工具面板 | UI-R2 |
| `editor-toolbar` | 编辑器动作与上下文工具 | UI-R2 |
| `dashboard` | 首页卡片、统计和启动入口 | UI-R2 |
| `status-bar` | 同步、计时器和插件状态 | UI-R2 |
| `command-palette` | 无固定可视位置的动作入口 | 复用现有 Command |

Slot 由 Host 注册：

```ts
interface UiSlotDefinition {
  id: UiSlotId;
  supportedKinds: UiComponentKind[];
  platforms: Array<"web" | "desktop" | "android" | "ios">;
  maxInstances: number;
  sizePolicy: "host-fixed" | "bounded-resizable";
  visibilityContext: Array<"global" | "workspace" | "editor" | "selection">;
}
```

插件不能创建覆盖全屏或系统安全 UI 的新 Slot。新增 Slot 先作为 Internal API，经真实复用验证后才进入公共合同。

## 4. 声明式 UI Contribution

声明式组件由 Nowen 原生渲染，不执行插件 UI 代码：

```ts
interface DeclarativeUiContribution {
  id: string;
  kind: "action" | "group" | "badge" | "status" | "panel";
  label: string;
  description?: string;
  icon?: string;
  command?: string;
  allowedSlots: UiSlotId[];
  defaultPlacementHint?: UiSlotId;
  platforms?: Array<"web" | "desktop" | "android" | "ios">;
  presentation?: {
    emphasis?: "normal" | "primary" | "danger";
    compact?: boolean;
  };
}
```

约束：

- `command` 必须引用同一插件已声明并验证的 Command。
- Icon 只允许 Host 图标 ID或通过包校验的静态资源，不允许远程 URL。
- 文案、Badge、状态值有长度和更新频率限制。
- `defaultPlacementHint` 只是首次建议，最终 Placement 由用户确认或 Host 默认布局决定。
- 插件更新删除组件时，Layout Resolver 产生 dormant item，不把相邻组件重新排序。

## 5. 用户布局模型

布局与插件 Manifest 分离：

```ts
interface UiLayoutProfile {
  id: string;
  ownerUserId: string;
  workspaceId: string | null;
  deviceScope: "local" | "shared";
  revision: number;
  items: UiLayoutItem[];
  createdAt: string;
  updatedAt: string;
}

interface UiLayoutItem {
  id: string;
  componentKey: string;
  slot: UiSlotId;
  order: number;
  visible: boolean;
  style: Record<string, string | number | boolean>;
}
```

首期默认 `deviceScope: local`，避免桌面、移动端因尺寸和输入方式不同互相覆盖。UI-R4 再提供显式共享、导入、导出和冲突处理。

布局写入必须带 `revision`，并复用用户偏好/Sync Engine 的冲突语义，不由单个插件维护同步。

Host 对样式提供白名单，例如位置、方向、尺寸档位、透明度、模糊等级、自动隐藏和强调色；不接受任意 CSS 字符串。

## 6. Floating Dock 参考插件

Floating Dock 是第一个官方声明式 UI 插件，必须与第三方插件走同一合同、Registry、Layout Resolver 和生命周期。

它可以贡献：

- 导航动作按钮。
- 按用户配置组合的分组。
- 展开方向、尺寸、透明度、毛玻璃等级和自动隐藏建议。
- Desktop、Web 和 Mobile 的平台适配声明。

禁止在 `NavRail.tsx`、`App.tsx` 或 Layout Resolver 中使用 `pluginId === official-floating-dock` 特判。

验收必须同时安装第二个测试插件 `alternative-floating-launcher`，证明它可以创建完全不同的悬浮入口而无需修改 Host 源码。

## 7. Sandboxed Custom UI Runtime

自定义 UI 使用独立 iframe Runtime，不复用 `sandbox-js` Action Worker。

```text
Host Slot Container
→ 创建 Plugin UI Instance
→ 加载已验证静态包和 CSP
→ iframe sandbox="allow-scripts"
→ 建立 instance-scoped Bridge channel
→ Schema + identity + permission + budget guard
→ Host API / Command / Navigation Broker
```

### 7.1 iframe 策略

- 默认不设置 `allow-same-origin`、`allow-forms`、`allow-popups`、`allow-downloads` 或 top navigation。
- `default-src 'none'`；脚本、样式、图片和字体只允许已验证的包内资源。
- 默认禁止直接网络访问；外部请求必须经过现有受控网络能力和域名权限。
- Host 不把 JWT、刷新令牌、数据库路径、用户目录或 Electron preload 注入 Frame。
- Frame 被隐藏、超限、崩溃或插件禁用时，Host 销毁实例并释放监听器。

由于 opaque origin 的事件来源可能是 `null`，Bridge 不能只校验字符串 origin。每条消息必须同时校验：

- `event.source === iframe.contentWindow`
- Host 生成的不可猜测 channel/instance token
- 绑定的 pluginId、componentId、userId 和 lifecycle generation
- 严格消息 Schema、方法 allowlist、权限和调用预算
- 请求 ID、超时、响应大小和消息频率

插件消息中的 pluginId 仅用于诊断，不能作为授权身份来源。

### 7.2 Bridge 能力

首批只考虑低风险能力：

- `navigation.open`
- `commands.execute`
- `ui.openSettings`
- `ui.showToast`
- `context.getTheme`
- `context.getLocale`
- `context.subscribe` 的有限事件

笔记正文、附件、网络、文件或写操作继续走现有 Permission/Host Broker，不因运行在 UI Frame 获得隐式权限。

## 8. 生命周期与恢复

```text
Installed → Contribution Registered → Placed → Mounted
        ↘ Disabled/Revoked/Missing → Dormant → Fallback
        ↘ Updated → Contract Revalidate → Compatible Restore or Dormant
```

- 启动时先渲染 Host 安全布局，再异步恢复已验证插件 UI，避免白屏。
- 单个组件抛错由每实例 Error Boundary 接管，不能卸载整个 App shell。
- 消息洪泛、长任务或连续崩溃触发临时熔断，并向用户提供重试、禁用和恢复默认布局。
- 任何时候都保留键盘命令或安全模式进入 Settings/插件管理。
- 插件卸载不删除布局引用；用户可清理或在重新安装后恢复。

## 9. 跨平台与无障碍

- Desktop/Web：支持完整拖拽，同时提供键盘移动与顺序调整。
- Mobile：使用预定义安全区域和触控尺寸，不照搬桌面自由坐标。
- Slot Host 提供 ARIA 角色、焦点顺序、Tooltip、Reduced Motion 和高对比度约束。
- iframe 组件必须声明可访问名称；Host 包装器提供聚焦、关闭和错误状态。
- 插件样式不得突破 Host 提供的最大尺寸、z-index 分层和 safe area。

## 10. 数据、隐私与指标

允许记录固定聚合事件：Slot 类型、组件 kind、启用/禁用、渲染成功、崩溃、熔断和布局恢复。

禁止记录组件内容、用户自定义标签、笔记正文、Bridge 参数、HTML、源码、Token 或 Secret。

## 11. 非目标

- 不允许插件重写整个 App shell、登录页、权限对话框或插件管理页面。
- 不开放任意 Host DOM selector、CSS 注入或 React Component 直接挂载。
- 不承诺 npm 运行时依赖安装；React/Vue 等必须在受控构建阶段打包成静态资源。
- 不把 UI 插件等同于主题；Appearance Token 与 UI Placement 是正交能力。
- 不在 UI-R1/UI-R2 开放自定义 iframe 代码。

## 12. 成功标准

- 普通用户能通过零代码编辑器组合自己的 Floating Dock。
- 同一插件组件可以由用户放入多个允许的 Slot，而不是由开发者写死。
- 官方 Floating Dock 与第三方替代 Dock 走同一公开合同。
- 插件失效时主界面可用、布局可恢复、核心入口可达。
- Sandboxed UI 无法读取 Host DOM、凭据、数据库、原生桥或其他插件 UI。
- Feature Flag 关闭时产品行为与现有 Nowen 完全一致。
