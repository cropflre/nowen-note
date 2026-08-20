/**
 * CalloutExtension —— 自研高亮块（Callout）扩展。
 *
 * 来源：官方 Tiptap 无 callout 节点；社区 npm 包（nooxat / bicou / 其它 tiptap-callout）
 * 均已下架/404；唯一活跃参考是 Umo Editor（umodoc/editor，MIT）的开源实现
 * （src/extensions/callout/index.js）。本文件按项目风格将其翻译为 TypeScript，
 * 并按 nowen 架构做了两处适配：
 *
 * 1. content 用 "block+" 而非 Umo 的 "paragraph+"：与自研 Column 节点一致，
 *    允许高亮块内放代码块/列表等任意块级内容，也更符合"栏内成高亮块"的诉求，
 *    且不会被 schema 校验拒绝。
 * 2. 不引入 Vue NodeView（Umo 用 VueNodeViewRenderer + 气泡菜单），改为静态
 *    renderHTML（div[data-type="callout"] > icon span + content div），
 *    JSON → HTML → JSON round-trip 天然无损（repairTiptapJson 不丢节点），
 *    也避免在 React 项目里引入 Vue 运行时。
 *
 * 保留 Umo 的关键交互：
 *  - insertCallout 命令：有选区 → 把选区内容包进高亮块（非法内容降级为纯文本段落）；
 *    无选区 → 插入空高亮块。
 *  - `:::callout ` 行首输入规则（wrappingInputRule）。
 *  - Enter 键：空高亮块内回车直接跳出到新段落（Umo addKeyboardShortcuts 逻辑）。
 */

import { Node, mergeAttributes, wrappingInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CalloutNodeView } from "./CalloutView";
import type { CalloutType } from "./calloutTypes";

export type { CalloutType } from "./calloutTypes";
export { CALLOUT_TYPE_META, CALLOUT_TYPE_ORDER as CALLOUT_TYPES } from "./calloutTypes";

declare module "@tiptap/core" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    callout: {
      insertCallout: (options?: { type?: CalloutType; icon?: string }) => ReturnType;
    };
  }
}

const Callout = Node.create({
  name: "callout",
  group: "block",
  // block+ 与自研 Column 一致：允许任意块级内容（代码块/列表/嵌套块），
  // 避免 content 过严导致 schema 校验拒绝插入。
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      type: {
        default: "blue" as CalloutType,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-callout-type") || "blue",
        renderHTML: (attributes: Record<string, any>) => ({
          "data-callout-type": attributes.type,
        }),
      },
      icon: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.querySelector(".prosemirror-callout-icon")?.textContent?.trim() || "",
        // icon 直接作为 icon span 的文本渲染，不需要写进容器属性
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-type='callout']" }];
  },

  renderHTML({ HTMLAttributes }: any) {
    // 注意：不要在此渲染独立的 icon <span>。callout 是 block+ 内容，游离的
    // emoji span 会在 HTML→JSON 回灌时被反复包装成 ✅ 段落（每次刷新多一个）。
    // 交互态图标由 CalloutNodeView（React）按需展示，静态序列化仅输出内容容器。
    return [
      "div",
      mergeAttributes({ "data-type": "callout" }, HTMLAttributes),
      ["div", { class: "prosemirror-callout-content" }, 0],
    ];
  },

  addCommands() {
    return {
      /**
       * 插入高亮块：有选区 → 把选区内容包进 callout；无选区 → 插入空 callout。
       * 选区内容非法（如纯文本片段）时降级为纯文本段落，避免结构校验失败。
       */
      insertCallout:
        (options?: { type?: CalloutType; icon?: string }) =>
        ({ chain, editor, tr, dispatch }: any) => {
          const { selection, schema } = editor.state;
          const hasSelection = !selection.empty;

          if (hasSelection) {
            const selectedSlice = selection.content();
            let calloutContent = selectedSlice.content;

            if (!this.type.validContent(calloutContent)) {
              const selectedText = editor.state.doc.textBetween(
                selection.from,
                selection.to,
                "\n",
              );
              calloutContent = schema.nodes.paragraph
                .create(null, selectedText ? schema.text(selectedText) : null)
                .content;
            }

            const calloutNode = this.type.create(options, calloutContent);
            tr.replaceSelectionWith(calloutNode, false).scrollIntoView();
            if (dispatch) dispatch(tr);
            return true;
          }

          return chain()
            .insertContent({
              type: this.name,
              attrs: options,
              content: [{ type: "paragraph", content: [] }],
            })
            .run();
        },
    };
  },

  addInputRules() {
    // 对齐语雀：输入 ::: 回车 → 默认蓝色高亮块；
    // :::blue / :::green / :::yellow / :::red 等回车 → 对应类型高亮块。
    const ruleFor = (keyword: string, calloutType: CalloutType) =>
      wrappingInputRule({
        find: new RegExp(`^:::${keyword} $`),
        type: this.type,
        getAttributes: () => ({ type: calloutType }),
      });
    return [
      wrappingInputRule({
        find: /^::: $/,
        type: this.type,
        getAttributes: () => ({ type: "blue" }),
      }),
      ruleFor("blue", "blue"),
      ruleFor("green", "green"),
      ruleFor("yellow", "yellow"),
      ruleFor("red", "red"),
      ruleFor("info", "blue"),
      ruleFor("warning", "yellow"),
      ruleFor("danger", "red"),
      ruleFor("success", "green"),
      ruleFor("tips", "cyan"),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // 空高亮块内回车：跳出到块后的新段落（避免连续在块内加空段落）
      Enter: ({ editor }: any) => {
        const { state, view } = editor;
        const { selection } = state;
        const { $from } = selection;
        const node = $from.node(-1); // 光标所在块

        if (node?.type.name === "callout") {
          if (node.content.size <= 2) {
            const pos = selection.from + 1; // 计算新段落插入的位置
            const tr = state.tr.insert(
              pos,
              state.schema.nodes.paragraph.create(),
            );
            tr.setSelection(
              state.selection.constructor.near(tr.doc.resolve(pos)),
            );
            view.dispatch(tr);
            return true;
          }
        }
        return false;
      },
    };
  },

  addNodeView() {
    // 交互式视图：左上角 emoji 可点击 → 弹出样式选择器（换色），
    // 内容区仍是可编辑的 ProseMirror 内容（NodeViewContent）。
    return ReactNodeViewRenderer(CalloutNodeView);
  },
});

export const CalloutExtension = Callout;
