import { beforeEach, describe, expect, it } from "vitest";
import {
  createTiptapSubdocumentBundle,
  createTiptapSubdocumentRestSyncController,
  createTiptapSubdocumentSyncController,
  destroyTiptapSubdocumentBundle,
  materializeTiptapSubdocuments,
  splitTiptapSubdocumentSections,
} from "@/lib/yjsSubdocumentModel";

function document(nodes: any[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

describe("Y.js Tiptap subdocument model", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  it("splits at H1/H2 boundaries and keeps GUIDs stable across text edits", () => {
    const nodes = [
      { type: "heading", attrs: { level: 1, blockId: "blk_a00000" }, content: [{ type: "text", text: "A" }] },
      { type: "paragraph", attrs: { blockId: "blk_a00001" }, content: [{ type: "text", text: "one" }] },
      { type: "heading", attrs: { level: 2, blockId: "blk_b00000" }, content: [{ type: "text", text: "B" }] },
      { type: "paragraph", attrs: { blockId: "blk_b00001" }, content: [{ type: "text", text: "two" }] },
    ];
    const first = splitTiptapSubdocumentSections("note-1", document(nodes), 250)!;
    nodes[3].content[0].text = "changed";
    const second = splitTiptapSubdocumentSections("note-1", document(nodes), 250)!;
    expect(first.map((section) => section.guid)).toEqual(second.map((section) => section.guid));
    expect(first).toHaveLength(2);
  });

  it("chunks heading-free content and losslessly materializes loaded subdocuments", () => {
    const content = document(Array.from({ length: 25 }, (_, index) => ({
      type: "paragraph",
      attrs: { blockId: `blk_${String(index).padStart(6, "0")}` },
      content: [{ type: "text", text: `p${index}` }],
    })));
    const bundle = createTiptapSubdocumentBundle("note-2", content, 10)!;
    expect(bundle.sections).toHaveLength(3);
    expect(materializeTiptapSubdocuments(bundle)).toBe(content);
    destroyTiptapSubdocumentBundle(bundle);
  });

  it("fails closed for malformed Tiptap JSON", () => {
    expect(createTiptapSubdocumentBundle("note-3", "not-json")).toBeNull();
  });

  it("keeps a lazy bundle empty until a requested section snapshot is loaded", async () => {
    const content = document(Array.from({ length: 25 }, (_, index) => ({
      type: "paragraph",
      attrs: { blockId: `blk_lazy${String(index).padStart(2, "0")}` },
      content: [],
    })));
    const bundle = createTiptapSubdocumentBundle("note-lazy", content, 10, { preload: false })!;
    const section = bundle.sections[1];
    const serverDoc = new (await import("yjs")).Doc({ guid: section.guid });
    serverDoc.getText("content").insert(0, section.content);
    const Y = await import("yjs");
    const controller = createTiptapSubdocumentRestSyncController(bundle, {
      load: async () => ({ guid: section.guid, state: Y.encodeStateAsUpdate(serverDoc) }),
      send: async () => undefined,
    });

    expect(bundle.subdocuments.size).toBe(0);
    await controller.loadSection(section.id);
    expect([...bundle.subdocuments.keys()]).toEqual([section.id]);

    controller.destroy();
    serverDoc.destroy();
    destroyTiptapSubdocumentBundle(bundle);
  });

  it("merges offline section updates and does not echo remote updates", () => {
    const content = document([{ type: "paragraph", attrs: { blockId: "blk_offline" }, content: [] }]);
    const bundle = createTiptapSubdocumentBundle("note-offline", content)!;
    const sent: Uint8Array[] = [];
    let online = false;
    const controller = createTiptapSubdocumentSyncController(bundle, {
      send: (_sectionId, update) => {
        if (!online) return false;
        sent.push(update);
        return true;
      },
    });
    const section = bundle.subdocuments.values().next().value!;
    section.getText("content").insert(section.getText("content").length, " ");
    section.getText("content").insert(section.getText("content").length, " ");
    expect(controller.pendingCount()).toBe(1);
    online = true;
    expect(controller.flushPending()).toBe(1);
    expect(sent).toHaveLength(1);
    controller.applyRemote(bundle.sections[0].id, sent[0]);
    expect(sent).toHaveLength(1);
    controller.destroy();
    destroyTiptapSubdocumentBundle(bundle);
  });

  it("keeps failed REST updates pending, merges them and flushes once online without remote echo", async () => {
    const content = document([{ type: "paragraph", attrs: { blockId: "blk_rest00" }, content: [] }]);
    const bundle = createTiptapSubdocumentBundle("note-rest", content)!;
    const section = bundle.sections[0];
    const serverDoc = new (await import("yjs")).Doc({ guid: section.guid });
    serverDoc.getText("content").insert(0, content);
    const Y = await import("yjs");
    const sent: Uint8Array[] = [];
    let online = false;
    const controller = createTiptapSubdocumentRestSyncController(bundle, {
      load: async () => ({ guid: section.guid, state: Y.encodeStateAsUpdate(serverDoc) }),
      send: async (_sectionId, update) => {
        if (!online) throw new TypeError("offline");
        sent.push(update);
      },
    });

    expect(await controller.loadSection(section.id)).toBe(content);
    expect(controller.updateSectionContent(section.id, document([
      { type: "paragraph", attrs: { blockId: "blk_rest00" }, content: [{ type: "text", text: "one" }] },
    ]))).toBe(true);
    expect(controller.updateSectionContent(section.id, document([
      { type: "paragraph", attrs: { blockId: "blk_rest00" }, content: [{ type: "text", text: "two" }] },
    ]))).toBe(true);
    await Promise.resolve();
    expect(controller.pendingCount()).toBe(1);
    expect(sent).toHaveLength(0);

    online = true;
    expect(await controller.flushPending()).toBe(1);
    expect(controller.pendingCount()).toBe(0);
    expect(sent).toHaveLength(1);

    const beforeRemote = sent.length;
    const vector = Y.encodeStateVector(serverDoc);
    serverDoc.getMap("remote").set("value", 1);
    expect(controller.applyRemote(section.id, Y.encodeStateAsUpdate(serverDoc, vector))).toBe(true);
    await Promise.resolve();
    expect(sent).toHaveLength(beforeRemote);

    controller.destroy();
    serverDoc.destroy();
    destroyTiptapSubdocumentBundle(bundle);
  });

  it("restores persisted offline updates after unload and flushes them from a rebuilt controller", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const content = document([{ type: "paragraph", attrs: { blockId: "blk_persist" }, content: [] }]);
    const Y = await import("yjs");
    const firstBundle = createTiptapSubdocumentBundle("note-persist", content)!;
    const section = firstBundle.sections[0];
    const serverDoc = new Y.Doc({ guid: section.guid });
    serverDoc.getText("content").insert(0, content);
    const load = async () => ({ guid: section.guid, state: Y.encodeStateAsUpdate(serverDoc) });
    const firstController = createTiptapSubdocumentRestSyncController(firstBundle, {
      load,
      send: async () => { throw new TypeError("offline"); },
    });
    await firstController.loadSection(section.id);
    firstController.updateSectionContent(section.id, document([
      { type: "paragraph", attrs: { blockId: "blk_persist" }, content: [{ type: "text", text: "offline" }] },
    ]));
    await Promise.resolve();
    expect(firstController.pendingCount()).toBe(1);
    firstController.destroy();
    destroyTiptapSubdocumentBundle(firstBundle);

    const sent: Uint8Array[] = [];
    const rebuiltBundle = createTiptapSubdocumentBundle("note-persist", content, 250, { preload: false })!;
    const rebuiltController = createTiptapSubdocumentRestSyncController(rebuiltBundle, {
      load,
      send: async (_sectionId, update) => { sent.push(update); },
    });
    expect(rebuiltController.pendingCount()).toBe(1);
    expect(await rebuiltController.loadSection(section.id)).toContain("offline");
    expect(rebuiltController.pendingCount()).toBe(1);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    expect(await rebuiltController.flushPending()).toBe(1);
    expect(rebuiltController.pendingCount()).toBe(0);
    Y.applyUpdate(serverDoc, sent[0]);
    expect(serverDoc.getText("content").toString()).toContain("offline");

    rebuiltController.destroy();
    destroyTiptapSubdocumentBundle(rebuiltBundle);
    serverDoc.destroy();
  });

  it("clears a corrupted persisted pending queue without applying it", () => {
    const noteId = "note-corrupt-pending";
    localStorage.setItem(`nowen:yjs-subdocument-pending:${encodeURIComponent(noteId)}`, "not-json");
    const content = document([{ type: "paragraph", attrs: { blockId: "blk_corrupt" }, content: [] }]);
    const bundle = createTiptapSubdocumentBundle(noteId, content)!;
    const controller = createTiptapSubdocumentRestSyncController(bundle, {
      load: async () => { throw new Error("unused"); },
      send: async () => undefined,
    });

    expect(controller.pendingCount()).toBe(0);
    expect(localStorage.getItem(`nowen:yjs-subdocument-pending:${encodeURIComponent(noteId)}`)).toBeNull();
    controller.destroy();
    destroyTiptapSubdocumentBundle(bundle);
  });
});
