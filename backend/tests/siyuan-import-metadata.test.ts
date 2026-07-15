import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-meta-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "siyuan-meta-user";
const YOUTUBE_VIDEO_ID = "dQw4w9WgXcQ";
let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let importPackage: typeof import("../src/services/siyuanPackageImport").importSiyuanPackageFromZipFile;

type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
};

function flattenNodes(node: TiptapNode): TiptapNode[] {
  return [node, ...(node.content || []).flatMap((child) => flattenNodes(child))];
}

function doc(id: string, title: string, icon: string, children: any[] = []) {
  return {
    ID: id,
    Type: "NodeDocument",
    Properties: { id, title, icon, updated: "20260710090000" },
    Children: children,
  };
}

function decodeSvgIcon(icon: string): string {
  assert.match(icon, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(icon.slice(icon.indexOf(",") + 1), "base64").toString("utf8");
}

async function writeFixture(): Promise<string> {
  const zip = new JSZip();
  zip.file("data/box-a/.siyuan/conf.json", JSON.stringify({ name: "后排笔记本", sort: 20, icon: "1f4d5" }));
  zip.file("data/box-a/.siyuan/sort.json", JSON.stringify({ "doc-b": 10, "doc-a": 20 }));
  zip.file("data/box-b/.siyuan/conf.json", JSON.stringify({ name: "前排笔记本", sort: 10, icon: "iconfont/custom.svg" }));
  zip.file("data/box-b/.siyuan/sort.json", JSON.stringify({ "doc-html": 1 }));
  zip.file("data/emojis/iconfont/custom.svg", `
    <?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert('xss')">
      <script>alert('xss')</script>
      <a href="https://example.com/track"><path fill="#2563eb" d="M2 2h20v20H2z" /></a>
      <use href="#local-shape" />
    </svg>
  `);

  zip.file("data/box-a/doc-a.sy", JSON.stringify(doc("doc-a", "第二篇", "iconfont/custom.svg", [
    { Type: "NodeParagraph", Children: [{ Type: "NodeText", Data: "second" }] },
  ])));
  zip.file("data/box-a/doc-b.sy", JSON.stringify(doc("doc-b", "第一篇", "1f3af", [
    { Type: "NodeParagraph", Children: [{ Type: "NodeText", Data: "first" }] },
  ])));
  zip.file("data/box-b/doc-html.sy", JSON.stringify(doc("doc-html", "HTML 与嵌入", "1f9e9", [
    { Type: "NodeHTMLBlock", Data: "<mark>保留 HTML</mark><script>alert('xss')</script>" },
    { Type: "NodeIFrame", Data: `<iframe src="https://www.youtube.com/watch?v=${YOUTUBE_VIDEO_ID}"></iframe>` },
  ])));

  const output = path.join(tmpDir, "metadata.zip");
  fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer" }));
  return output;
}

test.before(async () => {
  const [schema, importer] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/siyuanPackageImport"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  importPackage = importer.importSiyuanPackageFromZipFile;
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
});

test.after(async () => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("preserves SiYuan notebook/document order, custom icons and HTML iframe fidelity", async () => {
  const zipPath = await writeFixture();
  const result = await importPackage(zipPath, {
    userId: USER_ID,
    workspaceId: null,
    contentFormat: "tiptap-json",
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.ok(Array.isArray(result.warnings));

  const notebooks = getDb().prepare(
    "SELECT name, icon, sortOrder FROM notebooks WHERE userId = ? AND parentId IS NULL ORDER BY sortOrder ASC",
  ).all(USER_ID) as Array<{ name: string; icon: string; sortOrder: number }>;
  assert.deepEqual(notebooks.map((item) => item.name), ["前排笔记本", "后排笔记本"]);
  assert.equal(notebooks[1].icon, "📕");
  assert.deepEqual(notebooks.map((item) => item.sortOrder), [0, 1024]);

  const notebookSvg = decodeSvgIcon(notebooks[0].icon);
  assert.match(notebookSvg, /<svg\b/);
  assert.match(notebookSvg, /fill="#2563eb"/);
  assert.match(notebookSvg, /href="#local-shape"/);
  assert.doesNotMatch(notebookSvg, /<script\b/i);
  assert.doesNotMatch(notebookSvg, /\sonload=/i);
  assert.doesNotMatch(notebookSvg, /https:\/\/example\.com/);

  const orderedNotes = getDb().prepare(`
    SELECT n.id, n.title, n.sortOrder, n.content, n.contentFormat, nb.name AS notebookName
    FROM notes n JOIN notebooks nb ON nb.id = n.notebookId
    WHERE n.userId = ?
    ORDER BY nb.sortOrder ASC, n.sortOrder ASC
  `).all(USER_ID) as Array<{
    id: string;
    title: string;
    sortOrder: number;
    content: string;
    contentFormat: string;
    notebookName: string;
  }>;

  const boxANotes = orderedNotes.filter((item) => item.notebookName === "后排笔记本");
  assert.deepEqual(boxANotes.map((item) => item.title), ["第一篇", "第二篇"]);
  assert.deepEqual(boxANotes.map((item) => item.sortOrder), [0, 1024]);

  const htmlNote = orderedNotes.find((item) => item.title === "HTML 与嵌入");
  assert.ok(htmlNote);
  assert.equal(htmlNote.contentFormat, "tiptap-json");

  const parsed = JSON.parse(htmlNote.content) as TiptapNode;
  const allNodes = flattenNodes(parsed);
  const htmlBlock = allNodes.find((node) => node.type === "codeBlock" && node.attrs?.language === "html");
  assert.ok(htmlBlock, "raw HTML must be represented as a non-executable HTML code block");
  assert.match(htmlBlock.content?.[0]?.text || "", /<mark>保留 HTML<\/mark>/);
  assert.match(htmlBlock.content?.[0]?.text || "", /<script>alert\('xss'\)<\/script>/);

  const video = allNodes.find((node) => node.type === "video");
  assert.ok(video, "supported YouTube iframe must become a video node");
  assert.equal(video.attrs?.platform, "youtube");
  assert.equal(video.attrs?.kind, "iframe");
  assert.equal(video.attrs?.src, `https://www.youtube-nocookie.com/embed/${YOUTUBE_VIDEO_ID}`);
  assert.equal(video.attrs?.originalUrl, `https://www.youtube.com/watch?v=${YOUTUBE_VIDEO_ID}`);

  const icons = getDb().prepare(`
    SELECT n.title, ni.icon
    FROM note_icons ni JOIN notes n ON n.id = ni.noteId
    WHERE n.userId = ?
    ORDER BY n.title
  `).all(USER_ID) as Array<{ title: string; icon: string }>;
  const iconMap = Object.fromEntries(icons.map((item) => [item.title, item.icon]));
  assert.equal(iconMap["第一篇"], "🎯");
  assert.equal(iconMap["HTML 与嵌入"], "🧩");
  assert.equal(decodeSvgIcon(iconMap["第二篇"]), notebookSvg);
});
