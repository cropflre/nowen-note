import { getBaseUrl } from "@/lib/api.impl";
import { registerAttachmentAccessUrls } from "@/lib/noteAttachmentAccessBridge";

const FOOTNOTE_DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const ATTACHMENT_PATH_RE = /\/api\/attachments\//i;
const ACCESS_REFRESH_TIMEOUT_MS = 4_000;

interface FootnoteDefinition {
  id: string;
  lines: string[];
}

interface FootnoteExtraction {
  body: string;
  definitions: FootnoteDefinition[];
}

interface AttachmentAccessPayload {
  urls?: Record<string, string>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFootnoteId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (char) => {
    const codePoint = char.codePointAt(0)?.toString(16) || "x";
    return `-${codePoint}-`;
  });
}

function toggleFence(
  line: string,
  current: { marker: string; length: number } | null,
): { marker: string; length: number } | null {
  const match = line.match(FENCE_RE);
  if (!match) return current;
  const run = match[1];
  const marker = run[0];
  if (!current) return { marker, length: run.length };
  if (current.marker === marker && run.length >= current.length) return null;
  return current;
}

function extractFootnoteDefinitions(markdown: string): FootnoteExtraction {
  const lines = markdown.split(/\r?\n/);
  const body: string[] = [];
  const definitions: FootnoteDefinition[] = [];
  const seen = new Set<string>();
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextFence = toggleFence(line, fence);
    if (nextFence !== fence || fence) {
      fence = nextFence;
      body.push(line);
      continue;
    }

    const match = line.match(FOOTNOTE_DEFINITION_RE);
    if (!match) {
      body.push(line);
      continue;
    }

    const id = match[1];
    const definitionLines = [match[2]];
    let cursor = index + 1;

    while (cursor < lines.length) {
      const continuation = lines[cursor];
      if (/^(?: {4}|\t)/.test(continuation)) {
        definitionLines.push(continuation.replace(/^(?: {4}|\t)/, ""));
        cursor += 1;
        continue;
      }
      if (
        continuation.trim() === ""
        && cursor + 1 < lines.length
        && /^(?: {4}|\t)/.test(lines[cursor + 1])
      ) {
        definitionLines.push("");
        cursor += 1;
        continue;
      }
      break;
    }

    if (!seen.has(id)) {
      definitions.push({ id, lines: definitionLines });
      seen.add(id);
    }
    index = cursor - 1;
  }

  return {
    body: body.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
    definitions,
  };
}

