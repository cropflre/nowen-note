import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import JSZip from "jszip";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-issue-284-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.ELECTRON_USER_DATA = tempDir;

const USER_ID = "issue-284-user";
const WORKSPACE_ID = "issue-284-workspace";
const MARKDOWN_NOTEBOOK_ID = "issue-284-markdown";
const RICH_NOTEBOOK_ID = "issue-284-rich";

let closeDb: () => void;
let db: any;
let importSiyuanPackageFromZipFile: (zipPath: string, options: any) => Promise<any>;

function fixturePath(): string {
  const relative = path.join("tests", "fixtures", "siyuan", "issue-284", "20260719010101-demo284.sy");
  const candidates = [
    path.join(process.cwd(), relative),
    path.join(process.cwd(), "backend", relative),
  ];
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (!hit) throw new Error(`Issue 284 fixture not found; checked: ${candidates.join(", ")}`);
  return hit;
}

async function buildPackage(): Promise<string> {
  const zip = new JSZip();
  zip.file("data/issue284/20260719010101-demo284.sy", fs.readFileSync(fixturePath(), "utf8"));
  zip.file("data/issue284/assets/issue-284-sound.mp3", new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]));
  const zipPath = path.join(tempDir, "issue-284.sy.zip");
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  return zipPath;
}

type TiptapNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: TiptapNode[];
};

function flatten(node: TiptapNode): TiptapNode[] {
  return [node, ...(node.content || []).flatMap(flatten)];
}

before(async () => {
  const schema = await import("../src/db/schema.js");
  const siyuan = await import("../src/services/siyuanPackageImport.js");
  closeDb = schema.closeDb;
  db = schema.getDb();
  importSiyuanPackageFromZipFile = siyuan.importSiyuanPackageFromZipFile;

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'x')").run(USER_ID, USER_ID);
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(WORKSPACE_ID, "Issue 284", USER_ID);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')").run(WORKSPACE_ID, USER_ID);
  db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, ?, ?)")
    .run(MARKDOWN_NOTEBOOK_ID, USER_ID, "Markdown", WORKSPACE_ID);
  db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, ?, ?)")
    .run(RICH_NOTEBOOK_ID, USER_ID, "Rich", WORKSPACE_ID);
});

after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("issue 284 real-shape package keeps Markdown callout, iframe and media semantics", async () => {
  const zipPath = await buildPackage();
  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: MARKDOWN_NOTEBOOK_ID,
    contentFormat: "markdown",
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.equal(result.stats.importedAssets, 1);
  assert.equal(result.stats.unsupportedNodes.NodeCallout, 1);
  assert.equal(result.stats.unsupportedNodes.NodeIFrame, 1);

  const note = db.prepare("SELECT content, contentText, contentFormat FROM notes WHERE id = ?")
    .get(result.notes[0].id) as { content: string; contentText: string; contentFormat: string };
  assert.equal(note.contentFormat, "markdown");
  assert.match(note.content, /> \[!TIP\]- 温馨提示/);
  assert.match(note.content, /> Callout 正文必须在实时预览与完整预览中保持一致。/);
  assert.doesNotMatch(note.content, /custom-issue/);
  assert.match(note.content, /<iframe[^>]+password=issue284-secret/);
  assert.match(note.content, /\[音频\]\(\/api\/attachments\/[0-9a-f-]+\?download=1\)/i);
  assert.match(note.contentText, /Callout 正文必须/);
  assert.ok(result.warnings.some((warning: string) => /callout.*styled blockquote/i.test(warning)));
  assert.ok(result.warnings.some((warning: string) => /iframe.*downgraded safe link/i.test(warning)));
});

test("issue 284 rich-text path stays valid and reports every intentional downgrade", async () => {
  const zipPath = await buildPackage();
  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: RICH_NOTEBOOK_ID,
    contentFormat: "tiptap-json",
  });

  assert.equal(result.success, true);
  const note = db.prepare("SELECT content, contentText, contentFormat FROM notes WHERE id = ?")
    .get(result.notes[0].id) as { content: string; contentText: string; contentFormat: string };
  assert.equal(note.contentFormat, "tiptap-json");

  const parsed = JSON.parse(note.content) as TiptapNode;
  assert.equal(parsed.type, "doc");
  assert.ok(Array.isArray(parsed.content) && parsed.content.length > 0);
  const nodes = flatten(parsed);
  const nodeTypes = new Set(nodes.map((node) => node.type));
  for (const unsupported of ["callout", "iframe", "audio", "widget", "embed"]) {
    assert.equal(nodeTypes.has(unsupported), false);
  }

  const callout = nodes.find((node) => node.type === "blockquote" && node.content?.some((child) =>
    child.content?.some((inline) => inline.text?.includes("[!TIP]")),
  ));
  assert.ok(callout);
  const marker = flatten(callout!).find((node) => node.type === "text" && node.text?.startsWith("[!TIP]"));
  assert.equal(marker?.text, "[!TIP] 温馨提示");
  assert.ok(marker?.marks?.some((mark) => mark.type === "bold"));
  assert.ok(flatten(callout!).some((node) => node.type === "text" && node.text === " 💡"));
  assert.ok(flatten(callout!).some((node) => node.text?.includes("Callout 正文必须")));

  assert.equal(nodes.some((node) => node.text?.includes("custom-issue")), false);
  const audio = nodes.find((node) => node.text === "音频附件");
  assert.ok(audio?.marks?.some((mark) => mark.type === "link" && /^\/api\/attachments\//.test(String(mark.attrs?.href))));
  assert.ok(audio?.marks?.some((mark) => mark.type === "bold"));
  const embed = nodes.find((node) => node.text === "嵌入内容");
  assert.ok(embed?.marks?.some((mark) => mark.type === "link" && String(mark.attrs?.href).includes("password=issue284-secret")));
  const widget = nodes.find((node) => node.text === "挂件内容");
  assert.ok(widget?.marks?.some((mark) => mark.type === "link"));
  assert.match(note.contentText, /温馨提示/);
  assert.match(note.contentText, /Callout 正文必须/);

  assert.ok(result.warnings.some((warning: string) => warning.includes("Callout 已映射")));
  assert.ok(result.warnings.some((warning: string) => warning.includes("iframe 已保留")));
  assert.ok(result.warnings.some((warning: string) => warning.includes("音频已保留")));
  assert.ok(result.warnings.some((warning: string) => warning.includes("挂件已保留")));
  assert.ok(result.warnings.some((warning: string) => warning.includes("IAL 属性行")));
});
