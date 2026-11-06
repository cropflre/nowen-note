/** In-band provenance follows the existing body transaction, encryption and sync.
 * It is a content declaration, not a signature or proof of authorship. */
export interface AiProvenance {
  Label: "1" | "2" | "3";
  ContentProducer: string;
  ProduceID: string;
  ReservedCode1: string;
  ContentPropagator: string;
  PropagateID: string;
  ReservedCode2: string;
}

const FIELDS = ["Label", "ContentProducer", "ProduceID", "ReservedCode1",
  "ContentPropagator", "PropagateID", "ReservedCode2"] as const;
export const AI_CONTENT_LABEL = "AI 生成内容";
export const AI_PROVENANCE_ATTRIBUTE = "data-nowen-aigc";

export function createAiProvenance(id: string = crypto.randomUUID()): AiProvenance {
  return { Label: "1", ContentProducer: "com.nowen.note", ProduceID: id, ReservedCode1: "",
    ContentPropagator: "com.nowen.note", PropagateID: id, ReservedCode2: "" };
}

export function parseAiProvenance(value: unknown): AiProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!["1", "2", "3"].includes(String(candidate.Label))
    || FIELDS.some(key => typeof candidate[key] !== "string" || (candidate[key] as string).length > 512)
    || ["ContentProducer", "ProduceID", "ContentPropagator", "PropagateID"].some(key => !candidate[key])) return null;
  return Object.fromEntries(FIELDS.map(key => [key, candidate[key]])) as unknown as AiProvenance;
}

export function parseAiProvenanceJson(value: string | null): AiProvenance | null {
  if (!value || value.length > 4096) return null;
  try { return parseAiProvenance(JSON.parse(value)); } catch { return null; }
}

export interface AiProvenanceComment { from: number; to: number; provenance: AiProvenance }

/** Only reserved, valid marker lines outside fenced code count as provenance. */
export function findAiProvenanceComments(markdown: string): AiProvenanceComment[] {
  if (!markdown.includes("<!-- nowen-aigc:")) return [];
  const ranges: AiProvenanceComment[] = [];
  let offset = 0, fence = "", fenceLength = 0;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (fence) {
      if (new RegExp(`^ {0,3}${fence}{${fenceLength},}\\s*$`).test(line)) fence = "";
    } else {
      const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opener) { fence = opener[1][0]; fenceLength = opener[1].length; }
      else {
        const marker = line.match(/^<!-- nowen-aigc:(\{.*\}) -->(?:[ \t]+\^blk_[0-9a-f-]{36})?[ \t]*$/);
        const provenance = marker && parseAiProvenanceJson(marker[1]);
        if (provenance) ranges.push({ from: offset, to: offset + rawLine.length, provenance });
      }
    }
    offset += rawLine.length + 1;
  }
  return ranges;
}

export function stripAiProvenanceComments(markdown: string): string {
  let output = markdown;
  for (const range of findAiProvenanceComments(markdown).reverse()) {
    output = output.slice(0, range.from) + output.slice(range.to);
  }
  return output;
}

export function readAiProvenance(content: string): AiProvenance | null {
  if (content.trimStart().startsWith("{")) {
    try {
      const root = JSON.parse(content);
      if (root.type === "doc") {
        const visit = (node: { attrs?: Record<string, unknown>; content?: unknown[]; marks?: unknown[] }): AiProvenance | null => {
          const own = parseAiProvenance(node.attrs?.aiProvenance);
          if (own) return own;
          for (const child of [...(node.content || []), ...(node.marks || [])]) {
            if (child && typeof child === "object") {
              const nested = visit(child);
              if (nested) return nested;
            }
          }
          return null;
        };
        return visit(root);
      }
    } catch { /* It may be ordinary Markdown beginning with a brace. */ }
  }
  return findAiProvenanceComments(content)[0]?.provenance ?? null;
}

export function markAiMarkdown(text: string, provenance = createAiProvenance(), label = AI_CONTENT_LABEL): string {
  const body = stripAiProvenanceComments(text).trim().replace(/^(?:> )?(?:AI 生成内容|AI-generated content)\s*\n\s*/, "");
  const safeJson = JSON.stringify(provenance).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `<!-- nowen-aigc:${safeJson} -->\n\n> ${label}\n\n${body}`;
}

export function aiClipboardText(text: string, isAi = true, label = AI_CONTENT_LABEL): string {
  if (!isAi) return text;
  const body = stripAiProvenanceComments(text).trim().replace(/^(?:> )?(?:AI 生成内容|AI-generated content)\s*\n\s*/, "");
  return `${label}\n\n${body}`;
}

/** Insert inside an existing YAML frontmatter block, before its closing delimiter. */
export function aiMarkdownFrontmatter(provenance: AiProvenance | null): string {
  return provenance ? `AIGC:\n${FIELDS.map(key => `  ${key}: ${JSON.stringify(provenance[key])}`).join("\n")}\n` : "";
}

export function aiProvenanceParagraph(provenance: AiProvenance, label = AI_CONTENT_LABEL) {
  return { type: "paragraph", content: [{ type: "text", text: label,
    marks: [{ type: "aiProvenance", attrs: { aiProvenance: provenance } }] }] };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Convert only our marker/label pair into a schema-preserved rich-text mark. */
export function aiMarkdownWithHtmlProvenance(markdown: string): string {
  let output = markdown;
  for (const range of findAiProvenanceComments(markdown).reverse()) {
    const following = markdown.slice(range.to);
    const label = following.match(/^\r?\n\s*\r?\n> (AI 生成内容|AI-generated content)(?:\r?\n|$)/);
    if (!label) continue;
    const html = `<p><span ${AI_PROVENANCE_ATTRIBUTE}="${escapeHtml(JSON.stringify(range.provenance))}">${escapeHtml(label[1])}</span></p>\n`;
    output = output.slice(0, range.from) + html + output.slice(range.to + label[0].length);
  }
  return output;
}

/** Prepend a declaration without trimming or rewriting the approved body. */
export function prependAiDeclaration(content: string, format: "markdown" | "tiptap-json", provenance: AiProvenance): string {
  if (format === "markdown") return markAiMarkdown("", provenance) + "\n\n" + content;
  const doc = JSON.parse(content);
  if (doc.type !== "doc" || !Array.isArray(doc.content)) throw new Error("UNSAFE_DOCUMENT");
  doc.content.unshift(aiProvenanceParagraph(provenance));
  return JSON.stringify(doc);
}

/** An AI title is explicitly declared in its own field, without reclassifying manual body text. */
export function readNoteAiProvenance(note: { id?: string; title?: string; content?: string }): AiProvenance | null {
  const body = readAiProvenance(note.content || "");
  if (body) return body;
  return note.id && /^(?:AI 生成标题：|AI-generated title: )/.test(note.title || "")
    ? createAiProvenance(`${note.id}:title`) : null;
}
