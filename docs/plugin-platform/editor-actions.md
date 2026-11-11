# 编辑器扩展动作（1.6.0 Phase 3）

插件可以在两种编辑器（富文本 Tiptap、Markdown CodeMirror）的三个位置提供动作：
- 斜杠菜单
- 选区浮动工具栏
- 编辑器工具栏

动作只拿到用户明确选中的文字；结果由宿主在编辑器事务中写入，再走原有的保存与同步链路。同一份声明在两种编辑器中行为一致。

这是 Contribution 合同 v5 新增的 `editorActions` 类型（合同源文件：`packages/nowen-plugin-sdk/contribution-contract.json`）。设计依据见 [Phase 0 文档](./extension-experience-v16-phase0.md) ADR-05～07。

## 开关与兼容

- **开关**：`NOWEN_EDITOR_ACTIONS=1` 开启，默认关闭（D3）。关闭时：
  - 安装带 `editorActions` 的包会被拒绝（`PLUGIN_EDITOR_ACTIONS_DISABLED`）。
  - `/api/plugins/contributions` 不返回该字段。
  - 运行接口一律拒绝。
- **插件类型**：只有可执行的 V2 插件（`sandbox-js` / `node-action`）可以声明。不依赖 `NOWEN_EXTENSIONS_V21`，声明式插件不能声明。
- **宿主版本**：不额外要求 `engines.nowen >=1.6.0`，因为插件宿主版本仍为 1.5.3（D1）。旧宿主对 `contributes` 做严格校验，带 `editorActions` 的包在旧宿主上安装会直接失败（fail closed）。
- **平台**：Web 与桌面端可用；Capacitor 原生端本阶段不显示（P2）。

## 声明

