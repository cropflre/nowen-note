import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-remote-images-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.SIYUAN_IMPORT_REMOTE_IMAGE_CONCURRENCY = "2";

const USER_ID = "siyuan-remote-image-user";
const NOTEBOOK_ID = "siyuan-remote-image-notebook";
const REMOTE_IMAGE_URL = "http://93.184.216.34/image-bed/pixel.png";
const FAILED_REMOTE_IMAGE_URL = "http://93.184.216.34/image-bed/missing.png";
const PNG_BYTES = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQ3sAAAAASUVORK5CYII=",
    "base64",
);

let closeDb: () => void;
let getDb: () => import("better-sqlite3").Database;
let importSiyuanPackageFromZipFile: typeof import("../src/services/siyuanPackageImport").importSiyuanPackageFromZipFile;
const originalFetch = globalThis.fetch;

function syDoc(id: string, title: string, children: any[] = []) {
    return {
        ID: id,
        Type: "NodeDocument",
        Properties: { title },
        updated: "20260731120000",
        Children: children,
    };
}

function image(src: string, alt: string) {
    return {
        Type: "NodeImage",
        Children: [
            { Type: "NodeLinkText", Data: alt },
            { Type: "NodeLinkDest", Data: src },
        ],
    };
}

async function writeZip(name: string, title: string, remoteUrl: string) {
    const zip = new JSZip();
    zip.file(
        "doc.sy",
        JSON.stringify(syDoc(name, title, [{
            Type: "NodeParagraph",
            Children: [
                { Type: "NodeText", Data: "远程图片一 " },
                image(remoteUrl, "图床图片一"),
                { Type: "NodeText", Data: " 远程图片二 " },
                image(remoteUrl, "图床图片二"),
            ],
        }])),
    );
    const zipPath = path.join(tmpDir, `${name}.zip`);
    fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
    return zipPath;
}

function getNote(title: string) {
    return getDb().prepare(`
        SELECT id, title, content, contentFormat, version
        FROM notes WHERE title = ? ORDER BY createdAt DESC LIMIT 1
    `).get(title) as {
        id: string;
        title: string;
        content: string;
        contentFormat: string;
        version: number;
    } | undefined;
}

function listAttachments(noteId: string) {
    return getDb().prepare(`
        SELECT id, noteId, filename, mimeType, size, path, uploadSource
        FROM attachments WHERE noteId = ? ORDER BY id
    `).all(noteId) as Array<{
        id: string;
        noteId: string;
        filename: string;
        mimeType: string;
        size: number;
        path: string;
        uploadSource: string;
    }>;
}

test.before(async () => {
    const [schemaModule, importerModule] = await Promise.all([
        import("../src/db/schema"),
        import("../src/services/siyuanPackageImport"),
    ]);
    closeDb = schemaModule.closeDb;
    getDb = schemaModule.getDb;
    importSiyuanPackageFromZipFile = importerModule.importSiyuanPackageFromZipFile;

    const db = getDb();
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
        .run(USER_ID, USER_ID, "hash");
    db.prepare("INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId) VALUES (?, ?, NULL, ?, ?, NULL)")
        .run(NOTEBOOK_ID, USER_ID, "思源远程图片", "📥");
});

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test.after(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Markdown target downloads SiYuan image-bed images into file management", { concurrency: false }, async () => {
    let fetchCount = 0;
    globalThis.fetch = async (input) => {
        fetchCount += 1;
        assert.equal(String(input), REMOTE_IMAGE_URL);
        return new Response(PNG_BYTES, {
            status: 200,
            headers: {
                "Content-Type": "image/png",
                "Content-Length": String(PNG_BYTES.byteLength),
                "Content-Disposition": 'inline; filename="pixel.png"',
            },
        });
    };

    const zipPath = await writeZip("remote-success", "图床图片导入成功", REMOTE_IMAGE_URL);
    const result = await importSiyuanPackageFromZipFile(zipPath, {
        userId: USER_ID,
        workspaceId: null,
        targetNotebookId: NOTEBOOK_ID,
        contentFormat: "markdown",
    });

    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(fetchCount, 1, "the same image-bed URL should only be downloaded once");
    assert.equal(
        result.notes[0].version,
        2,
        `localization writes the imported Markdown as version 2; warnings=${JSON.stringify(result.warnings)}`,
    );
    assert.ok(result.warnings.some((warning) => warning.includes("下载到文件管理")));
    assert.ok(!result.warnings.some((warning) => warning.includes(`Siyuan asset not found: ${REMOTE_IMAGE_URL}`)));

    const note = getNote("图床图片导入成功");
    assert.ok(note);
    assert.equal(note.contentFormat, "markdown");
    assert.equal(note.version, 2);
    assert.doesNotMatch(note.content, new RegExp(REMOTE_IMAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const localReferences = note.content.match(/\/api\/attachments\/[0-9a-f-]+/g) || [];
    assert.equal(localReferences.length, 2, "all repeated Markdown image references should be rewritten");

    const attachments = listAttachments(note.id);
    assert.equal(attachments.length, 1, "the localized image should appear once in file management");
    assert.equal(attachments[0].mimeType, "image/png");
    assert.equal(attachments[0].filename, "pixel.png");
    assert.equal(attachments[0].size, PNG_BYTES.byteLength);
    assert.match(attachments[0].uploadSource, /^historical-localization:siyuan-/);
    assert.ok(note.content.includes(`/api/attachments/${attachments[0].id}`));

    const referenceCount = getDb().prepare(
        "SELECT COUNT(*) AS count FROM attachment_references WHERE noteId = ? AND attachmentId = ?",
    ).get(note.id, attachments[0].id) as { count: number };
    assert.equal(referenceCount.count, 1);
});

test("failed image-bed downloads keep the original Markdown URL without failing the import", { concurrency: false }, async () => {
    globalThis.fetch = async () => new Response("upstream failed", { status: 502 });

    const zipPath = await writeZip("remote-failure", "图床图片导入失败降级", FAILED_REMOTE_IMAGE_URL);
    const result = await importSiyuanPackageFromZipFile(zipPath, {
        userId: USER_ID,
        workspaceId: null,
        targetNotebookId: NOTEBOOK_ID,
        contentFormat: "markdown",
    });

    assert.equal(result.success, true);
    assert.equal(result.notes[0].version, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("网络图片下载失败")));
    assert.ok(!result.warnings.some((warning) => warning.includes(`Siyuan asset not found: ${FAILED_REMOTE_IMAGE_URL}`)));

    const note = getNote("图床图片导入失败降级");
    assert.ok(note);
    assert.equal(note.version, 1);
    assert.ok(note.content.includes(FAILED_REMOTE_IMAGE_URL));
    assert.equal(listAttachments(note.id).length, 0);
});
