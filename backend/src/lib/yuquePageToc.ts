/**
 * 解析 Yuque 知识库页面 HTML 内嵌的目录数据（window.appData）。
 *
 * Yuque 网页端在知识库页面里以
 *   window.appData = JSON.parse(decodeURIComponent("..."));
 * 的形式内嵌整个目录结构（book.toc）。此处提取并过滤出文档条目，
 * 供导入流程列出某知识库下的所有文档。
 */

export interface YuqueTocDoc {
  id: number;
  uuid: string;
  title: string;
  url: string;
  parentUuid: string;
}

/** 从知识库页面 HTML 提取目录中的文档列表；解析失败返回空数组。 */
export function parseYuquePageToc(html: string): YuqueTocDoc[] {
  if (!html || typeof html !== "string") return [];
  const re = /window\.appData\s*=\s*JSON\.parse\(decodeURIComponent\("([^"]*)"\)\)/;
  const m = re.exec(html);
  if (!m) return [];

  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(decoded);
  } catch {
    return [];
  }
  const toc = (data as { book?: { toc?: unknown } })?.book?.toc;
  if (!Array.isArray(toc)) return [];

  const docs: YuqueTocDoc[] = [];
  for (const item of toc) {
    const node = item as {
      type?: string;
      id?: number;
      uuid?: string;
      title?: string;
      url?: string;
      parent_uuid?: string;
    };
    if (node?.type !== "DOC") continue;
    docs.push({
      id: node.id ?? 0,
      uuid: node.uuid ?? "",
      title: node.title ?? "",
      url: node.url ?? "",
      parentUuid: node.parent_uuid ?? "",
    });
  }
  return docs;
}