function replaceFootnoteReferences(
  markdown: string,
  numbering: Map<string, number>,
): { markdown: string; referenceIds: Map<string, string[]> } {
  const referenceIds = new Map<string, string[]>();
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; length: number } | null = null;

  const rendered = lines.map((line) => {
    const nextFence = toggleFence(line, fence);
    if (nextFence !== fence || fence) {
      fence = nextFence;
      return line;
    }

    const spans = line.split(/(`+[^`]*`+)/g);
    return spans.map((span, spanIndex) => {
      if (spanIndex % 2 === 1) return span;
      return span.replace(/(^|[^\\])\[\^([^\]\s]+)\]/g, (full, prefix: string, id: string) => {
        const number = numbering.get(id);
        if (!number) return full;
        const safeId = safeFootnoteId(id);
        const existing = referenceIds.get(id) || [];
        const occurrence = existing.length + 1;
        const referenceId = occurrence === 1 ? `fnref-${safeId}` : `fnref-${safeId}-${occurrence}`;
        existing.push(referenceId);
        referenceIds.set(id, existing);
        return `${prefix}<sup id="${referenceId}" data-footnote-ref style="font-size:.72em;line-height:0;vertical-align:super"><a href="#fn-${safeId}" style="color:#0969da;text-decoration:none;font-weight:600">${number}</a></sup>`;
      });
    }).join("");
  });

  return { markdown: rendered.join("\n"), referenceIds };
}

function renderFootnoteSection(
  definitions: FootnoteDefinition[],
  numbering: Map<string, number>,
  referenceIds: Map<string, string[]>,
): string {
  const items = definitions
    .filter((definition) => referenceIds.has(definition.id))
    .map((definition) => {
      const safeId = safeFootnoteId(definition.id);
      const text = definition.lines
        .map((line) => escapeHtml(line))
        .join("<br>");
      const backLinks = (referenceIds.get(definition.id) || [])
        .map((referenceId, index) => (
          `<a href="#${referenceId}" aria-label="返回脚注引用 ${numbering.get(definition.id)}${index ? `-${index + 1}` : ""}" style="margin-left:.35em;color:#0969da;text-decoration:none">↩</a>`
        ))
        .join("");
      return `<li id="fn-${safeId}" style="margin:7px 0;padding-left:2px"><p style="margin:0">${text}${backLinks}</p></li>`;
    })
    .join("");

  if (!items) return "";
  return `<section class="footnotes" data-footnotes style="margin-top:28px;padding-top:16px;border-top:1px solid #d0d7de;font-size:.92em;line-height:1.65"><div style="margin-bottom:8px;font-size:13px;font-weight:650;color:#6b7280">脚注</div><ol style="margin:0;padding-left:1.65em">${items}</ol></section>`;
}

/**
 * Convert Markdown footnote syntax into self-contained HTML before the image-only
 * Markdown renderer runs. The source note is never mutated.
 */
export function prepareMarkdownFootnotesForImageExport(markdown: string): string {
  if (!markdown || !markdown.includes("[^")) return markdown;
  const extracted = extractFootnoteDefinitions(markdown);
  if (extracted.definitions.length === 0) return markdown;

  const numbering = new Map(
    extracted.definitions.map((definition, index) => [definition.id, index + 1]),
  );
  const replaced = replaceFootnoteReferences(extracted.body, numbering);
  const section = renderFootnoteSection(extracted.definitions, numbering, replaced.referenceIds);
  if (!section) return markdown;
  return `${replaced.markdown.trimEnd()}\n\n${section}`;
}

export function isMarkdownImageExportSource(content: string, contentFormat?: string): boolean {
  const format = String(contentFormat || "").toLowerCase();
  if (format === "markdown" || format === "md") return true;
  if (format === "html" || format === "tiptap-json" || format === "tiptap") return false;

  const trimmed = String(content || "").trimStart();
  if (!trimmed) return true;
  if (trimmed.startsWith("<") && /^<[A-Za-z!]/.test(trimmed)) return false;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && (parsed.type === "doc" || Array.isArray(parsed.content))) {
        return false;
      }
    } catch {
      // A Markdown document may legitimately start with `{`.
    }
  }
  return true;
}

/**
 * Refresh short-lived attachment URLs before the image renderer tries to inline images.
 * This is essential for Docker/NAS deployments where bare attachment UUIDs are no longer
 * public capabilities and reverse proxies may expose a different origin from the container.
 */
export async function refreshNoteImageAttachmentAccess(
  noteId: string,
  content = "",
): Promise<number> {
  if (
    typeof window === "undefined"
    || typeof fetch !== "function"
    || !noteId
    || !ATTACHMENT_PATH_RE.test(content)
  ) {
    return 0;
  }

  const token = localStorage.getItem("nowen-token") || "";
  if (!token) return 0;

  const requestUrl = `${getBaseUrl()}/attachments/access/urls?noteId=${encodeURIComponent(noteId)}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ACCESS_REFRESH_TIMEOUT_MS);

  try {
    const response = await fetch(requestUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return 0;
    const payload = await response.json() as AttachmentAccessPayload;
    return registerAttachmentAccessUrls(payload.urls, requestUrl);
  } catch (error) {
    console.warn("[noteImageExport] failed to refresh attachment access URLs", error);
    return 0;
  } finally {
    window.clearTimeout(timer);
  }
}
