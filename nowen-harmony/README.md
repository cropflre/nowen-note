# Nowen Note - HarmonyOS App

鸿蒙版 Nowen Note，基于 ArkTS + ArkWeb (WebView) 实现。

## 架构方案

**方案：ArkWeb WebView 壳应用 + 渐进式原生化**

复用现有 React/Vite/Web 前端，通过鸿蒙 ArkWeb 加载已部署的 nowen-note 服务端。
原生层负责：服务端地址配置、返回键处理、桥接通信、文件选择。

## 项目结构

```
nowen-harmony/
├── AppScope/                       # 应用级配置（DevEco 必需）
│   ├── app.json5                   # 应用 bundleName / 版本
│   └── resources/
├── entry/
│   ├── build-profile.json5
│   ├── hvigorfile.ts
│   ├── oh-package.json5
│   └── src/main/
│       ├── module.json5            # 模块配置 + 权限（INTERNET）
│       ├── ets/
│       │   ├── entryability/
│       │   │   └── EntryAbility.ets    # 应用入口，初始化存储，窗口管理
│       │   ├── pages/
│       │   │   ├── Index.ets           # 路由分发（有配置→WebView，无→配置页）
│       │   │   ├── ServerConfigPage.ets # 服务端地址配置（协议选择+地址+health校验）
│       │   │   └── WebViewPage.ets     # ArkWeb 主页面（核心，11.6KB）
│       │   ├── bridge/
│       │   │   ├── JsBridge.ets        # ArkTS ↔ WebView 双向通信协议
│       │   │   └── FilePicker.ets      # 原生文件/图片选择器（阶段3完善）
│       │   ├── services/
│       │   │   ├── PreferenceStore.ets # @ohos.data.preferences 持久化存储
│       │   │   ├── HealthChecker.ets   # @ohos.net.http 连通性校验
│       │   │   └── NetworkMonitor.ets  # 网络状态检测
│       │   └── utils/
│       │       ├── Constants.ets       # 全局常量
│       │       └── UrlValidator.ets    # URL 校验/规范化
│       └── resources/                  # 图标、字符串、颜色、路由配置
├── build-profile.json5             # 项目构建配置
├── hvigor-config.json5            # 构建工具配置
├── hvigorfile.ts                  # 构建入口
├── oh-package.json5               # 依赖配置
├── .gitignore
└── README.md
```

## 功能清单

### P0 - MVP（✅ 已完成）
- [x] AppScope 完整配置（app.json5、图标、字符串）
- [x] 服务端地址配置页（协议切换 + 地址输入 + `/api/health` 校验）
- [x] ArkWeb 加载 Web 前端（domStorage、database、JS、mixedMode 全启用）
- [x] 返回键分层处理（WebView 后退 → 双击退出）
- [x] 菜单：刷新页面 / 重新配置服务器 / 显示当前服务器
- [x] 错误页（加载失败 → 重新加载 / 重新配置）
- [x] JsBridge 双向通信（postMessage / _dispatch / on / off）
- [x] PreferenceStore 持久化（替代 localStorage）
- [x] HealthChecker（@ohos.net.http，带超时和错误处理）
- [x] NetworkMonitor（@ohos.net.connection）
- [x] 前端鸿蒙检测（isHarmonyOS / data-native="harmony"）
- [x] CSS safe-area 适配（--safe-area-top/bottom）
- [x] Capacitor 插件 HarmonyOS 跳过逻辑

### P1 - 核心体验（待实现）
- [ ] 原生文件选择器桥接（FilePicker → WebView input[type=file]）
- [ ] 深色模式跟随系统（Configuration.onConfigurationUpdate）
- [ ] 启动页配置
- [ ] 正式 PNG 应用图标（替换 SVG 占位）

### P2 - 增强能力（待实现）
- [ ] 网络状态变化 → JsBridge 通知 WebView
- [ ] 分享到 nowen-note
- [ ] 推送通知

## 开发环境

- DevEco Studio 5.0+
- HarmonyOS SDK API 12+
- 真机（推荐）或模拟器

## 如何运行

1. 用 DevEco Studio 打开 `nowen-harmony/` 目录
2. File → Sync and Refresh Project
3. 连接真机（需要开启开发者模式 + USB调试）
4. 点击 Run ▶

## JsBridge 通信协议

### 前端 → ArkTS
```javascript
window.__harmonyBridge__.postMessage('eventName', { key: value });
// 底层：console.log('[HARMONY_BRIDGE]JSON')，ArkTS 在 onConsole 中拦截
```

### ArkTS → 前端
```javascript
window.__harmonyBridge__._dispatch('eventName', data);
// ArkTS 通过 webviewController.runJavaScript() 调用
```

### 便捷 API
```javascript
// 获取网络状态
const type = await window.__harmonyBridge__.getNetworkType(); // 'wifi' | 'cellular' | 'none'

// 选择文件
const file = await window.__harmonyBridge__.pickFile({ accept: 'image/*' });

// 清除配置
window.__harmonyBridge__.clearServerConfig();

// 监听原生事件
window.__harmonyBridge__.on('networkChange', (data) => { ... });
window.__harmonyBridge__.on('darkModeChange', (data) => { ... });
```

### 环境检测
```typescript
// React/TypeScript
import { isHarmonyOS } from '@/hooks/useCapacitor';
if (isHarmonyOS()) { /* 鸿蒙特定逻辑 */ }

// CSS
html[data-native="harmony"] { /* 鸿蒙特定样式 */ }

// 原生 JS
if (window.__harmonyBridge__?.isHarmonyOS) { ... }
```

## 前端改动说明

### `frontend/src/hooks/useCapacitor.ts`
| 改动 | 说明 |
|------|------|
| `isHarmonyWebView()` | 检测 UA "HarmonyOS" 或 `window.__HARMONY__` |
| `isHarmonyOS()` | 导出给业务层 |
| data-native="harmony" | 模块加载时自动设置 |
| useStatusBarSync | HarmonyOS 跳过 Capacitor StatusBar 调用 |
| useBackButton | HarmonyOS 跳过（返回键由 ArkTS 处理） |
| useKeyboardLayout | HarmonyOS 跳过（键盘由 ArkTS 管理） |

### `frontend/src/index.css`
| 改动 | 说明 |
|------|------|
| `html[data-native="harmony"]` | safe-area 变量：top 32px, bottom 16px |

## 已知限制

1. **应用图标**：当前是 SVG 占位，需替换为 PNG（108x108, 1024x1024）
2. **文件上传**：`<input type="file">` 在 ArkWeb 的兼容性需真机验证
3. **中文输入法**：Tiptap contenteditable 在鸿蒙 IME 下的光标行为需测试
4. **启动页**：需在 DevEco 中配置 startWindow 相关资源
5. **签名配置**：release 构建需要配置签名证书
