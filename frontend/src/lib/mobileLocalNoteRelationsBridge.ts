import { api } from "./api";
import type { NativeDatabase } from "./nativeDatabase";

type LocalNoteRow = {
  id: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  updatedAt: string;
};

type LocalBlock = {
  noteId: string;
  blockId: string;
  blockType: "heading" | "paragraph" | "listItem" | "taskItem" | "blockquote" | "codeBlock";
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  path: string;
  startOffset: number | null;
  endOffset: number | null;
  headingLevel?: number;
};

type LocalLink = {
  targetNoteId: string;
  targetBlockId: string | null;
  sourceBlockId: string | null;
  linkType: "note" | "block";
  linkText: string | null;
  excerpt: string | null;
};

const SUPPORTED_BLOCKS = new Set<LocalBlock["blockType"]>([
  "heading", "paragraph", "listItem", "taskItem", "blockquote", "codeBlock",
]);
const MARKDOWN_BLOCK_ID_RE = /(?:\s+|^)\^(blk_[A-Za-z0-9_-]{6,})\s*$/;
const WIKI_LINK_RE = /\[\[note:([A-Za-z0-9_-]{6,})(?:#blk:([A-Za-z0-9_-]+))?(?:\|([^\]]*))?\]\]/g;
const NOTE_HREF_RE = /note:([A-Za-z0-9_-]{6,})(?:#blk:([A-Za-z0-9_-]+))?/g;

function plainText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.text || "");
  if (!Array.isArray(node.content)) return "";
  return node.content.map(plainText).join("");
}

function safeExcerpt(value: string): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : null;
}

function parseTiptapBlocks(note: LocalNoteRow): LocalBlock[] | null {
  try {
    const document = JSON.parse(note.content || "{}");
    if (!document || !Array.isArray(document.content)) return null;
    const blocks: LocalBlock[] = [];
    let order = 0;
    const visit = (nodes: any[], parentBlockId: string | null, path: string) => {
      nodes.forEach((node, index) => {
        if (!node || typeof node !== "object") return;
        const nodePath = `${path}/${index}`;
        const type = SUPPORTED_BLOCKS.has(node.type) ? node.type as LocalBlock["blockType"] : null;
        const blockId = type && typeof node.attrs?.blockId === "string" ? node.attrs.blockId : null;
        if (type && blockId) {
          blocks.push({
            noteId: note.id,
            blockId,
            blockType: type,
            parentBlockId,
            blockOrder: order++,
            plainText: plainText(node).trim(),
            path: nodePath,
            startOffset: null,
            endOffset: null,
            ...(type === "heading" ? { headingLevel: Number(node.attrs?.level) || 1 } : {}),
          });
        }
        if (Array.isArray(node.content)) visit(node.content, blockId || parentBlockId, nodePath);
      });
    };
    visit(document.content, null, "doc");
    return blocks;
  } catch {
    return null;
  }
}

function markdownBlockType(line: string): LocalBlock["blockType"] {
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return "heading";
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return "taskItem";
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return "listItem";
  if (/^\s{0,3}>\s?/.test(line)) return "blockquote";
  if (/^\s*(```+|~~~+)/.test(line)) return "codeBlock";
  return "paragraph";
}

function parseMarkdownBlocks(note: LocalNoteRow): LocalBlock[] {
  const lines = (note.content || "").split("\n");
  const blocks: LocalBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const directId = raw.match(MARKDOWN_BLOCK_ID_RE)?.[1] || null;
    const nextId = lines[index + 1]?.trim().match(/^\^(blk_[A-Za-z0-9_-]{6,})$/)?.[1] || null;
    const blockId = directId || nextId;
    if (!blockId) continue;
    const type = markdownBlockType(raw);
    const heading = raw.match(/^\s{0,3}(#{1,6})\s+(.+)/);
    const cleaned = raw.replace(MARKDOWN_BLOCK_ID_RE, "").trim();
    blocks.push({
      noteId: note.id,
      blockId,
      blockType: type,
      parentBlockId: null,
      blockOrder: blocks.length,
      plainText: heading ? heading[2].replace(MARKDOWN_BLOCK_ID_RE, "").trim() : cleaned,
      path: `line:${index + 1}`,
      startOffset: null,
      endOffset: null,
      ...(heading ? { headingLevel: heading[1].length } : {}),
    });
    if (nextId) index += 1;
  }
  return blocks;
}

function parseBlocks(note: LocalNoteRow): LocalBlock[] {
  return parseTiptapBlocks(note) ?? parseMarkdownBlocks(note);
}

function extractLinks(note: LocalNoteRow): LocalLink[] {
  const raw = note.content || "";
  const excerpt = safeExcerpt(note.contentText || raw.replace(/[{}\[\]"]/g, " "));
  const links: LocalLink[] = [];
  const seen = new Set<string>();
  const add = (targetNoteId: string, targetBlockId: string | null, linkText: string | null) => {
    const key = `${targetNoteId}:${targetBlockId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      targetNoteId,
      targetBlockId,
      sourceBlockId: null,
      linkType: targetBlockId ? "block" : "note",
      linkText,
      excerpt,
    });
  };
  for (const match of raw.matchAll(WIKI_LINK_RE)) add(match[1], match[2] || null, match[3] || null);
  for (const match of raw.matchAll(NOTE_HREF_RE)) add(match[1], match[2] || null, null);
  return links;
}

async function readNote(db: NativeDatabase, id: string): Promise<LocalNoteRow> {
  const row = (await db.query<LocalNoteRow>(`SELECT id,notebookId,title,content,contentText,contentFormat,updatedAt
    FROM notes WHERE scopeKey='personal' AND id=? LIMIT 1`, [id]))[0];
  if (!row) throw new Error("笔记不存在");
  return row;
}

async function listNotes(db: NativeDatabase): Promise<LocalNoteRow[]> {
  return db.query<LocalNoteRow>(`SELECT id,notebookId,title,content,contentText,contentFormat,updatedAt
    FROM notes WHERE scopeKey='personal' AND isTrashed=0 ORDER BY updatedAt DESC`);
}

/**
 * Android 设备本地模式的块索引 / 反链 / 关系图门面。
 *
 * 服务端版本会维护 note_blocks / note_links 派生表；Native DB 当前没有这些派生表，
 * 因此离线时直接从本地权威 notes.content 计算。这样派生数据不会成为第二份真相，
 * 也不会为了打开编辑器侧栏而请求服务器。
 */
export function installMobileLocalNoteRelationsBridge(db: NativeDatabase): () => void {
  const target = api as any;
  const originals = {
    getNoteHeadings: target.getNoteHeadings,
    getNoteBlocks: target.getNoteBlocks,
    getBlock: target.getBlock,
    resolveNoteLink: target.resolveNoteLink,
    getBlockBacklinks: target.getBlockBacklinks,
    getKnowledgeGraph: target.getKnowledgeGraph,
    getBacklinks: target.getBacklinks,
    releaseYjsRoom: target.releaseYjsRoom,
  };

  target.getNoteBlocks = async (id: string, limit = 500) => {
    const note = await readNote(db,id);
    return { noteId:id,blocks:parseBlocks(note).slice(0,Math.max(1,limit)) };
  };
  target.getNoteHeadings = async (id: string) => {
    const { blocks } = await target.getNoteBlocks(id,2_000);
    return {
      headings: (blocks as LocalBlock[])
        .filter((block) => block.blockType === "heading")
        .map((block) => ({
          blockId:block.blockId,
          level:block.headingLevel || 1,
          text:block.plainText,
          order:block.blockOrder,
        })),
    };
  };
  target.getBlock = async (noteId: string, blockId: string) => {
    const { blocks } = await target.getNoteBlocks(noteId,5_000);
    const block = (blocks as LocalBlock[]).find((item) => item.blockId === blockId);
    if (!block) throw new Error("块不存在");
    return block;
  };
  target.resolveNoteLink = async (link: string) => {
    const match = link.match(/^note:([A-Za-z0-9_-]{6,})(?:#blk:([A-Za-z0-9_-]+))?/);
    if (!match) throw new Error("无效的笔记链接");
    const note = await readNote(db,match[1]);
    const block = match[2] ? await target.getBlock(note.id,match[2]) : null;
    return {
      noteId:note.id,
      notebookId:note.notebookId,
      title:note.title,
      blockId:match[2] || null,
      block,
    };
  };

  const backlinkRows = async (targetNoteId: string, targetBlockId?: string) => {
    const notes = await listNotes(db);
    const rows: Array<Record<string, unknown>> = [];
    for (const note of notes) {
      if (note.id === targetNoteId && !targetBlockId) continue;
      for (const link of extractLinks(note)) {
        if (link.targetNoteId !== targetNoteId) continue;
        if (targetBlockId && link.targetBlockId !== targetBlockId) continue;
        rows.push({
          sourceNoteId:note.id,
          sourceBlockId:link.sourceBlockId,
          sourceNotebookId:note.notebookId,
          title:note.title,
          updatedAt:note.updatedAt,
          linkText:link.linkText,
          linkType:link.linkType,
          targetBlockId:link.targetBlockId,
          excerpt:link.excerpt,
        });
      }
    }
    return rows;
  };

  target.getBacklinks = async (noteId: string, limit = 50) => ({
    backlinks:(await backlinkRows(noteId)).slice(0,Math.max(1,limit)),
  });
  target.getBlockBacklinks = async (noteId: string, blockId: string) => ({
    backlinks:await backlinkRows(noteId,blockId),
  });
  target.getKnowledgeGraph = async (focusNoteId?: string) => {
    const notes = await listNotes(db);
    const noteMap = new Map(notes.map((note) => [note.id,note]));
    let edges = notes.flatMap((note) => extractLinks(note)
      .filter((link) => noteMap.has(link.targetNoteId))
      .map((link) => ({
        sourceNoteId:note.id,
        targetNoteId:link.targetNoteId,
        sourceBlockId:link.sourceBlockId,
        targetBlockId:link.targetBlockId,
        linkType:link.linkType,
      })));
    if (focusNoteId) {
      edges = edges.filter((edge) => edge.sourceNoteId === focusNoteId || edge.targetNoteId === focusNoteId);
    }
    const visible = focusNoteId
      ? new Set([focusNoteId,...edges.flatMap((edge) => [edge.sourceNoteId,edge.targetNoteId])])
      : new Set(notes.map((note) => note.id));
    return {
      nodes:notes.filter((note) => visible.has(note.id)).map((note) => ({
        id:note.id,title:note.title,notebookId:note.notebookId,
      })),
      edges,
    };
  };

  // 本地模式没有服务端 Yjs 房间。模式切换时把“释放房间”视为已完成，
  // 避免一次无意义的 POST /notes/:id/yjs/release-room。
  target.releaseYjsRoom = async () => ({ success:true });

  return () => {
    Object.assign(target,originals);
  };
}
