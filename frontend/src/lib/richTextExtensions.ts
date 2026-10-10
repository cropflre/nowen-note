import { Extension } from "@tiptap/core";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { Emoji, type EmojiOptions } from "@tiptap/extension-emoji";
import type TurndownService from "turndown";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";

const CodeBlockTitle = Extension.create({
  name: "codeBlockTitle",
  addGlobalAttributes() {
    return [{ types: ["codeBlock"], attributes: { title: {
      default: null,
      parseHTML: (element) => element.getAttribute("data-title"),
      renderHTML: (attrs) => attrs.title ? { "data-title": attrs.title } : {},
    } } }];
  },
});

// Editor, schema repair, conversion and export must recognize the same nodes.
export function getRichTextExtensions(emojiOptions: Partial<EmojiOptions> = {}) {
  return [
    Details.configure({ persist: true, renderToggleButton: ({ element }) => {
      element.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6" /></svg>';
    } }), DetailsSummary, DetailsContent,
    ColumnsExtension, CalloutExtension, Emoji.configure(emojiOptions), CodeBlockTitle,
  ];
}

// Markdown has no equivalent for these containers. Keep safe HTML so switching
// editors and exporting/reimporting retain all nested blocks and attributes.
export function addRichTextMarkdownRules(td: TurndownService) {
  td.addRule("richTextContainers", {
    filter: (node) => node.nodeName === "DETAILS"
      || (node.nodeName === "DIV" && (node.getAttribute("data-type") === "callout"
        || node.classList.contains("prosemirror-column-container"))),
    replacement: (_content, node) => `\n\n${(node as HTMLElement).outerHTML}\n\n`,
  });
  td.addRule("richTextEmoji", {
    filter: (node) => node.getAttribute("data-type") === "emoji",
    replacement: (_content, node) => (node as HTMLElement).outerHTML,
  });
  td.addRule("namedCodeBlock", {
    filter: (node) => node.nodeName === "PRE" && !!node.getAttribute("data-title"),
    replacement: (_content, node) => `\n\n${(node as HTMLElement).outerHTML}\n\n`,
  });
}
