# Markdown 斜杠快捷命令 / Markdown slash commands

在 Markdown 源码或分栏编辑模式下，在行首或空格后输入 `/`，即可在光标旁显示命令菜单。继续输入英文关键词或中文名称可筛选；匹配不区分英文大小写。

In Markdown source or split editing mode, type `/` at the start of a line or after whitespace to open the command menu next to the cursor. Filter by command name or keywords, case-insensitively.

| 输入 / Input | 功能 / Action |
| --- | --- |
| `/H1` … `/H6` | 一级至六级标题 / Heading levels 1–6 |
| `/code` | 代码块 / Fenced code block |
| `/tab` 或 `/table` | 表格 / Table |
| `/ul`、`/ol`、`/todo` | 无序、有序、待办列表 / Bullet, ordered and task lists |
| `/quote` 或 `/引用` | 引用 / Blockquote |
| `/bold`、`/italic` | 加粗、斜体 / Bold and italic |
| `/hr` | 分割线 / Horizontal rule |

- 电脑：上下方向键选择，Enter 或 Tab 执行；也可以点击菜单项。菜单会显示完整命令名，例如 `/h1`、`/table`。
- 手机：点击菜单项执行；菜单可滚动并在可见视口内避让边缘。
- Escape、点击菜单外或离开编辑器可关闭菜单，保留输入的 `/关键词`。无匹配项时继续普通编辑。
- 代码块、行内代码、URL 中的斜杠和只读笔记不触发命令。中文输入法组合输入期间不执行菜单选项。
- 执行后使用编辑器的撤销，可恢复命令执行前的文字。

Use the arrow keys and Enter/Tab, click, or tap to choose an item. Escape, clicking outside, or leaving the editor dismisses the menu without deleting the query. Code, URLs and read-only notes do not trigger commands. IME composition does not select an item. Undo restores the text before a command was executed.

菜单复用已有 Markdown 编辑命令和保存链路，不改变笔记格式、数据库或同步协议。该改进尚未发布；桌面与移动尺寸浏览器回归和安装包、真机验收的区别见 [验证记录](../qa/v1.5.2/markdown-slash-menu.md)。

This uses the existing Markdown commands and persistence flow, with no data-format or sync-protocol changes. These improvements are unreleased; see the [validation record](../qa/v1.5.2/markdown-slash-menu.md) for platform coverage.
