# 插件作者指南（1.6.0）

本指南帮助插件作者选择 1.6.0 的扩展点、用 SDK 和 CLI 开发打包，并了解宿主强制执行的边界。

每个扩展点的完整合同都在对应文档里；这里的示例都对应仓库里打包并经 E2E 验证过的样例插件。

## 选择扩展点

| 想做的事 | 扩展点 | 关键字段 | 代码在哪里运行 | 合同 | 样例 |
| --- | --- | --- | --- | --- | --- |
| 被命令、自动化或 MCP 调用的处理逻辑 | Action / Command | `actions`、`contributes.commands` | 服务器 QuickJS 沙箱（`sandbox-js`） | [V2](./extension-platform-v2.md)、[权限](./permissions.md) | `task-digest` |
| 在编辑器里处理选中文字或插入内容 | 编辑器动作 | `contributes.editorActions`（引用 command） | 同上，只收到选区 | [编辑器扩展动作](./editor-actions.md) | `text-tools` |
| 用宿主配置的 AI 改写选区 | Prompt Pack + 编辑器动作 | `contributes.promptPacks`、`editorActions[].prompt` | 宿主 AI 服务，不运行插件代码 | [Prompt Pack](./prompt-pack-contribution.md) | `ai-text-assistant` |
| 一个完整页面 | V3 应用页面 | `apiVersion: 3`、`appPages`、`uiAssets` | 浏览器隔离 iframe | [V3 应用页面](./extension-platform-v3-app-runtime.md) | `hello-nowen-app` |
| 工作台上的一张卡片 | V3 Widget | `widgets` | 同上 | [Dashboard 与插件数据](./extension-platform-v3-dashboard-data.md) | `personal-dashboard` |
| 在笔记旁查看一个资源 | V3 检查器（默认关闭） | `inspectors` | 同上 | [资源检查器](./extension-platform-v3-inspector.md) | `resource-inspector` |
| 主题、模板、浮动工具等无代码贡献 | 声明式贡献（V2.1 开关） | `runtime: "declarative"` | 宿主渲染 | [UI Contributions](./ui-contributions.md) | `theme-pack`、`floating-dock` |

不确定时，优先选能满足需求的、权限最小的扩展点：

- 只处理选区文字，用编辑器动作，不要做成需要 `notes:read` 的 Action；
- 只需要 AI 改写，用 Prompt Pack，插件里不必有任何代码。

## 开发流程

```bash
npm create nowen-plugin        # TypeScript + @nowen/plugin-sdk 的 Action 插件骨架
cd my-plugin && npm install
npx nowen-plugin validate      # 校验 manifest
npx nowen-plugin build         # src/index.ts → manifest.main（sandbox-js 打成 IIFE）
npx nowen-plugin test          # 构建并在本地沙箱里试加载
npx nowen-plugin pack          # 生成 dist/<id>-<version>.nowen-plugin
```

装到测试服务器上验证：

1. 管理员在「我的插件 → 高级」上传 `.nowen-plugin`。
2. 在「审核并启用」中确认权限，然后启用。
3. 编辑器动作还需要服务器设置 `NOWEN_EDITOR_ACTIONS=1`。

发布到 Registry 前请阅读 [Registry V1](./registry-v1.md)、[GitHub 静态源](./github-static-registry.md) 和 [社区贡献指南](./community.md)。包需要 Publisher 签名，并通过 Registry 签名与哈希校验。

V3 应用的 UI 是预先构建好的静态资源，`pack` 之前要先构建，并更新 `uiAssets` 里每个文件的 SHA-256。

## SDK 示例：编辑器动作

编辑器动作由两部分组成：

- manifest 里的一条 `contributes.editorActions` 声明；
- 它引用的 command，以及这个 command 对应的 action 实现。

下面的声明取自 `examples/plugins/text-tools/manifest.json`：

```json
{
  "id": "community-sample.text-tools", "apiVersion": 2, "runtime": "sandbox-js", "main": "index.js",
  "engines": { "nowen": ">=1.5.3 <2.0.0" }, "permissions": [],
  "actions": [{ "id": "wrap-quote", "name": "用引号包围", "input": { "text": { "type": "string", "required": true } } }],
  "contributes": {
    "commands": [{ "id": "community-sample.text-tools.wrap-quote", "title": "用引号包围", "action": "wrap-quote" }],
    "editorActions": [{
      "id": "wrap-quote", "command": "community-sample.text-tools.wrap-quote",
      "label": "用引号包围", "icon": "quote", "keywords": ["quote", "引号"],
      "placements": ["editor.selection", "editor.toolbar.actions"], "appliesTo": ["tiptap", "markdown"],
      "selectionMode": "text", "resultMode": "replace-selection"
    }]
  }
}
```

用 SDK 编写同样的动作（`src/index.ts`）。这段代码已用 SDK 源码在 TypeScript `strict` 模式下通过类型检查：

```ts
import { definePlugin, NowenPluginError, type EditorActionOutput } from "@nowen/plugin-sdk";

export default definePlugin({
  actions: {
    // selectionMode "text"：宿主只把选中的 Markdown 放在 input.text 里。
    "wrap-quote": ({ input }): EditorActionOutput => {
      const text = typeof input.text === "string" ? input.text : "";
      if (!text.trim()) throw new NowenPluginError("请先选中文本", "INVALID_ARGUMENT");
      return { text: `“${text}”` };
    },
    // selectionMode "none" + resultMode "insert"：不发送文字，返回要在光标处插入的 Markdown。
    "meeting-template": (): EditorActionOutput => ({ text: "## 会议纪要\n\n- 时间：\n- 参会人：\n- 结论：\n" }),
    // resultMode "none"：只返回提示，不修改笔记。
    "count-words": ({ input }): EditorActionOutput => ({ message: `共 ${String(input.text ?? "").trim().split(/\s+/).filter(Boolean).length} 个词` }),
  },
});
```

