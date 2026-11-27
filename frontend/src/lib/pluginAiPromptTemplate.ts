// lib/pluginAiPromptTemplate.ts —— 供用户一键复制给外部 AI（DeepSeek / ChatGPT / Claude / Cursor 等）的插件开发规范提示词

export const AI_FOOLPROOF_GUIDE_URL =
  "https://github.com/cropflre/nowen-note/blob/main/docs/plugin-platform/ai-foolproof-plugin-guide.md";

/**
 * 生成一段自包含的 Nowen Note 插件开发提示词。
 * 用户只需填写自己的需求，复制给任意主流大模型即可产出符合规范、可直接打包上传的 `.nowen-plugin` 插件。
 */
export function buildPluginAiPrompt(userRequirement = "", locale: "zh" | "en" = "zh"): string {
  const requirement = userRequirement.trim();

  if (locale === "en") {
    return `# Nowen Note Plugin Development Prompt

You are a senior Nowen Note plugin engineer. Please design and generate a complete, ready-to-package \`.nowen-plugin\` extension strictly following the official Nowen Note specification below.

## 1. Choose the Simplest Matching Plugin Type
1. **Editor Selection / Text Tool (\`apiVersion: 2\`, \`runtime: "sandbox-js"\`, \`main: "index.js"\`)**
   - Best for transforming selected text, inserting templates, counting/formatting.
   - Runs in QuickJS sandbox (NO Node, NO DOM, NO \`window\`, NO \`fetch\`).
   - \`index.js\` MUST assign: \`globalThis.__nowenPluginModule = { actions: { "<actionId>": ({ input }) => ({ text: "..." }) } };\`
   - Return shape for editor actions: \`{ text: string }\` or \`{ message: string }\` (max 64 KiB, non-empty).
2. **No-Code AI Prompt Pack (\`apiVersion: 2\`, \`runtime: "declarative"\` or \`sandbox-js\`)**
   - Uses \`contributes.promptPacks\` + \`contributes.editorActions[].prompt\` so the host AI runs the prompt with zero plugin code.
3. **No-Code Theme / Template Pack (\`apiVersion: 2\`, \`runtime: "declarative"\`, \`permissions: []\`)**
   - Uses \`contributes.noteThemes\` or \`contributes.noteTemplates\`. No \`index.js\` needed.
4. **Standalone App Page / Dashboard Widget (\`apiVersion: 3\`, \`runtime: "declarative"\`)**
   - Uses \`contributes.uiAssets\` (map of relative file path -> \`sha256:<hex>\`), \`contributes.appPages\`, and/or \`contributes.widgets\`.
   - Frontend JS inside the isolated iframe talks to the host via \`window.NowenApp.call("storage.get" | "storage.set" | "context.get" | "navigation.open", ...)\`.

## 2. Manifest Rules (MUST follow strictly)
- Root file MUST be \`manifest.json\`.
- Required fields: \`id\` (reverse-domain like \`myname.my-plugin\`), \`name\`, \`description\`, \`version\` (semver like \`1.0.0\`), \`apiVersion\` (\`2\` or \`3\`), \`publisher\`, \`engines: { "nowen": ">=1.6.0 <2.0.0" }\`, \`runtime\`, \`permissions\` (least privilege).
- Allowed permissions ONLY: \`notes:read\`, \`notes:write\`, \`notebooks:read\`, \`notebooks:write\`, \`tags:read\`, \`tags:write\`, \`tasks:read\`, \`tasks:write\`, \`attachments:read\`, \`attachments:write\`, \`diary:read\`, \`diary:write\`, \`mindmaps:read\`, \`mindmaps:write\`, \`plugin-storage:read\`, \`plugin-storage:write\`, \`external:fetch\`, \`secrets:use\`.
- Do NOT require \`npm install\` inside the plugin package; output self-contained plain JS/HTML/CSS files.

## 3. Packaging Output Requirements
Please output:
1. Complete contents of every file (\`manifest.json\`, \`index.js\` or \`ui/*\`, \`README.md\`).
2. A one-line packaging script (both macOS/Linux \`zip\` and Windows PowerShell \`Compress-Archive\`, plus a Node.js one-liner if \`uiAssets\` SHA-256 hashes need to be computed) that produces \`<id>-<version>.nowen-plugin\`.
3. Installation reminder: Drag the generated \`.nowen-plugin\` file into Nowen Note **Extension Center**, confirm permissions, and enable it.

---
## My Plugin Requirement
${requirement || "[Describe what you want the plugin to do here, e.g. 'Add an editor action that converts selected lines into a Markdown checklist']"}`;
  }

  return `# Nowen Note 插件傻瓜式开发提示词

你是一名精通 Nowen Note 插件平台的资深工程师。请严格按照下方官方规范，为我生成一套**零额外依赖、可直接打包上传**的 \`.nowen-plugin\` 插件完整文件与一键打包命令。

## 一、请根据我的需求自动选择最简单、权限最小的插件类型

1. **编辑器文字处理 / 模板插入（推荐优先，最稳）**
   - \`apiVersion: 2\`，\`runtime: "sandbox-js"\`，\`main: "index.js"\`，\`permissions: []\`
   - 运行在 QuickJS 沙箱：**没有** Node / DOM / \`window\` / \`fetch\`。
   - \`index.js\` 必须使用纯 JS 并挂载到 \`globalThis.__nowenPluginModule\`：
     \`\`\`js
     globalThis.__nowenPluginModule = {
       actions: {
         "my-action": ({ input }) => ({ text: "处理后的 Markdown 文本" }), // 或 { message: "仅提示不改正文" }
       },
     };
     \`\`\`
   - \`manifest.json\` 中同时声明 \`actions\`、\`contributes.commands\` 与 \`contributes.editorActions\`：
     - \`placements\` 可选：\`["editor.selection", "editor.toolbar.actions", "editor.slash"]\`
     - \`appliesTo\`：\`["tiptap", "markdown"]\`
     - \`selectionMode\`：\`"text"\`（必须选中文本）| \`"optional-text"\` | \`"none"\`（光标处插入）
     - \`resultMode\`：\`"replace-selection"\` | \`"insert"\` | \`"open-preview"\` | \`"none"\`
2. **AI 快捷提示词工具（免代码，直接调用用户已配置的 AI）**
   - \`apiVersion: 2\`，\`runtime: "declarative"\`，\`permissions: []\`
   - 在 \`contributes.promptPacks\` 声明提示词，在 \`contributes.editorActions\` 用 \`"prompt": "<promptId>"\` 关联，无需写 \`index.js\`。
3. **阅读主题 / 笔记模板包（纯声明式免代码）**
   - \`apiVersion: 2\`，\`runtime: "declarative"\`，\`permissions: []\`
   - 使用 \`contributes.noteThemes\`（含 \`modes.light\` / \`modes.dark\`）即可，无需写代码。
4. **独立页面小应用 / 工作台卡片（V3 应用）**
   - \`apiVersion: 3\`，\`runtime: "declarative"\`，常用权限 \`["plugin-storage:read", "plugin-storage:write"]\`
   - 静态资源放在 \`ui/\`（如 \`ui/index.html\`、\`ui/app.js\`、\`ui/style.css\`），并在 \`contributes.uiAssets\` 填写每个文件的 \`"sha256:<64位小写hex>"\`。
   - 界面在隔离 iframe 中通过 \`window.NowenApp\` 与宿主通信：
     - \`await window.NowenApp.ready\`
     - \`await window.NowenApp.call("storage.get", { key })\` / \`call("storage.set", { key, value })\`
     - \`await window.NowenApp.call("context.get")\` / \`window.NowenApp.on("theme.changed", fn)\`

## 二、Manifest 硬性规范（务必遵守，否则导入校验会报错）
- 包根目录必须直接包含 \`manifest.json\`（不要多套一层外层文件夹！）。
- 必填字段：\`id\`（如 \`myname.my-plugin\`，仅小写字母/数字/点/短横线）、\`name\`、\`description\`、\`version\`（如 \`1.0.0\`）、\`apiVersion\`（\`2\` 或 \`3\`）、\`publisher\`、\`engines: { "nowen": ">=1.6.0 <2.0.0" }\`、\`runtime\`、\`permissions\`。
- 仅允许使用以下权限名（遵循最小权限原则，不需要就填 \`[]\`）：
  \`notes:read\`, \`notes:write\`, \`notebooks:read\`, \`notebooks:write\`, \`tags:read\`, \`tags:write\`, \`tasks:read\`, \`tasks:write\`, \`attachments:read\`, \`attachments:write\`, \`diary:read\`, \`diary:write\`, \`mindmaps:read\`, \`mindmaps:write\`, \`plugin-storage:read\`, \`plugin-storage:write\`, \`external:fetch\`, \`secrets:use\`。
- **不要**要求在插件目录执行 \`npm install\` 或引入第三方 npm 依赖，请直接输出自包含的纯 JS / HTML / CSS 文件。

## 三、请你输出的内容
1. **每个文件的完整代码**（可直接复制保存，不要省略或用 \`...\` 代替）。
2. **一键打包成 \`.nowen-plugin\` 的命令**（同时给出 macOS/Linux 终端命令和 Windows PowerShell 命令；若为 V3 应用请附带自动计算 \`uiAssets\` SHA-256 并打包的 Node.js 脚本，确保直接跑通）。
3. **简要使用步骤**：把生成的 \`.nowen-plugin\` 文件拖进 Nowen Note 扩展中心页面 → 确认权限并启用 → 在哪里触发使用。

---
## 我的插件需求（请根据下面描述开发）
${requirement || "【在这里写下你想做的插件功能，例如：在编辑器选中多行文字后，一键把它们整理成带序号的 Markdown 表格，并统计总行数】"}`;
}
