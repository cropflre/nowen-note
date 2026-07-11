import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-tiptap-fidelity-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "siyuan-tiptap-fidelity-user";
const WORKSPACE_ID = "siyuan-tiptap-fidelity-workspace";
const TARGET_NOTEBOOK_ID = "siyuan-tiptap-fidelity-notebook";

let closeDb: () => void;
let getDb: () => import("better-sqlite3").Database;
let importSiyuanPackageFromZipFile: typeof import("../src/services/siyuanPackageImport").importSiyuanPackageFromZipFile;

type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

function syDoc(id: string, title: string, children: any[] = []) {
  return {
    ID: id,
    Type: "NodeDocument",
    Properties: { title },
    updated: "20260102030405",
    Children: children,
  };
}

function heading(level: number, children: any[]) {
  return { Type: "NodeHeading", HeadingLevel: String(level), Children: children };
}

function paragraph(children: any[]) {
  return { Type: "NodeParagraph", Children: children };
}

function text(value: string) {
  return { Type: "NodeText", Data: value };
}

function textMark(type: string, value: string, attrs: Record<string, string> = {}) {
  return {
    Type: "NodeTextMark",
    TextMarkType: type,
    TextMarkTextContent: value,
    ...attrs,
  };
}

function hardBreak() {
  return { Type: "NodeBr" };
}

function list(ordered: boolean, items: any[]) {
  return {
    Type: "NodeList",
    SubType: ordered ? "ordered" : "bullet",
    Children: items,
  };
}

function listItem(children: any[], checked?: boolean) {
  return {
    Type: "NodeListItem",
    TaskChecked: checked === undefined ? undefined : String(checked),
    Children: checked === undefined
      ? children
      : [{ Type: "NodeTaskListItemMarker", Data: checked ? "[x]" : "[ ]" }, ...children],
  };
}

function blockquote(children: any[]) {
  return { Type: "NodeBlockquote", Children: children };
}

function codeBlock(language: string, code: string) {
  return { Type: "NodeCodeBlock", CodeBlockInfo: language, CodeBlockCode: code };
}

function horizontalRule() {
  return { Type: "NodeThematicBreak" };
}

function image(src: string, alt = "图片") {
  return {
    Type: "NodeImage",
    Children: [
      { Type: "NodeLinkText", Data: alt },
      { Type: "NodeLinkDest", Data: src },
    ],
  };
}

function video(src: string) {
  return { Type: "NodeVideo", Data: `<video src="${src}"></video>` };
}

function audio(src: string) {
  return { Type: "NodeAudio", Data: `<audio src="${src}"></audio>` };
}

function iframe(src: string) {
  return { Type: "NodeIFrame", Data: `<iframe src="${src}"></iframe>` };
}

function widget(src: string) {
  return { Type: "NodeWidget", Data: `<iframe src="${src}"></iframe>` };
}

function mathBlock(latex: string) {
  return {
    Type: "NodeMathBlock",
    Children: [{ Type: "NodeMathBlockContent", Data: latex }],
  };
}

function callout(type: string, title: string, children: any[]) {
  return {
    Type: "NodeCallout",
    CalloutType: type,
    CalloutTitle: title,
    Children: children,
  };
}

function htmlBlock(raw: string) {
  return { Type: "NodeHTMLBlock", Data: raw };
}

function table(rows: any[][]) {
  return {
    Type: "NodeTable",
    Children: rows.map((cells) => ({
      Type: "NodeTableRow",
      Children: cells.map((cell) => ({
        Type: "NodeTableCell",
        Children: [paragraph(Array.isArray(cell) ? cell : [text(String(cell))])],
      })),
    })),
  };
}

async function writeZip(name: string, files: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content);
  }
  const zipPath = path.join(tmpDir, name);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  return zipPath;
}

function db() {
  return getDb();
}

function seedBaseData() {
  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db()
    .prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(WORKSPACE_ID, "思源保真测试工作区", USER_ID);
  db()
    .prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(WORKSPACE_ID, USER_ID, "editor");
  db()
    .prepare("INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId) VALUES (?, ?, NULL, ?, ?, ?)")
    .run(TARGET_NOTEBOOK_ID, USER_ID, "指定导入", "📥", WORKSPACE_ID);
}

function getNoteByTitle(title: string) {
  return db()
    .prepare("SELECT id, title, content, contentFormat FROM notes WHERE title = ?")
    .get(title) as { id: string; title: string; content: string; contentFormat: string } | undefined;
}

function flattenNodes(node: TiptapNode): TiptapNode[] {
  return [node, ...(node.content || []).flatMap((child) => flattenNodes(child))];
}

