import { Extension } from "@tiptap/core";

/**
 * Word / WPS 习惯的对齐快捷键（Issue #915）：Ctrl/Cmd+E 居中，Ctrl/Cmd+L 左对齐；
 * 行内代码让出 Ctrl/Cmd+E，改为 Ctrl/Cmd+Shift+E。
 *
 * 与加粗等格式一样，编辑器自带与快捷键注册表（lib/shortcuts/commands.ts）默认值一致的键位；
 * 用户在设置里改键后，由 ShortcutRuntimeBridge 在捕获阶段处理新键位并拦住旧默认值。
 * 优先级高于 StarterKit 行内代码的 Mod-E 和 TextAlign 自带的 Mod-Shift-E（居中）。
 */
export const AlignmentShortcuts = Extension.create({
  name: "nowenAlignmentShortcuts",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      "Mod-e": () => this.editor.commands.setTextAlign("center"),
      "Mod-l": () => this.editor.commands.setTextAlign("left"),
      "Mod-Shift-e": () => this.editor.commands.toggleCode(),
    };
  },
});
