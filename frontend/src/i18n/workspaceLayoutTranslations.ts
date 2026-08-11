export const zhCNWorkspaceLayoutTranslations = {
  workspaceLayout: {
    title: "布局模式",
    standard: "标准模式",
    standardDescription: "知识结构与编辑器，保留更宽的写作区域",
    threeColumn: "三栏模式",
    threeColumnDescription: "知识结构、笔记列表和编辑器；窄窗口自动降级",
    focus: "专注模式",
    focusDescription: "只显示编辑器，隐藏外侧导航",
    narrowFallback: "当前窗口较窄，笔记列表已暂时收起；扩大窗口后会自动恢复。",
    splitFallback: "左右分屏期间笔记列表会暂时收起，关闭分屏后自动恢复。",
    focusFallback: "退出专注模式后会恢复之前的布局。",
  },
} as const;

export const enWorkspaceLayoutTranslations = {
  workspaceLayout: {
    title: "Layout mode",
    standard: "Standard",
    standardDescription: "Knowledge structure and editor, with more room for writing",
    threeColumn: "Three columns",
    threeColumnDescription: "Knowledge structure, note list, and editor; adapts automatically on narrow windows",
    focus: "Focus",
    focusDescription: "Show only the editor and hide outer navigation",
    narrowFallback: "The window is currently narrow, so the note list is temporarily collapsed. It will return automatically when the window is wider.",
    splitFallback: "The note list is temporarily collapsed during side-by-side split view and will return when split view is closed.",
    focusFallback: "Your previous layout will be restored when you leave Focus mode.",
  },
} as const;