function textNodeWithMark(doc: TiptapNode, textValue: string, markType: string) {
  return flattenNodes(doc).find(
    (node) => node.type === "text" && node.text === textValue && node.marks?.some((mark) => mark.type === markType),
  );
}

test.before(async () => {
  const [serviceModule, schemaModule] = await Promise.all([
    import("../src/services/siyuanPackageImport"),
    import("../src/db/schema"),
  ]);
  importSiyuanPackageFromZipFile = serviceModule.importSiyuanPackageFromZipFile;
  closeDb = schemaModule.closeDb;
  getDb = schemaModule.getDb;
  seedBaseData();
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY" && err?.code !== "ENOTEMPTY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("Rich Text import builds P0 Tiptap nodes and marks from Siyuan AST", async () => {
  const zipPath = await writeZip("p0-fidelity.zip", {
    "doc.sy": JSON.stringify(syDoc("doc", "P0 保真", [
      heading(1, [text("一级标题")]),
      heading(4, [text("四级标题")]),
      paragraph([
        text("普通"),
        hardBreak(),
        textMark("strong", "加粗"),
        text(" "),
        textMark("em", "斜体"),
        text(" "),
        textMark("s", "删除线"),
        text(" "),
        textMark("code", "inlineCode"),
        text(" "),
        textMark("u", "下划线"),
        text(" "),
        textMark("mark", "高亮"),
        text(" "),
        textMark("a", "链接", { TextMarkAHref: "https://example.com" }),
      ]),
      list(false, [
        listItem([paragraph([text("无序一")])]),
        listItem([paragraph([text("无序二")])]),
      ]),
      list(true, [
        listItem([paragraph([text("有序一")])]),
        listItem([paragraph([text("有序二")])]),
      ]),
      list(false, [
        listItem([paragraph([text("任务完成")])], true),
        listItem([paragraph([text("任务待办")])], false),
      ]),
      blockquote([paragraph([text("引用内容")])]),
      codeBlock("ts", "const answer = 42;"),
      horizontalRule(),
      paragraph([image("assets/pic.png", "配图")]),
      paragraph([video("assets/demo.mp4")]),
      paragraph([image("assets/missing.png", "缺失图")]),
      { Type: "NodeAttributeView" },
    ])),
    "assets/pic.png": new Uint8Array([1, 2, 3]),
    "assets/demo.mp4": new Uint8Array([4, 5, 6, 7]),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: TARGET_NOTEBOOK_ID,
    contentFormat: "tiptap-json",
  });

  assert.equal(result.success, true);
  assert.equal(result.stats.importedAssets, 2);
  assert.equal(result.stats.unresolvedAssets, 1);
  assert.equal(result.stats.unsupportedNodes.NodeAttributeView, 1);
  assert.ok(result.warnings.some((item) => item.includes("Siyuan asset not found: assets/missing.png")));
  assert.ok(result.warnings.some((item) => item.includes("attribute view")));

  const note = getNoteByTitle("P0 保真");
  assert.ok(note);
  assert.equal(note.contentFormat, "tiptap-json");
  assert.doesNotMatch(note.content, /!\[[^\]]*]\(/);
  assert.doesNotMatch(note.content, /@\[video]\(/);

  const parsed = JSON.parse(note.content) as TiptapNode;
  assert.equal(parsed.type, "doc");
  assert.ok(Array.isArray(parsed.content));

  const headings = parsed.content!.filter((node) => node.type === "heading");
  assert.deepEqual(headings.map((node) => node.attrs?.level), [1, 3]);
  assert.equal(headings[0].content?.[0].text, "一级标题");
  assert.equal(headings[1].content?.[0].text, "四级标题");

  assert.ok(flattenNodes(parsed).some((node) => node.type === "hardBreak"));
  assert.ok(textNodeWithMark(parsed, "加粗", "bold"));
  assert.ok(textNodeWithMark(parsed, "斜体", "italic"));
  assert.ok(textNodeWithMark(parsed, "删除线", "strike"));
  assert.ok(textNodeWithMark(parsed, "inlineCode", "code"));
  assert.ok(textNodeWithMark(parsed, "下划线", "underline"));
  assert.ok(textNodeWithMark(parsed, "高亮", "highlight"));
  assert.equal(textNodeWithMark(parsed, "链接", "link")?.marks?.[0].attrs?.href, "https://example.com");

  assert.ok(parsed.content!.some((node) => node.type === "bulletList"));
  assert.ok(parsed.content!.some((node) => node.type === "orderedList"));
  const taskList = parsed.content!.find((node) => node.type === "taskList");
  assert.ok(taskList);
  assert.deepEqual(taskList.content?.map((node) => node.attrs?.checked), [true, false]);
  assert.ok(parsed.content!.some((node) => node.type === "blockquote"));
  assert.ok(parsed.content!.some((node) => node.type === "codeBlock" && node.attrs?.language === "ts"));
  assert.ok(parsed.content!.some((node) => node.type === "horizontalRule"));

  const imageNode = parsed.content!.find((node) => node.type === "image");
  const videoNode = parsed.content!.find((node) => node.type === "video");
  assert.match(String(imageNode?.attrs?.src), /^\/api\/attachments\//);
  assert.match(String(videoNode?.attrs?.src), /^\/api\/attachments\//);

  const referenceCount = db()
    .prepare("SELECT COUNT(*) AS count FROM attachment_references WHERE noteId = ?")
    .get(note.id) as { count: number };
  assert.equal(referenceCount.count, 2);
});

test("Rich Text import converts Siyuan tables to supported Tiptap table nodes", async () => {
  const zipPath = await writeZip("table-fidelity.zip", {
    "table.sy": JSON.stringify(syDoc("table-doc", "表格保真", [
      table([
        ["姓名", "状态"],
        [[text("张三")], [textMark("strong", "完成")]],
        ["李四", "待办"],
      ]),
    ])),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: TARGET_NOTEBOOK_ID,
    contentFormat: "tiptap-json",
  });

  assert.equal(result.success, true);
  assert.equal(result.stats.importedAssets, 0);
  assert.equal(result.stats.unresolvedAssets, 0);

  const note = getNoteByTitle("表格保真");
  assert.ok(note);
  assert.equal(note.contentFormat, "tiptap-json");

  const parsed = JSON.parse(note.content) as TiptapNode;
  assert.equal(parsed.type, "doc");
  const tableNode = parsed.content?.find((node) => node.type === "table");
  assert.ok(tableNode);
  assert.deepEqual(tableNode.content?.map((node) => node.type), ["tableRow", "tableRow", "tableRow"]);

  const headerRow = tableNode.content![0];
  assert.deepEqual(headerRow.content?.map((node) => node.type), ["tableHeader", "tableHeader"]);
  assert.equal(headerRow.content?.[0].content?.[0].content?.[0].text, "姓名");
  assert.equal(headerRow.content?.[1].content?.[0].content?.[0].text, "状态");

  const bodyRow = tableNode.content![1];
  assert.deepEqual(bodyRow.content?.map((node) => node.type), ["tableCell", "tableCell"]);
  assert.equal(bodyRow.content?.[0].content?.[0].content?.[0].text, "张三");
  assert.ok(
    bodyRow.content?.[1].content?.[0].content?.[0].marks?.some((mark) => mark.type === "bold"),
  );

  assert.equal(tableNode.content![2].content?.[1].content?.[0].content?.[0].text, "待办");
  assert.ok(!flattenNodes(parsed).some((node) => node.type === "paragraph" && node.text?.includes("|")));
});

test("Rich Text import safely preserves advanced Siyuan nodes without unknown schema", async () => {
  const zipPath = await writeZip("advanced-fidelity.zip", {
    "advanced.sy": JSON.stringify(syDoc("advanced-doc", "高级节点保真", [
      paragraph([
        text("行内公式 "),
        textMark("inline-math", "a^2+b^2=c^2"),
      ]),
      mathBlock("\\int_0^1 x^2 dx"),
      callout("warning", "注意事项", [
        paragraph([text("这里是提醒内容")]),
      ]),
      codeBlock("mermaid", "flowchart TD\n  A-->B"),
      htmlBlock('<pre><code class="language-mermaid">sequenceDiagram\n  A->>B: hi</code></pre>'),
      paragraph([audio("assets/sound.mp3")]),
      paragraph([iframe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")]),
      paragraph([iframe("https://example.com/forms/embed")]),
      paragraph([widget("https://example.com/widget")]),
    ])),
    "assets/sound.mp3": new Uint8Array([1, 2, 3, 4]),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: TARGET_NOTEBOOK_ID,
    contentFormat: "tiptap-json",
  });

  assert.equal(result.success, true);
  assert.equal(result.stats.importedAssets, 1);
  assert.equal(result.stats.unsupportedNodes.NodeAudio, 1);
  assert.equal(result.stats.unsupportedNodes.NodeIFrame, 2);
  assert.equal(result.stats.unsupportedNodes.NodeWidget, 1);
  assert.equal(result.stats.unsupportedNodes.NodeCallout, 1);
  assert.ok(result.warnings.some((item) => item.includes("audio") && item.includes("link")));
  assert.ok(result.warnings.some((item) => item.includes("iframe") && item.includes("downgraded")));
  assert.ok(result.warnings.some((item) => item.includes("callout") && item.includes("blockquote")));
  assert.ok(result.warnings.some((item) => item.includes("widget") && item.includes("link")));

  const note = getNoteByTitle("高级节点保真");
  assert.ok(note);
  assert.equal(note.contentFormat, "tiptap-json");

  const parsed = JSON.parse(note.content) as TiptapNode;
  assert.equal(parsed.type, "doc");
  const allNodes = flattenNodes(parsed);
  const nodeTypes = new Set(allNodes.map((node) => node.type));
  for (const unknown of ["audio", "iframe", "callout", "embed", "mermaid"]) {
    assert.equal(nodeTypes.has(unknown), false);
  }

  assert.ok(allNodes.some((node) => node.type === "mathInline" && node.attrs?.latex === "a^2+b^2=c^2"));
  assert.ok(allNodes.some((node) => node.type === "mathBlock" && node.attrs?.latex === "\\int_0^1 x^2 dx"));

  const calloutNode = parsed.content?.find((node) => node.type === "blockquote");
  assert.ok(calloutNode);
  assert.equal(calloutNode.content?.[0].content?.[0].text, "[!WARNING] 注意事项");
  assert.equal(calloutNode.content?.[1].content?.[0].text, "这里是提醒内容");

  const mermaidBlocks = parsed.content?.filter((node) => node.type === "codeBlock" && node.attrs?.language === "mermaid") || [];
  assert.equal(mermaidBlocks.length, 2);
  assert.ok(mermaidBlocks.some((node) => node.content?.[0].text?.includes("flowchart TD")));
  assert.ok(mermaidBlocks.some((node) => node.content?.[0].text?.includes("sequenceDiagram")));

  const audioLink = allNodes.find((node) =>
    node.type === "text" &&
    node.text === "音频附件" &&
    node.marks?.some((mark) => mark.type === "link" && /^\/api\/attachments\//.test(String(mark.attrs?.href))),
  );
  assert.ok(audioLink);

  const videos = parsed.content?.filter((node) => node.type === "video") || [];
  assert.equal(videos.length, 1);
  assert.equal(videos[0].attrs?.platform, "youtube");
  assert.equal(videos[0].attrs?.kind, "iframe");
  assert.match(String(videos[0].attrs?.src), /^https:\/\/www\.youtube-nocookie\.com\/embed\//);

  const degradedIframe = allNodes.find((node) =>
    node.type === "text" &&
    node.text === "嵌入内容" &&
    node.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === "https://example.com/forms/embed"),
  );
  assert.ok(degradedIframe);

  const widgetLink = allNodes.find((node) =>
    node.type === "text" &&
    node.text === "挂件内容" &&
    node.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === "https://example.com/widget"),
  );
  assert.ok(widgetLink);

  const referenceCount = db()
    .prepare("SELECT COUNT(*) AS count FROM attachment_references WHERE noteId = ?")
    .get(note.id) as { count: number };
  assert.equal(referenceCount.count, 1);
});

test("Markdown import keeps advanced Siyuan nodes on the markdown path", async () => {
  const zipPath = await writeZip("advanced-markdown.zip", {
    "advanced-md.sy": JSON.stringify(syDoc("advanced-md-doc", "高级节点 Markdown", [
      paragraph([text("行内公式 "), textMark("inline-math", "x+y")]),
      mathBlock("E=mc^2"),
      callout("note", "备注", [paragraph([text("保留为引用")])]),
      codeBlock("mermaid", "graph LR\n  A-->B"),
      paragraph([audio("assets/sound-md.mp3")]),
    ])),
    "assets/sound-md.mp3": new Uint8Array([9, 8, 7, 6]),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: TARGET_NOTEBOOK_ID,
    contentFormat: "markdown",
  });

  assert.equal(result.success, true);
  const note = getNoteByTitle("高级节点 Markdown");
  assert.ok(note);
  assert.equal(note.contentFormat, "markdown");
  assert.match(note.content, /\$x\+y\$/);
  assert.match(note.content, /\$\$\s*E=mc\^2\s*\$\$/s);
  assert.match(note.content, /> \[!NOTE] 备注/);
  assert.match(note.content, /```mermaid/);
  assert.match(note.content, /\[音频]\(\/api\/attachments\/[^)]+\?download=1\)/);
});