```json
{
  "contributes": {
    "commands": [{ "id": "acme.text.wrap-quote", "title": "用引号包围", "action": "wrap-quote" }],
    "editorActions": [{
      "id": "wrap-quote",
      "command": "acme.text.wrap-quote",
      "label": "用引号包围",
      "description": "给选中的文字加上中文引号",
      "icon": "quote",
      "keywords": ["quote", "引号"],
      "placements": ["editor.selection", "editor.toolbar.actions"],
      "appliesTo": ["tiptap", "markdown"],
      "selectionMode": "text",
      "resultMode": "replace-selection",
      "requiresConfirmation": false
    }]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 插件内唯一；运行时 ID 为 `<pluginId>/<id>`，不会与内置命令或其他插件冲突 |
| `command` / `prompt` | 二选一：引用本插件 `commands[]`（再指向 `actions[]`），或引用本插件 `promptPacks[]` |
| `label`、`description` | 菜单显示，最多 60 / 200 字 |
| `icon` | 宿主白名单：`sparkles` `wand` `quote` `list` `case` `template` `translate` `summary` `text` |
| `placements` | `editor.slash`、`editor.selection`、`editor.toolbar.actions`，只决定显示位置，不授予任何权限 |
| `appliesTo` | `tiptap`、`markdown` |
| `selectionMode` | `none`：不读取选区；`text`：需要选区；`optional-text`：有选区时才传 |
| `resultMode` | `none`：只显示提示；`insert`：插入；`replace-selection`：替换选区；`open-preview`：先预览，由用户选择替换、插入或复制 |
| `requiresConfirmation` | 对 `insert` / `replace-selection` 也先显示预览 |
| `uiPlatform` | 可选的平台白名单 |

安装时的校验规则：
- 斜杠菜单里没有选区，所以带 `editor.slash` 的动作不能用 `text` 模式；选区菜单里的动作必须读取选区。
- `replace-selection` 要求 `selectionMode` 为 `text`。
- 被引用的 Action 不能是后台 Action。读取选区的动作必须在 `input` 中声明 `text: { type: "string" }`；除 `text` 之外不能有必填输入，因为宿主不会提供其他输入。
- Prompt 动作要求 `selectionMode` 为 `text`、`resultMode` 不为 `none`；Prompt 的 `context` 只能是 `selection`，输入项必须有默认值。
- 每个插件最多 30 个动作；`id` 不能重复；不接受未知字段，包括脚本回调、`href`、HTML 或 CSS。

## 两种动作

**Command 动作**在插件沙箱中运行被引用的 Action（超时 10 秒）：
- 读取选区时，输入为 `{ text }`；`selectionMode: "none"` 时输入为空对象，即使客户端带了文本也不会转发。
- 返回 `{ text }` 表示要写入的 Markdown，返回 `{ message }` 表示只显示提示。
- SDK 提供 `EditorActionInput` / `EditorActionOutput` 类型。

```js
globalThis.__nowenPluginModule = {
  actions: {
    "wrap-quote": ({ input }) => ({ text: `“${input.text}”` }),
  },
};
```

**Prompt 动作**（D2）由宿主用当前用户的 AI 配置执行，与写作助手相同：
- 同一个系统提示，60 秒超时。插件代码完全接触不到选中的文字，也不需要 `ai.*` Host API。
- 官方动作包按 D4 做成「可执行插件 + Prompt Pack」，因此不需要打开 V2.1 开关。
- 未开启或未配置 AI 时返回 `PLUGIN_EDITOR_AI_NOT_CONFIGURED`。

## 文本格式

- 两种编辑器都以 Markdown 交换文本：
  - **富文本编辑器**：选区序列化方式与 AI 写作助手相同，链接、图片和格式都会保留。
  - **Markdown 编辑器**：直接使用源码。
- 内部块标记（`^blk_…`）在发送前移除。替换时，宿主会把原有块 ID 放回结果，插件无法伪造块 ID。
- AI 结果带有和写作助手相同的 AI 来源标记。
- 结果永远不会按 HTML 渲染：
  - 预览只显示纯文本。
  - 富文本编辑器按「粘贴」的方式解析 Markdown：先经 DOMPurify 净化，再在惰性文档中解析，按编辑器 schema 生成节点。
  - 单行纯文本直接插入，保留空格和周围的格式；代码块内一律按纯文本插入。
- 在 Markdown 编辑器中插入多行结果时，结果作为当前行之后的新块插入，不会把当前行拆开。

## 执行流程与安全

1. **点击时生成快照**：去掉选区首尾的空白。以下情况直接拒绝：
   - 选区或插入点碰到加密块。
   - 选区超过 32 KB。
   - 正在输入法组合输入。
2. **请求**：`POST /api/plugins/:id/editor-actions/:actionId/run`，请求体为 `{ noteId, editor, text? }`。服务器依次检查：
   1. 开关是否开启。
   2. 插件是否已启用，并声明了该动作。
   3. 插件声明的权限是否全部授予。
   4. 编辑器类型是否匹配。
   5. 笔记 ACL：写入型动作需要写权限，`none` 动作只需读权限。不存在、无权访问和已在回收站的笔记返回同一个错误，防止探测笔记 ID。
   6. 笔记没有锁定、没有加密，所在目录或笔记本没有密码保护（与 AI 代理的 `PROTECTED_DOCUMENT` 规则一致）。
   7. 输入大小，以及是否夹带加密块。
   8. 每个用户最多同时运行 2 个动作。
3. **校验结果**：
   - 必须是对象。
   - `text` 不超过 64 KB，且不能包含加密块（伪造的加密块会让笔记无法保存）。
   - `message` 不超过 500 字。
   - 插件明确返回失败时，不写入任何内容。
4. **预览**：`open-preview` 或 `requiresConfirmation` 时先预览，确认后才写入。
5. **写入**：写入前重新确认以下条件，全部满足才通过一个编辑器事务写入（一次撤销即可恢复），再由原有的保存、Yjs 和 Sync V2 链路落盘：
   - 仍是同一篇笔记，编辑器仍挂载且可编辑。
   - 选区随后续编辑映射后的位置有效（Tiptap 用事务 mapping，CodeMirror 用 `ChangeSet.mapPos`），且该范围的原文与快照一致。

   任一条件不满足，就提示「文档已变化，结果没有写入」，并提供复制结果或重新运行，**绝不覆盖新内容**。

日志：插件运行记录只保存字节数。编辑器动作不保存插件的控制台输出和错误文本，服务器也不记录选中的文字。

## 错误码

| 代码 | HTTP | 含义 |
| --- | --- | --- |
| `PLUGIN_EDITOR_ACTIONS_DISABLED` | 403 | 开关关闭 |
| `PLUGIN_EDITOR_ACTION_NOT_FOUND` | 404 | 插件未启用或未声明该动作 |
| `PLUGIN_PERMISSION_DENIED` | 403 | 插件声明的权限未全部授予 |
| `PLUGIN_EDITOR_ACTION_UNSUPPORTED` | 400 | 编辑器类型不匹配、缺少选区或请求无效 |
| `PLUGIN_EDITOR_NOTE_FORBIDDEN` | 403 | 没有所需的笔记权限、笔记不存在或已在回收站 |
| `PLUGIN_EDITOR_NOTE_PROTECTED` | 403 | 锁定、加密、受密码保护，或选区含加密块 |
| `PLUGIN_INPUT_TOO_LARGE` | 400 / 413 | 选区超过 32 KB |
| `PLUGIN_EDITOR_ACTION_INVALID_RESULT` | 422 | 结果无效、过大或含加密块 |
| `PLUGIN_EDITOR_AI_NOT_CONFIGURED` | 409 | AI 未开启或未配置 |
| `PLUGIN_EDITOR_AI_FAILED` | 502 | AI 请求失败 |
| `PLUGIN_EDITOR_ACTION_BUSY` | 429 | 同一用户已有 2 个动作在运行 |
| `PLUGIN_TIMEOUT` | 408 | 插件或 AI 超时 |

## 示例插件

- [`examples/plugins/text-tools`](../../examples/plugins/text-tools/README.md)（第三方风格，无权限、不联网）：用引号包围、转为大写、行转列表（先预览）、统计字数（只显示提示）、会议纪要模板（斜杠菜单与工具栏）。
- [`examples/plugins/ai-text-assistant`](../../examples/plugins/ai-text-assistant/README.md)（官方）：AI 润色、AI 翻译为英文（预览后替换或插入）、AI 总结要点（确认后插入），以及一个本地的「整理空白」动作。

```bash
cd examples/plugins/text-tools && node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

