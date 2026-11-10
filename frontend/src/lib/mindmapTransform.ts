import { aiMarkdownFrontmatter, markAiMarkdown, parseAiProvenance, readAiProvenance, stripAiProvenanceComments } from "./aiContentProvenance";
import type { MindMapData, MindMapNode } from "@/types";

const MAX_NODES = 80;
const MAX_DEPTH = 4;

/**
 * 清洗 Mermaid 源码：去掉围栏、多余空白
 */
export function cleanMermaidSource(source: string): string {
  return source
    .replace(/^```mermaid\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * 解析 Mermaid mindmap 为 MindMapData
 * 支持 root((text)) / root(text) / 普通节点
 * 仅支持 mindmap 类型
 */
export function parseMermaidMindmap(source: string): MindMapData {
  const cleaned = cleanMermaidSource(source);
  const lines = cleaned.split("\n").filter(l => l.trim());

  if (lines.length === 0 || !lines[0].trim().startsWith("mindmap")) {
    throw new Error("不是有效的 mindmap 格式");
  }

  let idCounter = 0;
  const newId = () => "node-" + (++idCounter);

  // 解析 root 行
  const rootIdx = lines.findIndex(l => l.trim().startsWith("root"));
  if (rootIdx < 0) throw new Error("缺少 root 节点");

  const rootText = lines[rootIdx].trim()
    .replace(/^root\(\(/, "").replace(/\)\)$/, "")
    .replace(/^root\(/, "").replace(/\)$/, "")
    .trim();

  const root: MindMapNode = { id: newId(), text: rootText || "中心主题", children: [] };

  // 基于缩进层级构建树
  const stack: { node: MindMapNode; indent: number; depth: number }[] = [{ node: root, indent: -1, depth: 0 }];

  for (let i = rootIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.search(/\S/);
    if (indent < 0) continue;

    const text = line.trim()
      .replace(/^\(\(/, "").replace(/\)\)$/, "")
      .replace(/^\(/, "").replace(/\)$/, "")
      .replace(/^[[]/, "").replace(/]$/, "")
      .replace(/^{{/, "").replace(/}}$/, "")
      .trim();
    if (!text) continue;

    // 找到父节点
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    const depth = parent.depth + 1;

    // 层级限制
    if (depth > MAX_DEPTH) continue;

    // 节点数限制
    if (idCounter >= MAX_NODES) break;

    const node: MindMapNode = { id: newId(), text, children: [] };
    parent.node.children.push(node);
    stack.push({ node, indent, depth });
  }

  return { root };
}

/**
 * 规范化 MindMapData：去空文本、截断过深层级
 */
export function normalizeMindMapData(data: MindMapData): MindMapData {
  function normalize(node: MindMapNode, depth: number): MindMapNode | null {
    if (!node.text?.trim()) return null;
    if (depth > MAX_DEPTH) return null;
    const children = (node.children || [])
      .map(c => normalize(c, depth + 1))
      .filter(Boolean) as MindMapNode[];
    return { ...node, children, text: node.text.trim().slice(0, 200) };
  }

  const root = normalize(data.root, 0);
  if (!root) throw new Error("思维导图数据无效");
  const aiProvenance = parseAiProvenance(data.aiProvenance);
  return { root, ...(aiProvenance ? { aiProvenance } : {}) };
}

/**
 * 确保所有节点有唯一 id
 */
export function assignMindMapNodeIds(data: MindMapData): MindMapData {
  let counter = 0;
  function assign(node: MindMapNode): MindMapNode {
    return {
      ...node,
      id: node.id || "node-" + (++counter),
      children: (node.children || []).map(assign),
    };
  }
  return { ...data, root: assign(data.root) };
}

/**
 * 将 Markdown 文本转换为 MindMapData
 * 规则:
 *   - 第一个 # 标题作为根节点
 *   - ## 标题作为第一级子节点
 *   - ### 标题作为第二级子节点
 *   - - 列表项按缩进层级展开
 *   - 非标题非列表的正文挂到最近的节点上
 */
export function markdownToMindMapData(markdown: string): MindMapData {
  const aiProvenance = readAiProvenance(markdown);
  const lines = stripAiProvenanceComments(markdown).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split("\n").filter(l => l.trim().length > 0 && !/^> (AI 生成内容|AI-generated content)\s*$/.test(l));
  let idCounter = 0;
  const newId = () => "node-" + (++idCounter);

  // 找到第一个标题作为根
  let root: MindMapNode | null = null;
  const stack: { node: MindMapNode; level: number }[] = [];

  function getLevel(line: string): { level: number; text: string } | null {
    // ATX headings: # / ## / ### / ...
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      return { level: headingMatch[1].length, text: headingMatch[2].trim() };
    }
    // List items: - / * / + with indentation
    const listMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      // Map indent to pseudo-level: 0 indent = 9, 2 indent = 10, etc.
      return { level: 9 + Math.floor(indent / 2), text: listMatch[2].trim() };
    }
    return null;
  }

  for (const line of lines) {
    const parsed = getLevel(line);
    if (!parsed) {
      // Plain text — append as child of current deepest node
      const text = line.replace(/^>\s*/, "").trim();
      if (!text || !stack.length) continue;
      if (idCounter >= MAX_NODES) break;
      const parent = stack[stack.length - 1].node;
      if (parent.children.length < 20) { // limit plain text children
        parent.children.push({ id: newId(), text: text.slice(0, 200), children: [] });
      }
      continue;
    }

    const { level, text } = parsed;
    if (!text) continue;

    const node: MindMapNode = { id: newId(), text: text.slice(0, 200), children: [] };

    if (!root) {
      root = node;
      stack.push({ node, level });
      continue;
    }

    // Pop stack until we find a parent with lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      // Top-level item without proper heading — add as child of root
      root.children.push(node);
      stack.push({ node, level });
    } else {
      const parent = stack[stack.length - 1].node;
      parent.children.push(node);
      stack.push({ node, level });
    }

    if (idCounter >= MAX_NODES) break;
  }

  if (!root) {
    throw new Error("无法从 Markdown 中提取思维导图内容");
  }

  return { root, ...(aiProvenance ? { aiProvenance } : {}) };
}

/**
 * 将 MindMapData 转换为 Markdown 文本
 * 根节点作为 # 标题，子节点按层级递增
 */
export function mindMapDataToMarkdown(data: MindMapData): string {
  const lines: string[] = [];

  function walk(node: MindMapNode, depth: number) {
    if (depth === 0) {
      lines.push("# " + node.text);
    } else if (depth <= 6) {
      lines.push("#".repeat(depth + 1) + " " + node.text);
    } else {
      // Beyond h6, use list items with indentation
      const indent = "  ".repeat(depth - 6);
      lines.push(indent + "- " + node.text);
    }
    if (node.note) {
      const indent = depth === 0 ? "" : "  ".repeat(Math.min(depth, 4));
      lines.push(indent + "> " + node.note);
    }
    for (const child of (node.children || [])) {
      walk(child, depth + 1);
    }
  }

  walk(data.root, 0);
  const markdown = lines.join("\n");
  const provenance = parseAiProvenance(data.aiProvenance);
  return provenance ? `---\n${aiMarkdownFrontmatter(provenance)}---\n${markAiMarkdown(markdown, provenance)}` : markdown;
}