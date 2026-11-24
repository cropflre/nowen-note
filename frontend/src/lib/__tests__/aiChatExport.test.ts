import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectAIChatExport, zipEntryNames } from "../aiChatExport";

const zipFile = async (name: string, entries: Record<string, string>) => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return new File([await zip.generateAsync({ type: "blob", compression: "DEFLATE" })], name);
};
const chosen = (file: File) => [{ file, path: file.name }];

describe("recognizing AI chat exports among files chosen for import", () => {
  it("recognizes a ChatGPT export ZIP from its directory, including numbered shards, without unpacking it", async () => {
    const single = await zipFile("export.zip", { "conversations.json": "[]", "chat.html": "<html></html>", "user.json": "{}" });
    expect(await zipEntryNames(single)).toEqual(expect.arrayContaining(["conversations.json", "chat.html"]));
    expect(await detectAIChatExport(chosen(single))).toEqual({ file: single, provider: "chatgpt" });
    const sharded = await zipFile("export.zip", { "Export/conversations-000.json": "[]", "Export/conversations-001.json": "[]" });
    expect((await detectAIChatExport(chosen(sharded)))?.provider).toBe("chatgpt");
  });

  it("leaves note packages, other files and multiple selections to the normal import", async () => {
    expect(await detectAIChatExport(chosen(await zipFile("vault.zip", { "Daily/a.md": "# A", "assets/conversations.png": "x" })))).toBeNull();
    expect(await detectAIChatExport(chosen(new File(["# note"], "conversations.md")))).toBeNull();
    expect(await detectAIChatExport(chosen(new File(['{"name":"settings"}'], "config.json")))).toBeNull();
    const archive = await zipFile("export.zip", { "conversations.json": "[]" });
    expect(await detectAIChatExport([...chosen(archive), { file: new File(["# a"], "a.md"), path: "a.md" }])).toBeNull();
  });

  it("recognizes conversation JSON by name or content", async () => {
    expect((await detectAIChatExport(chosen(new File(["[]"], "conversations.json"))))?.provider).toBe("chatgpt");
    expect((await detectAIChatExport(chosen(new File(['[{"title":"x","mapping":{},"current_node":"a"}]'], "chats.json"))))?.provider).toBe("chatgpt");
    expect((await detectAIChatExport(chosen(new File([JSON.stringify({ format: "nowen-ai-conversation", schemaVersion: 1 }, null, 2)], "saved.json"))))?.provider).toBe("standard");
    expect((await detectAIChatExport(chosen(new File(['{"externalConversationId":"a","messages":[]}'], "chat.json"))))?.provider).toBe("standard");
  });

  it("treats damaged or unusual archives as not recognized instead of failing", async () => {
    expect(await detectAIChatExport(chosen(new File(["not a zip archive"], "broken.zip")))).toBeNull();
    expect(await zipEntryNames(new File(["PK"], "tiny.zip"))).toBeNull();
    const zip = new JSZip(); zip.file("conversations.json", "[]");
    const archive = await zip.generateAsync({ type: "uint8array" });
    archive.fill(0, archive.length - 22);
    expect(await detectAIChatExport(chosen(new File([archive], "cut.zip")))).toBeNull();
  });
});
