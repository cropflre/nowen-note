/**
 * The URL-import route stored HTML directly but omitted notes.contentFormat, so
 * SQLite assigned the 'tiptap-json' default. Only recognize that route's exact
 * source block, never arbitrary user-authored HTML or legitimate Tiptap JSON.
 */
export function isLegacyWeChatHtmlImport(
  content: string | null | undefined,
  contentFormat: string | null | undefined,
): boolean {
  if (contentFormat !== "tiptap-json" || !content) return false;
  const head = content.slice(0, 4096);
  if (!/^<blockquote><p>/i.test(head)) return false;
  return /来源：<a\b[^>]{0,600}\bhref=["']https:\/\/mp\.weixin\.qq\.com\/s(?:\/|\?)[^"']*["']/i.test(head);
}
