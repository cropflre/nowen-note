import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORT_METHOD,
  IMPORT_METHOD_GROUPS,
  IMPORT_METHOD_STORAGE_KEY,
  persistImportMethod,
  readImportMethod,
  shouldResetSharedFileImport,
  type ImportMethodStorage,
} from "../importHub";

function memoryStorage(initial?: string): ImportMethodStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === IMPORT_METHOD_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === IMPORT_METHOD_STORAGE_KEY) this.value = value;
    },
  };
}

describe("import hub information architecture", () => {
  it("exposes eight unique first-level sources in the intended groups", () => {
    const methods = IMPORT_METHOD_GROUPS.flatMap((group) => group.methods);
    expect(IMPORT_METHOD_GROUPS.map((group) => group.id)).toEqual([
      "migration",
      "general",
      "restore",
    ]);
    expect(methods).toEqual([
      "siyuan",
      "obsidian",
      "wechat-favorites",
      "youdao",
      "mobile-memo",
      "generic",
      "url",
      "nowen",
    ]);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("defaults to generic files and restores a valid previous source", () => {
    expect(readImportMethod(memoryStorage("not-a-source"))).toBe(DEFAULT_IMPORT_METHOD);
    expect(readImportMethod(memoryStorage("wechat-favorites"))).toBe("wechat-favorites");
  });

  it("persists the selected source without throwing", () => {
    const storage = memoryStorage();
    persistImportMethod("obsidian", storage);
    expect(storage.value).toBe("obsidian");
  });

  it("clears shared file state whenever SiYuan or generic files are crossed", () => {
    expect(shouldResetSharedFileImport("generic", "siyuan")).toBe(true);
    expect(shouldResetSharedFileImport("siyuan", "obsidian")).toBe(true);
    expect(shouldResetSharedFileImport("obsidian", "generic")).toBe(true);
    expect(shouldResetSharedFileImport("obsidian", "wechat-favorites")).toBe(false);
  });
});
