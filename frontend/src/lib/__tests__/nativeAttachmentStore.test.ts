import { createHash } from "node:crypto";
import { Blob as ForeignBlob, File as ForeignFile } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeAttachmentStoreForAccountHash } from "../nativeAttachmentStore";

const filesystem = vi.hoisted(() => {
  const files = new Map<string, Buffer>();
  const missing = () => Object.assign(new Error("Not found"), { code: "OS-PLUG-FILE-0008" });
  return {
    files,
    stat: vi.fn(async ({ path }: { path: string }) => {
      const bytes = files.get(path);
      if (!bytes) throw missing();
      return { type: "file", size: bytes.length, mtime: 1, ctime: 1, uri: `file:///${path}` };
    }),
    readdir: vi.fn(async () => ({ files: [] })),
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      files.set(path, Buffer.from(data, "base64"));
      return { uri: `file:///${path}` };
    }),
    appendFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      const previous = files.get(path);
      if (!previous) throw missing();
      files.set(path, Buffer.concat([previous, Buffer.from(data, "base64")]));
    }),
    readFileInChunks: vi.fn(async (
      { path, chunkSize }: { path: string; chunkSize: number },
      callback: (chunk: { data: string }) => void,
    ) => {
      const bytes = files.get(path);
      if (!bytes) throw missing();
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        callback({ data: bytes.subarray(offset, offset + chunkSize).toString("base64") });
      }
      callback({ data: "" });
      return "read-callback";
    }),
    rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const bytes = files.get(from);
      if (!bytes) throw missing();
      files.set(to, bytes);
      files.delete(from);
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      if (!files.delete(path)) throw missing();
    }),
    getUri: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///${path}` })),
  };
});

vi.mock("@capacitor/core", () => ({ Capacitor: {
  isNativePlatform: () => true, getPlatform: () => "android", convertFileSrc: (uri: string) => uri,
} }));
vi.mock("@capacitor/filesystem", () => ({ Directory: { Data: "DATA" }, Filesystem: filesystem }));
vi.mock("../attachmentMediaPlugin", () => ({ attachmentMediaPlugin: {} }));
vi.mock("../noteAttachmentAccessBridge", () => ({ registerNativeAttachmentUrl: vi.fn() }));

const accountHash = "0123456789abcdef";
const stablePath = `attachments/${accountHash}/selected-file`;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  filesystem.files.clear();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, "__nowenNoteNativeAttachmentState");
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "__nowenNoteNativeAttachmentState");
});

describe("native attachment file input", () => {
  it.each([["Screenshot.png", "image/png", 60211], ["Screenshot.jpg", "image/jpeg", 496435]] as const)(
    "persists a foreign-realm picker File %s without dropping its bytes (DCC-009)",
    async (filename, type, size) => {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
      // File/Blob can originate from a different WebView realm or constructor.
      // Node's File supplies real Blob bytes but is not this jsdom window's Blob.
      const file = new ForeignFile([bytes], filename, { type }) as unknown as File;
      expect(file instanceof Blob).toBe(false);
      const store = createNativeAttachmentStoreForAccountHash(accountHash);
      const result = await store.save({ attachmentId: "selected-file", data: file });

      expect(result).toMatchObject({ size, sha256: sha256(bytes), path: stablePath });
      expect(filesystem.files.get(stablePath)).toEqual(Buffer.from(bytes));
      const reopened = createNativeAttachmentStoreForAccountHash(accountHash);
      expect(await reopened.stat("selected-file")).toMatchObject({ size, sha256: sha256(bytes) });
      expect(filesystem.writeFile.mock.calls.every(([input]) => Buffer.from(input.data, "base64").length <= 192 * 1024)).toBe(true);
      expect(await createNativeAttachmentStoreForAccountHash("fedcba9876543210").exists("selected-file")).toBe(false);
    },
  );

  it("retains the old attachment after a chunk write fails and can retry (DCC-008)", async () => {
    const previous = Buffer.from("previous attachment");
    filesystem.files.set(stablePath, previous);
    const store = createNativeAttachmentStoreForAccountHash(accountHash);
    const bytes = new Uint8Array(400000).fill(37);
    const file = new ForeignFile([bytes], "replacement.jpg") as unknown as File;
    filesystem.appendFile.mockRejectedValueOnce(new Error("Disk full"));

    await expect(store.save({ attachmentId: "selected-file", data: file })).rejects.toThrow("Disk full");
    expect([...filesystem.files.entries()]).toEqual([[stablePath, previous]]);
    await store.save({ attachmentId: "selected-file", data: file });
    expect(filesystem.files.get(stablePath)).toEqual(Buffer.from(bytes));
  });

  it("still rejects wrong sizes and hashes without replacing existing bytes", async () => {
    const previous = Buffer.from("previous attachment");
    filesystem.files.set(stablePath, previous);
    const store = createNativeAttachmentStoreForAccountHash(accountHash);
    const file = new ForeignBlob(["new attachment"]) as unknown as Blob;
    await expect(store.save({ attachmentId: "selected-file", data: file, expectedSize: 999 })).rejects.toThrow("附件大小校验失败");
    await expect(store.save({ attachmentId: "selected-file", data: file, expectedHash: "0".repeat(64) })).rejects.toThrow("附件 SHA-256 校验失败");
    expect([...filesystem.files.entries()]).toEqual([[stablePath, previous]]);
  });

  it("reads foreign-realm Blob chunks and their empty completion marker", async () => {
    const bytes = Buffer.from("native bridge blob chunk");
    filesystem.files.set(stablePath, bytes);
    filesystem.readFileInChunks.mockImplementationOnce(async (_options, callback) => {
      callback({ data: new ForeignBlob([bytes]) as unknown as string });
      callback({ data: new ForeignBlob([]) as unknown as string });
      return "read-callback";
    });
    const result = await createNativeAttachmentStoreForAccountHash(accountHash).stat("selected-file");
    expect(result).toMatchObject({ size: bytes.length, sha256: sha256(bytes) });
  });

  it.each([new Uint8Array([0, 128, 255]), new Uint8Array([0, 128, 255]).buffer])(
    "continues accepting binary input %s", async data => {
      const result = await createNativeAttachmentStoreForAccountHash(accountHash).save({ attachmentId: "selected-file", data });
      expect(result.size).toBe(3);
      expect(filesystem.files.get(stablePath)).toEqual(Buffer.from([0, 128, 255]));
    },
  );
});
