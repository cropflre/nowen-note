import type { NoteEditorHeading } from "@/components/editors/types";
import { projectMarkdownForUser } from "@/lib/markdownUserContent";

interface FenceState {
  marker: "`" | "~";
  size: number;
}

function isFenceClose(line: string, fence: FenceState): boolean {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^[\\t ]{0,3}${marker}{${fence.size},}[\\t ]*$`).test(line);
}

/**
 * 直接扫描整篇 Markdown 的 ATX 标题，避免 CodeMirror 增量语法树尚未解析到
 * 文档后半段时，大纲只显示当前已解析区域。
 */
function extractMarkdownHeadings(
  markdown: string | null | undefined,
  minLevel: number,
): NoteEditorHeading[] {
  const source = markdown || "";
  const headings: NoteEditorHeading[] = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let fence: FenceState | null = null;
  let offset = 0;

  while (true) {
    const match = linePattern.exec(source);
    if (!match) break;

    const line = match[1];
    const newline = match[2];

    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
    } else {
      const fenceStart = line.match(/^[\t ]{0,3}(`{3,}|~{3,})/);
      if (fenceStart) {
        fence = {
          marker: fenceStart[1][0] as "`" | "~",
          size: fenceStart[1].length,
        };
      } else {
        const heading = line.match(/^[\t ]{0,3}(#{1,6})(?:[\t ]+|$)(.*)$/);
        if (heading) {
          const level = heading[1].length;
          const text = projectMarkdownForUser(heading[2])
            .replace(/[\t ]+#{1,6}[\t ]*$/, "")
            .trim();
          if (level >= minLevel && text) {
            headings.push({
              id: `h-${offset}`,
              level,
              text,
              pos: offset,
            });
          }
        }
      }
    }

    offset += line.length + newline.length;
    if (!newline) break;
  }

  return headings;
}

/** 保留原有 H4-H6 提取接口，供深层标题能力和现有调用继续使用。 */
export function extractDeepMarkdownHeadings(
  markdown: string | null | undefined,
): NoteEditorHeading[] {
  return extractMarkdownHeadings(markdown, 4);
}

/** 合并编辑器已解析标题与整篇文档扫描结果，并按源码位置去重。 */
export function mergeMarkdownEditorHeadings(
  existing: NoteEditorHeading[],
  markdown: string | null | undefined,
): NoteEditorHeading[] {
  const merged = new Map<string, NoteEditorHeading>();
  for (const heading of existing) {
    const text = projectMarkdownForUser(heading.text).trim();
    if (text) merged.set(`${heading.pos}:${heading.level}`, { ...heading, text });
  }
  // CodeMirror 的语法树按视口增量解析；再次扫描整篇文档可补齐尚未解析的标题。
  for (const heading of extractMarkdownHeadings(markdown, 1)) {
    const key = `${heading.pos}:${heading.level}`;
    if (!merged.has(key)) merged.set(key, heading);
  }
  return Array.from(merged.values()).sort((a, b) => a.pos - b.pos);
}
