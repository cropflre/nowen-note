import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  assistantConnection, filesFromDrop, importErrorKind, importPhase, importRisks, isIgnoredImportPath, packageImport, planImport, warningText,
  type ImportFile,
} from "../smartImport";
import type { MigrationJob } from "../migrations";

const entry = (path: string, body = "x"): ImportFile => ({ file: new File([body], path.split("/").pop()!), path });

describe("planning what to upload", () => {
  it("packages a folder of notes and attachments together, named after the folder", () => {
    const plan = planImport([entry("Vault/Daily/a.md"), entry("Vault/assets/p.png"), entry("Vault/.obsidian/app.json"), entry("Vault/.DS_Store")], "Imported");
    expect(plan).toMatchObject({ ok: true, name: "Vault", unsupported: [] });
    if (!plan.ok) throw new Error("plan");
    expect(plan.uploads).toHaveLength(1);
    const upload = plan.uploads[0];
    expect(upload.kind).toBe("package");
    // The folder becomes the import's own folder, so its name is not repeated inside it.
    expect(upload.kind === "package" && upload.entries.map((item) => item.path)).toEqual(["Daily/a.md", "assets/p.png"]);
  });

  it("sends ZIP files and a lone note as they are", () => {
    const zip = entry("Export-1234.zip");
    expect(planImport([zip], "Imported")).toMatchObject({ ok: true, name: "Export-1234", uploads: [{ kind: "file", file: zip.file }] });
    const note = entry("Reading list.md");
    expect(planImport([note], "Imported")).toMatchObject({ ok: true, name: "Reading list", uploads: [{ kind: "file", file: note.file }] });
    const mixed = planImport([entry("a.zip"), entry("b.zip"), entry("c.md"), entry("d.md")], "Imported");
    expect(mixed.ok && mixed.uploads.map((item) => item.kind)).toEqual(["file", "file", "package"]);
    expect(mixed.ok && mixed.name).toBe("Imported");
  });

  it("explains selections it cannot import instead of uploading them", () => {
    expect(planImport([], "Imported")).toMatchObject({ ok: false, reason: "empty" });
    expect(planImport([entry("photo.png"), entry("report.pdf")], "Imported")).toMatchObject({ ok: false, reason: "no-notes" });
    expect(planImport([entry("Notes.enex"), entry("book.epub")], "Imported")).toMatchObject({ ok: false, reason: "unsupported", unsupported: ["Notes.enex", "book.epub"] });
    // Unknown files next to notes are counted, not silently dropped.
    expect(planImport([entry("a.md"), entry("b.md"), entry("c.enex")], "Imported")).toMatchObject({ ok: true, unsupported: ["c.enex"] });
    const huge = { file: Object.defineProperty(new File(["x"], "big.zip"), "size", { value: 513 * 1024 * 1024 }), path: "big.zip" };
    expect(planImport([huge], "Imported")).toMatchObject({ ok: false, reason: "too-large" });
  });

  it("ignores app settings, trash and OS files", () => {
    for (const path of [".obsidian/app.json", "Vault/.trash/x.md", "__MACOSX/a.md", "x/Thumbs.db", "desktop.ini"]) expect(isIgnoredImportPath(path)).toBe(true);
    for (const path of ["notes/a.md", "a.b/c.md"]) expect(isIgnoredImportPath(path)).toBe(false);
  });
});

describe("packaging and folders", () => {
  it("builds a ZIP that keeps relative paths", async () => {
    const percents: number[] = [];
    const file = await packageImport("Vault", [entry("Daily/a.md", "# A\n![](../assets/p.png)"), entry("assets/p.png", "PNG")], (percent) => percents.push(percent));
    expect(file.name).toBe("Vault.zip");
    const zip = await JSZip.loadAsync(file);
    expect(Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort()).toEqual(["Daily/a.md", "assets/p.png"]);
    expect(await zip.file("Daily/a.md")!.async("string")).toBe("# A\n![](../assets/p.png)");
    expect(percents.at(-1)).toBe(100);
  });

  it("walks dropped folders, including directories with more than one page of entries", async () => {
    const fileEntry = (name: string) => ({ isFile: true, isDirectory: false, name, file: (resolve: (file: File) => void) => resolve(new File([name], name)) });
    const many = Array.from({ length: 101 }, (_, index) => fileEntry(`n${index}.md`));
    const pages = [many.slice(0, 100), many.slice(100), []];
    const folder = { isFile: false, isDirectory: true, name: "Vault", createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(pages.shift()!) }) };
    const transfer = { items: [{ webkitGetAsEntry: () => folder }, { webkitGetAsEntry: () => fileEntry("loose.md") }], files: [] } as unknown as DataTransfer;
    const files = await filesFromDrop(transfer);
    expect(files).toHaveLength(102);
    expect(files[0].path).toBe("Vault/n0.md");
    expect(files.at(-1)!.path).toBe("loose.md");
  });
});

