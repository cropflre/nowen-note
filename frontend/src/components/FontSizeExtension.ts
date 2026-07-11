/**
 * FontSize / TextStyle / Color 三件套扩展（基于官方 v3 扩展）
 * --------------------------------------------------------------
 * 目的：
 *   为 Tiptap 编辑器提供"任意字号 + 任意前景色"的能力，配合现有的多色
 *   Highlight（背景色）共同组成完整的"文字外观"工具集。
 *
 * 关键事实（v3 与 v2 的差异）：
 *   - @tiptap/extension-text-style v3 已经把 FontSize / Color / FontFamily /
 *     LineHeight / BackgroundColor 全部并入，**只有命名导出，没有 default export**。
 *     `import TextStyle from "@tiptap/extension-text-style"` 在 v3 下会得到
 *     `undefined`，进而把它塞进 useEditor extensions 数组就会触发
 *     "Cannot read properties of undefined (reading 'name')"。
 *   - @tiptap/extension-color v3 仅作为薄壳，re-export 自上面那个包的 Color。
 *     这里我们直接从 extension-text-style 里命名导入 TextStyle / Color / FontSize，
 *     不再装 extension-color。
 *
 * 设计要点：
 *   1. 通过 `.extend()` 给官方 FontSize 增加值合法性校验（避免恶意 CSS）；
 *      并加上 Mod-Shift-X 快捷键来一键清除全部 inline 文本格式。
 *   2. 颜色侧由 Color 自身处理；上层 UI 只通过 swatch + `<input type="color">`
 *      注入有限值，安全风险可控。
 *   3. TableFidelityExtension 只为现有 table 节点补充安全的保真属性，不替换
 *      原表格扩展，因此主编辑器、导入、导出和 schema repair 可以共享同一 schema。
 *
 * 序列化：
 *   - generateHTML  → `<span style="font-size:20px;color:#ef4444">…</span>`
 *   - generateJSON  → `{ type:'text', marks:[{ type:'textStyle',
 *                       attrs:{ fontSize:'20px', color:'#ef4444' } }] }`
 *   - Markdown 互转 → 由 contentFormat.ts 的 Turndown 规则将 `<span style>`
 *     原样保留为 inline HTML（CommonMark 允许 inline HTML）。
 *
 * 使用方式：
 *   import { TextStyleKit } from "@/components/FontSizeExtension";
 *   useEditor({ extensions: [..., ...TextStyleKit] })
 */
import { Extension } from "@tiptap/core";
import {
  TextStyle,
  Color,
  FontSize as FontSizeBase,
} from "@tiptap/extension-text-style";
import { TableFidelityExtension } from "@/components/extensions/TableFidelityExtensions";

declare module "@tiptap/core" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    fontSize: {
      /** 设置选区字号，传入 CSS font-size 合法值（如 "20px" / "1.2em" / "150%"） */
      setFontSize: (size: string) => ReturnType;
      /** 清除选区字号 */
      unsetFontSize: () => ReturnType;
    };
  }
}

/** 字号值合法性校验：允许 8–96 px、0.5–6 em/rem、50–600%，避免 XSS / 排版灾难 */
export function isValidFontSize(raw: string): boolean {
  if (!raw) return false;
  if (!/^[\d.]+(px|em|rem|%)$/.test(raw)) return false;
  if (raw.length > 12) return false;
  const m = raw.match(/^([\d.]+)(px|em|rem|%)$/);
  if (!m) return false;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return false;
  switch (m[2]) {
    case "px":
      return num >= 8 && num <= 96;
    case "em":
    case "rem":
      return num >= 0.5 && num <= 6;
    case "%":
      return num >= 50 && num <= 600;
  }
  return false;
}

/**
 * 在官方 FontSize 上叠一层：
 *   - setFontSize 拦截非法值，避免 inline style 注入
 *   - 注册 Mod-Shift-X 清除全部 inline 文本格式快捷键
 */
const FontSize = FontSizeBase.extend({
  addCommands() {
    // Tiptap v3 的类型定义里 `this` 不再暴露 `parent`，但运行时仍存在；
    // 这里用 any 断言获取父扩展的命令，保持与 v2 行为一致。
    const parentCommands = (this as any).parent?.() ?? {};
    return {
      ...parentCommands,
      setFontSize:
        (size: string) =>
        ({ chain }: any) => {
          if (!isValidFontSize(size)) return false;
          return chain().setMark("textStyle", { fontSize: size }).run();
        },
    } as any;
  },
});

/** Mod-Shift-X 全局清除 inline 文本格式（独立扩展，便于在没有 fontSize/color 时也生效） */
const ClearInlineFormatHotkey = Extension.create({
  name: "clearInlineFormatHotkey",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-x": ({ editor }) => {
        return editor
          .chain()
          .focus()
          .unsetMark("textStyle")
          .unsetMark("highlight")
          .unsetMark("bold")
          .unsetMark("italic")
          .unsetMark("underline")
          .unsetMark("strike")
          .unsetMark("code")
          .run();
      },
    };
  },
});

/**
 * 共享扩展集合：TextStyle（容器 mark）+ Color（前景色）+ FontSize（自定义字号）
 * + 安全的表格保真全局属性。
 *
 * 顺序很重要：TextStyle 必须在前，Color / FontSize 都依赖它。
 *
 * 与 Highlight（背景色）解耦：Highlight 是独立 mark（对应 <mark>），不归
 * 到 textStyle 里，因此本数组里不包含它。Tiptap 的多色 Highlight 已经在
 * 编辑器主入口配置过 `multicolor: true`，工具栏只要直接调
 * `setHighlight({ color })` / `unsetHighlight()` 即可。
 */
export const TextStyleKit = [
  TextStyle,
  Color,
  FontSize,
  ClearInlineFormatHotkey,
  TableFidelityExtension,
];

/** 预设字号档位（px） */
export const FONT_SIZE_PRESETS: { label: string; value: string; key: string }[] = [
  { label: "小", value: "12px", key: "small" },
  { label: "标准", value: "16px", key: "normal" },
  { label: "大", value: "20px", key: "large" },
  { label: "超大", value: "24px", key: "xLarge" },
];

/** 颜色 swatch 预设：暗色模式下也能保持可读 */
export const COLOR_PRESETS: string[] = [
  "#0f172a", // slate-900
  "#475569", // slate-500
  "#94a3b8", // slate-400
  "#ef4444", // red-500
  "#f97316", // orange-500
  "#eab308", // yellow-500
  "#22c55e", // green-500
  "#10b981", // emerald-500
  "#06b6d4", // cyan-500
  "#3b82f6", // blue-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
];

/** 高亮（背景色）swatch 预设：低饱和度，不喧宾夺主 */
export const HIGHLIGHT_PRESETS: string[] = [
  "#fef9c3", // yellow-100
  "#fed7aa", // orange-200
  "#fecaca", // red-200
  "#bbf7d0", // green-200
  "#a5f3fc", // cyan-200
  "#bfdbfe", // blue-200
  "#ddd6fe", // violet-200
  "#fbcfe8", // pink-200
  "#e5e7eb", // zinc-200
  "#fde68a", // amber-200
  "#bae6fd", // sky-200
  "#fecdd3", // rose-200
];
