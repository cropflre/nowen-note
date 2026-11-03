import { Mark, mergeAttributes } from "@tiptap/core";
import type TurndownService from "turndown";
import {
  AI_PROVENANCE_ATTRIBUTE,
  markAiMarkdown,
  parseAiProvenance,
  parseAiProvenanceJson,
} from "@/lib/aiContentProvenance";

/** Marks only the visible provenance label; normal paragraphs gain no attributes. */
export const AiProvenanceMark = Mark.create({
  name: "aiProvenance",
  inclusive: false,
  addAttributes() {
    return { aiProvenance: {
      default: null,
      parseHTML: element => parseAiProvenanceJson(element.getAttribute(AI_PROVENANCE_ATTRIBUTE)),
      renderHTML: attributes => {
        const provenance = parseAiProvenance(attributes.aiProvenance);
        return provenance ? { [AI_PROVENANCE_ATTRIBUTE]: JSON.stringify(provenance) } : {};
      },
    } };
  },
  parseHTML() {
    return [{ tag: `span[${AI_PROVENANCE_ATTRIBUTE}]`,
      getAttrs: element => parseAiProvenanceJson(element.getAttribute(AI_PROVENANCE_ATTRIBUTE)) ? {} : false }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
});

export function addAiProvenanceMarkdownRule(turndown: TurndownService): void {
  turndown.addRule("aiProvenance", {
    filter: node => node.nodeName === "SPAN" && !!parseAiProvenanceJson(node.getAttribute(AI_PROVENANCE_ATTRIBUTE)),
    replacement: (content, node) => {
      const provenance = parseAiProvenanceJson((node as Element).getAttribute(AI_PROVENANCE_ATTRIBUTE));
      return provenance ? `\n\n${markAiMarkdown("", provenance, (node.textContent || content).trim())}\n\n` : content;
    },
  });
}
