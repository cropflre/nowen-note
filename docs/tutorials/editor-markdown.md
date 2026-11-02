# Markdown 编辑器使用教程

> 用 Markdown 语法高效编写笔记。

---

## 切换到 Markdown 模式

nowen-note 支持两种编辑器模式：富文本（Tiptap）和 Markdown（CodeMirror 6）。

切换方法：

1. 在编辑器底部状态栏，找到编辑器模式切换按钮
2. 点击切换到 Markdown 模式

或者通过 URL 参数：`?md=1` 强制 Markdown 模式。

---

## Markdown 语法速查

### 标题

```markdown
# 一级标题
## 二级标题
### 三级标题
```

### 文字格式

```markdown
**加粗**
*斜体*
~~删除线~~
`行内代码`
```

### 列表

```markdown
- 无序列表项
- 另一项

1. 有序列表项
2. 另一项

- [ ] 待办事项
- [x] 已完成
```

### 引用

```markdown
> 这是引用文字
```

### 代码块

```markdown
\`\`\`javascript
const hello = "world";
\`\`\`
```

### 链接和图片

```markdown
[链接文字](https://example.com)
![图片描述](图片URL)
```

### 表格

```markdown
| 列1 | 列2 | 列3 |
|---|---|---|
| 内容 | 内容 | 内容 |
```

### 数学公式

```markdown
行内公式 $E = mc^2$

块级公式：
$$
\frac{-b \pm \sqrt{b^2-4ac}}{2a}
$$
```

---

## Markdown 模式的斜杠命令

在 Markdown 模式中同样支持斜杠命令，输入 `/` 弹出命令菜单：

| 命令 | 效果 |
|---|---|
| `/h1` `/h2` `/h3` | 标题 |
| `/ul` `/ol` `/todo` | 列表 |
| `/quote` | 引用 |
| `/code` | 代码块 |
| `/hr` | 分割线 |
| `/bold` `/italic` | 格式 |
| `/image` `/table` | 插入 |
| `/ai` | AI 助手 |

---

## 两种模式对比

| 特性 | 富文本（Tiptap） | Markdown（CodeMirror） |
|---|---|---|
| 编辑方式 | 所见即所得 | 源码编写 |
| 格式化 | 工具栏 + 快捷键 | Markdown 语法 |
| 斜杠命令 | ✅ | ✅ |
| AI 功能 | ✅ | ✅ |
| 适合人群 | 普通用户 | 偏好 Markdown 的用户 |

两种模式的数据是互通的，切换模式不会丢失内容。

---

## 章节折叠

在源码模式或分屏的源码侧，点击标题左侧的箭头，可以收起该标题下的正文和下级章节；折叠范围到下一个同级或更高层级标题之前为止。再次点击箭头或省略号即可展开。代码块等可折叠内容也会显示箭头。

折叠只影响当前编辑器的显示，不修改 Markdown，也不向其他设备同步折叠状态。搜索定位或从目录跳转到隐藏内容时，会自动展开对应区域。预览侧保持全文显示；关闭语法解析的大文档轻量模式不提供折叠。

快捷键：Windows / Linux 使用 `Ctrl + Shift + [` 折叠光标所在章节或内容块，`Ctrl + Shift + ]` 展开；macOS 使用 `Cmd + Option + [` / `Cmd + Option + ]`。`Ctrl + Alt + [` / `Ctrl + Alt + ]` 用于折叠全部顶层区域 / 全部展开；大文档尚未完成解析时，全部折叠可能只覆盖已解析区域。

---

## 快捷键

Markdown 模式下常用的快捷键：

| 快捷键 | 效果 |
|---|---|
| `Ctrl/Cmd + B` | 加粗 |
| `Ctrl/Cmd + I` | 斜体 |
| `Ctrl/Cmd + K` | 链接 |
| `Ctrl/Cmd + H` | 搜索替换 |
| `Tab` | 缩进 |

---

## 下一步

- [富文本编辑器教程](./editor-rich-text.md) — 所见即所得模式
- [表格、代码块、数学公式](./advanced-blocks.md) — 高级功能
- [斜杠命令和快捷操作](./slash-commands.md) — 命令速查

---

> 本教程基于 nowen-note v1.1.18 编写。