`text-tools/index.js` 是同一组动作的纯 JavaScript 版本：没有构建步骤，直接打包。完整的 5 个动作在 `examples/plugins/text-tools`，AI 改写在 `examples/plugins/ai-text-assistant`。

选区相关规则：

- **`selectionMode`**：`text` 必须有选区；`optional-text` 有选区时才发送；`none` 不发送任何文字。
- **`resultMode`**：
  - `replace-selection`：替换选区；
  - `insert`：插入到光标处；
  - `open-preview`：先给用户预览，由用户选择替换、插入或复制；
  - `none`：只显示 `message`。
- **`requiresConfirmation: true`**：任何结果都会先预览再写入。结果较长、或可能大幅改写用户内容时，请开启。

## 宿主强制执行的边界

插件作者不需要、也无法绕过下列规则。设计功能时要按这些规则来。

### 沙箱插件（Action、编辑器动作）

- 代码在 QuickJS 沙箱中运行，没有 Node、DOM、`fetch` 等全局对象。
- 所有数据访问都要经过 Host API Broker，由插件权限、用户权限、工作区角色和资源 ACL 共同裁决。
- 外部网络只能通过 `external.fetch`，并且要在 `permissionConfig.externalFetchHosts` 中声明允许的主机。
- 参数、结果、并发和超时都有上限，见 [V2](./extension-platform-v2.md)。

### 编辑器动作

- **输入**：只有选中的文字。锁定、加密、受密码保护的笔记，以及没有编辑权限的笔记，都会在运行前被服务器拒绝。
- **结果**：只接受 `{ text }` 或 `{ message }`。下列结果会被拒绝（`PLUGIN_EDITOR_ACTION_INVALID_RESULT`）：
  - 文本为空或超过 64 KiB；
  - 含孤立的 UTF-16 代理项；
  - 伪造加密块。
- **富文本写入**：`text` 当作不可信 Markdown 处理，经过 DOMPurify 和编辑器 schema 过滤，脚本、事件属性和 `javascript:` 链接都会被去掉。
- **Markdown 编辑器写入**：原样插入源文本。
- **写入方式**：结果由宿主在一次编辑器事务中写入，可以撤销。用户在运行期间改动了原选区时，结果不会写入。插件拿不到编辑器对象，也不能自己写笔记。

### V3 应用页面、Widget、检查器

- **隔离**：页面运行在只带 `sandbox="allow-scripts"` 的 iframe 中，origin 不透明，CSP 禁止所有网络请求、子框架、表单和 Worker。
- **桥接**：只能通过宿主转交的 MessagePort 调用 `context.get`、`storage.*`、`navigation.open` 等方法，拿不到登录凭据和宿主 DOM。
- **不能离开自己的文档**：页面不能把自己的 iframe 导航到别的地址。
  - Web 端由宿主页面的 `frame-src` 拦截；
  - 桌面端由 Electron 主进程拦截；
  - 宿主检测到页面第二次加载时会关闭会话。
- **不要用其他通道外传数据**：浏览器 CSP 管不到 WebRTC 等通道，宿主无法在技术上完全阻断。用这类通道把用户数据发出去，属于违反平台政策的恶意行为：审核时会被拒绝；已发布的版本可以通过安全公告标记为恶意，并被停用。
- **一次性票据**：插件文档只能通过一次性票据加载（30 秒内有效，只能用一次）。

## 兼容与开关

- **`engines.nowen`**：当前插件宿主报告的版本仍是 1.5.3（D1，发版时决定是否与产品版本对齐），所以请写 `>=1.5.3 <2.0.0`，与样例插件一致。
- **编辑器动作**：受 `NOWEN_EDITOR_ACTIONS` 控制，默认关闭。
  - 关闭时，含 `editorActions` 的包安装会被拒绝（`PLUGIN_EDITOR_ACTIONS_DISABLED`）；
  - 已安装的插件在关闭后菜单消失、执行被拒绝，插件和数据保留。
- **V3 开关**：应用页面、Widget 和插件数据默认开启，检查器默认关闭。
  - 各开关见 [迁移与回滚](./extension-experience-v16-rollback.md#功能级回滚推荐)。
  - `platforms` 可以声明 `android`、`ios`，但当前宿主只在 `web` 和 `desktop` 上创建会话，原生 App 不运行 V3 UI。

## 提交前自查

- [ ] 权限最小：没有用到的权限不声明；只处理选区的功能不申请 `notes:read`。
- [ ] 同一个编辑器动作在富文本和 Markdown 中都试过：替换、插入、撤销、重做，以及运行中改动选区后被拒绝。
- [ ] 可能大段改写用户内容的动作，开启了 `requiresConfirmation` 或使用 `open-preview`。
- [ ] V3 UI 不依赖任何网络请求；在深色主题和 390px 宽度下可用；所有控件都有可读的名称。
- [ ] `nowen-plugin validate`、`test`、`pack` 都通过，并在开启相关开关的测试服务器上装过一遍。
