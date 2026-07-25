import type { ShortcutCategory, ShortcutChord, ShortcutCommand } from "./types";

export const MOD = "Mod";

function allPlatforms(...chords: readonly ShortcutChord[]): ShortcutCommand["defaultKeys"] {
  return { macos: chords, windows: chords, linux: chords };
}

const headings = ([1, 2, 3, 4, 5, 6] as const).map<ShortcutCommand>((level) => ({
  id: `heading-${level}`,
  label: `标题 ${level}`,
  description: `切换为 ${level} 级标题`,
  category: "rich-text",
  scope: "editor",
  defaultKeys: allPlatforms([MOD, "Alt", String(level)]),
  availableIn: ["web", "desktop"],
  tooltipAliases: [`标题 ${level}`, `标题${level}`, `${level} 级标题`, `${level}级标题`, `Heading ${level}`],
}));

export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  {
    id: "new-note", label: "新建笔记", description: "创建一篇新笔记", category: "global",
    scope: "noneditable", defaultKeys: allPlatforms([MOD, "N"]), availableIn: ["web", "desktop"],
  },
  {
    id: "open-settings", label: "打开设置", description: "打开应用设置", category: "global",
    scope: "noneditable", defaultKeys: allPlatforms([MOD, ","]), availableIn: ["desktop"],
  },
  {
    id: "global-search", label: "搜索笔记", description: "搜索整个笔记库", category: "global",
    scope: "noneditable", defaultKeys: allPlatforms([MOD, "F"]), availableIn: ["web", "desktop"],
  },
  {
    id: "command-palette", label: "命令面板", category: "global", scope: "noneditable",
    description: "打开搜索与工作台命令面板；编辑器内 Ctrl/Cmd+K 保留给链接",
    defaultKeys: allPlatforms([MOD, "K"]), availableIn: ["web", "desktop"],
  },
  {
    id: "shortcut-help", label: "键盘快捷键", description: "打开快捷键帮助中心", category: "global",
    scope: "input-safe", defaultKeys: allPlatforms([MOD, "Shift", "/"]), availableIn: ["web", "desktop"],
  },
  {
    id: "toggle-note-list", label: "显示/隐藏笔记列表", description: "在管理模式与创作模式之间切换",
    category: "navigation", scope: "noneditable", defaultKeys: allPlatforms([MOD, "Shift", "B"]),
    availableIn: ["web", "desktop"],
  },
  {
    id: "undo", label: "撤销", description: "撤销上一步编辑", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "Z"]), availableIn: ["web", "desktop"], tooltipAliases: ["撤销", "Undo"],
  },
  {
    id: "redo", label: "重做", description: "恢复上一步撤销", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "Shift", "Z"]), availableIn: ["web", "desktop"], tooltipAliases: ["重做", "Redo"],
  },
  ...headings,
  {
    id: "paragraph", label: "正文", description: "切换为普通正文段落", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "Alt", "0"]), availableIn: ["web", "desktop"], tooltipAliases: ["正文", "Paragraph"],
  },
  {
    id: "bold", label: "加粗", description: "切换粗体", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "B"]), availableIn: ["web", "desktop"], tooltipAliases: ["加粗", "粗体", "Bold"],
  },
  {
    id: "italic", label: "斜体", description: "切换斜体", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "I"]), availableIn: ["web", "desktop"], tooltipAliases: ["斜体", "Italic"],
  },
  {
    id: "underline", label: "下划线", description: "切换下划线", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "U"]), availableIn: ["web", "desktop"], tooltipAliases: ["下划线", "Underline"],
  },
  {
    id: "strikethrough", label: "删除线", description: "切换删除线", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "Shift", "S"]), availableIn: ["web", "desktop"],
    tooltipAliases: ["删除线", "Strikethrough", "Strike"],
  },
  {
    id: "inline-code", label: "行内代码", description: "切换行内代码样式", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "E"]), availableIn: ["web", "desktop"],
    tooltipAliases: ["行内代码", "Inline code", "Inline Code"],
  },
  {
    id: "link", label: "插入链接", description: "为选中文本插入或编辑链接", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "K"]), availableIn: ["web", "desktop"],
    tooltipAliases: ["链接", "插入链接", "编辑链接", "Link"],
  },
  {
    id: "clear-format", label: "清除格式", description: "移除选中文本的行内样式", category: "rich-text", scope: "editor",
    defaultKeys: allPlatforms([MOD, "Shift", "X"]), availableIn: ["web", "desktop"],
    tooltipAliases: ["清除格式", "Clear format", "Clear Format"],
  },
  {
    id: "editor-search", label: "当前笔记搜索与替换", description: "在当前笔记中搜索或替换",
    category: "rich-text", scope: "editor", defaultKeys: allPlatforms([MOD, "F"]), availableIn: ["web", "desktop"],
    tooltipAliases: ["查找替换", "搜索替换", "Search and replace", "Search & replace"],
  },
];

export const SHORTCUT_CATEGORY_LABELS: Readonly<Record<ShortcutCategory, string>> = {
  global: "全局", navigation: "导航与布局", "rich-text": "富文本编辑", markdown: "Markdown 编辑", desktop: "桌面端",
};