```bash
cd examples/plugins/ai-text-assistant && node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

## 测试

```bash
cd backend && ELECTRON_RUN_AS_NODE=1 node ../node_modules/electron/cli.js --import tsx --import ./tests/setup-db-isolation.ts --test tests/editor-actions.test.ts
```

```bash
cd frontend && npx vitest run src/lib/editorActions src/components/editor-actions
```

```bash
cd frontend && npm run build && NOWEN_QA_NODE="$PWD/../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

- **后端测试**：在真实沙箱中运行两个示例插件，并覆盖拒绝场景（权限、受保护笔记、大小、伪造结果、并发上限）。还确认选中的文字不会写入运行记录。
- **适配器测试**：用同一组场景测试两种编辑器——替换与撤销/重做、编辑期间位置映射、旧结果被拒、插入、加密块拒绝、输入法组合、超大选区。
- **浏览器验收**（`frontend/e2e/editor-actions.spec.ts`）：
  - 通过生产路由安装两个打包好的插件。
  - 在两种编辑器中执行同一个斜杠命令，确认保存并能撤销/重做。
  - 选区替换、预览后替换、AI 预览。
  - 运行期间修改选区后，结果被拒绝写入。
  - 390px 窄屏菜单、锁定笔记不显示入口。

## 已知限制

- 不支持 `editor.contextMenu`（右键/长按）和命令面板（P1），也不支持 `editor.block` 嵌入块（P2）。
- 加密笔记和受密码保护目录中的笔记一律不提供动作，解锁后也不提供。
- Prompt 动作不支持交互式输入参数，AI 结果也不是流式输出：等完整结果返回后再预览。
- 窄屏下工具栏入口在「更多」中。
