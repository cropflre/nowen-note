# Markdown Fenced Code Authoring Capability

> Issue #774：增强 Typora 风格围栏代码块输入与 Markdown Live 编辑体验。

## 目标

Nowen Note 的 Markdown 必须继续以标准 Markdown 文本作为唯一数据源。

本能力只改善作者体验：

```text
输入规则
+ 语言提示
+ Live 编辑态
+ 预览态回到源码
```

不能把 fenced code 转换成私有富文本结构，也不能让 Markdown 导入/导出依赖 Nowen 专有格式。

## 1. Capability 边界

实现集中在：

```text
frontend/src/lib/markdownFenceAuthoring.ts
```

它提供两个内部扩展：

```text
markdownFencedCodeAuthoringExtension
markdownFencedCodeLiveEditingExtension
```

### Authoring Extension

始终安装在 Markdown CodeMirror：

- 输入 `` ```lang `` + Enter 自动补 closing fence；
- `~~~lang` + Enter 同样支持；
- 已有 closing fence 时只进入代码正文，不重复补齐；
- 支持 blockquote 前缀与 0~3 空格标准缩进；
- 多光标只有在所有 cursor 都位于有效 fence opening 时才接管 Enter；
- IME composing 时不接管 Enter；
- completion 正在显示时，Enter 优先交给补全系统；
- 一次事务完成补齐，因此一次 Undo 可以回退；
- `Cmd/Ctrl + Shift + K` 继续复用既有 `toggleCodeBlock()`；
- CodeMirror language data 提供轻量语言补全。

### Live Editing Extension

只随 `markdownLivePreviewExtension` 启用：

- 当前光标所在 `FencedCode` 保持源码可编辑；
- 代码区域显示统一编辑框背景；
- opening / closing fence 弱化；
- opening line 显示语言 badge；
- 正文仍使用 CodeMirror 现有 `codeLanguages` 与 syntax highlighting；
- 光标离开后继续由 `MarkdownPreview` 输出最终代码块。

因此不会复制 #198 已有的最终代码块渲染、高亮、复制按钮等逻辑。

## 2. 输入规则

用户输入：

````text
```bash|
````

按 Enter 后：

````text
```bash
|
```
````

事务只新增正文空行和 closing fence。保存后的数据仍然是标准 Markdown：

````markdown
```bash
command here
```
````

### Existing closing fence

输入：

````text
```bash|
```
````

按 Enter 后：

````text
```bash
|
```
````

不会再创建第三个 fence。

## 3. Fence 长度与 marker

opening 的 marker 和长度必须原样保留，例如：

    ```
    ~~~~
    ````
    ~~~~~~

四个反引号允许正文内出现三个反引号：

`````markdown
````markdown
```js
const example = true
```
````
`````

closing fence 必须使用相同 marker，且长度不得短于 opening。Tilde fence 的 info string 可以包含 `~`；backtick fence 的 info string 不接受额外 backtick，保持 CommonMark 语义。

## 4. 语言能力

源码语言名默认原样保存，不强制规范化。

内部 alias 只用于 Live badge，以及用户主动选择 completion 时的 canonical apply。

常用映射：

```text
js -> javascript
ts -> typescript
sh / shell -> bash
py -> python
yml -> yaml
md -> markdown
cs / c# -> csharp
ps1 -> powershell
```

常用 completion 包括：

```text
javascript / typescript / bash / python
html / css / json / yaml / sql / java
go / rust / c / cpp / csharp / powershell
maxscript / markdown / text
```

未知语言不应抛异常；Live badge 保留原始名称，最终预览继续沿用现有 `MarkdownPreview` 的安全降级。

## 5. Live 模式

原 Live 原则保持不变：

```text
active block -> source
inactive block -> MarkdownPreview widget
```

#774 增加：

```text
active FencedCode
    ↓
CodeMirror source + code-frame decoration
    ↓ cursor leaves
MarkdownPreview code block
```

不会在代码正文内部创建第二个编辑器，也不会维护“源码状态 + 富文本状态”两份数据。

## 6. Preview -> Edit

inactive fenced code 已由 `MarkdownPreview` 渲染。

点击代码块预览时，Live widget 会把 selection 放到 opening fence 后的第一行，而不是 fence 起始字符：

````text
Preview Code Block
      ↓ click
```bash
|   <- cursor
```
````

普通段落仍回到 block 起点。

## 7. 多光标

Live block collection 必须检查所有 selections，而不是只检查 `selection.main`。

例如：

```text
cursor A -> First block
cursor B -> Third block
```

如果只保护 A，Third block 可能被 `Decoration.replace` 替换成预览 widget，secondary cursor 会落进不可编辑区域。

现在所有 selection 相交的 block 都保留源码。

## 8. 不处理的行为

本 Issue 不实现完整 Typora WYSIWYG，也不：

- 新建私有 code-block 数据模型；
- 在 code block 内嵌套另一个 CodeMirror；
- 改写用户已有 fenced Markdown；
- 自动把所有 alias 强制替换成 canonical language；
- 重写 `MarkdownPreview`；
- 新建 `/code` 命令（项目已有并继续复用）；
- 为本能力开放 Plugin/Public API。

## 9. 性能

Live preview 原有 `350,000` 字符保护继续生效。

active fenced-code frame 基于 CodeMirror/Lezer incremental syntax tree 构建，只在 `docChanged` 或 `selectionChanged` 时重新计算。

没有按键级 React root，也没有第二编辑器实例。

## 10. 回归边界

至少覆盖：

    ```bash + Enter
    ~~~python + Enter
    existing closing fence
    4-backtick fence containing 3 backticks
    blockquote fence
    one-step Undo
    multi-cursor
    language aliases
    language completion
    unknown language fallback
    Live active code-frame
    Preview -> code-body anchor
    Live multi-cursor source preservation

并继续人工验证：

```text
中文 IME composition
Android soft keyboard Enter
iOS soft keyboard Enter
large Markdown Live performance
source/live/preview/split switching
```

## 11. 后续演进

当真实需求继续出现时，可以沿该能力增加：

```text
Fence Input Rule
       ↓
Language Completion
       ↓
Code Block Authoring Commands
       ↓
Optional formatter / runner adapters
```

运行代码、格式化器、LSP 等都属于新的安全/执行边界，不应该因为 #774 顺手加入。

当前 `markdownFenceAuthoring` 保持 Internal API，等至少出现更多真实消费者后再评估 Extension / Plugin API。