describe("reading results", () => {
  const job = (status: MigrationJob["status"]) => ({ status } as MigrationJob);

  it("maps server states onto the few steps a person sees", () => {
    expect(importPhase(null, false)).toBe("start");
    expect(importPhase(null, true)).toBe("preparing");
    expect(importPhase(job("SCANNING"), false)).toBe("preparing");
    expect(importPhase(job("CREATED"), false)).toBe("incomplete");
    expect(importPhase(job("PREVIEW_READY"), false)).toBe("preview");
    expect(importPhase(job("PAUSED"), false)).toBe("importing");
    expect(importPhase(job("COMPLETED"), false)).toBe("done");
    expect(importPhase(job("PARTIAL"), false)).toBe("partial");
  });

  it("turns error codes into a kind of problem with a way forward", () => {
    expect(importErrorKind("MIGRATION_INVALID_ZIP")).toBe("format");
    expect(importErrorKind(Object.assign(new Error("附件校验失败"), { code: "MIGRATION_UPLOAD_TOO_LARGE", status: 413 }))).toBe("size");
    expect(importErrorKind("MIGRATION_INVALID_UTF8")).toBe("encoding");
    expect(importErrorKind(Object.assign(new Error("x"), { code: "MIGRATION_PREVIEW_EXPIRED" }))).toBe("changed");
    expect(importErrorKind(new TypeError("Failed to fetch"))).toBe("network");
    expect(importErrorKind(Object.assign(new Error("Bad gateway"), { status: 502 }))).toBe("network");
    expect(importErrorKind(new Error("MIGRATION_ACCOUNT_CHANGED"))).toBe("account");
    expect(importErrorKind("SOMETHING_ELSE")).toBe("unknown");
  });

  it("groups warnings into a short list and keeps their readable text for details", () => {
    expect(importRisks([
      "HTML_SANITIZED; unsupported styles are removed", "UNRESOLVED_RELATIVE_REFERENCES; original links are preserved",
      "EXTERNAL_RESOURCES_PRESERVED; remote images are not downloaded", "SOURCE_CHANGED_EXISTING_KEPT; 来源内容已变化",
    ])).toEqual(["missing", "simplified", "external"]);
    expect(importRisks(["NOTION_CSV_UNMAPPED_ROWS; …", "UNSUPPORTED_FILES_SKIPPED; …"])).toEqual(["unsupported"]);
    // Page bodies still arrive when only database properties stay unconverted.
    expect(importRisks(["NOTION_CSV_PROPERTIES_STAGED_ONLY; …", "NOTION_CSV_UNREADABLE; …"])).toEqual(["simplified"]);
    expect(warningText("UNRESOLVED_RELATIVE_REFERENCES; original links are preserved")).toBe("original links are preserved");
    expect(warningText("有无法转换的内部链接")).toBe("有无法转换的内部链接");
  });

  it("calls an assistant connected only when an active import token has really been used", () => {
    const token = { scopes: ["export:import", "notes:write"], lastUsedAt: "2026-11-10T00:00:00Z", revokedAt: null, expiresAt: null };
    expect(assistantConnection([token])).toEqual({ lastUsedAt: "2026-11-10T00:00:00Z" });
    expect(assistantConnection([{ ...token, lastUsedAt: null }])).toBeNull();
    expect(assistantConnection([{ ...token, revokedAt: "2026-11-11T00:00:00Z" }])).toBeNull();
    expect(assistantConnection([{ ...token, scopes: ["notes:read"] }])).toBeNull();
    expect(assistantConnection([{ ...token, expiresAt: "2026-01-01T00:00:00Z" }], Date.parse("2026-11-16T00:00:00Z"))).toBeNull();
  });
});
