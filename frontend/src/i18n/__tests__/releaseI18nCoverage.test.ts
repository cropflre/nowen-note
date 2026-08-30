import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import zhBase from "../locales/zh-CN.json";
import enBase from "../locales/en.json";
import {
  enAdditionalTranslations,
  zhCNAdditionalTranslations,
} from "../additionalTranslations";
import {
  enYoudaoTranslations,
  zhCNYoudaoTranslations,
} from "../youdaoTranslations";
import {
  enDownloadNetworkTranslations,
  zhCNDownloadNetworkTranslations,
} from "../downloadNetworkTranslations";
import {
  enMiCloudProgressTranslations,
  zhCNMiCloudProgressTranslations,
} from "../miCloudProgressTranslations";
import {
  enLargeDocumentTranslations,
  zhCNLargeDocumentTranslations,
} from "../largeDocumentTranslations";
import {
  enWorkspaceLayoutTranslations,
  zhCNWorkspaceLayoutTranslations,
} from "../workspaceLayoutTranslations";
import {
  enSecurityAddonTranslations,
  zhCNSecurityAddonTranslations,
} from "../securityAddonTranslations";
import {
  enDiaryMarkdownTranslations,
  zhCNDiaryMarkdownTranslations,
} from "../diaryMarkdownTranslations";
import {
  enEditorSplitTranslations,
  zhCNEditorSplitTranslations,
} from "../editorSplitTranslations";
import {
  enCoverageTranslations,
  zhCNCoverageTranslations,
} from "../coverageTranslations";

type TranslationTree = Record<string, unknown>;

function merge(base: TranslationTree, patch: TranslationTree): TranslationTree {
  const result: TranslationTree = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      result[key] = merge(current as TranslationTree, value as TranslationTree);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergePatches(base: TranslationTree, ...patches: TranslationTree[]): TranslationTree {
  return patches.reduce((current, patch) => merge(current, patch), base);
}

function getPath(tree: TranslationTree, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as TranslationTree)[key];
  }, tree);
}

function leafEntries(tree: unknown, prefix = ""): Array<[string, string]> {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return [];
  const result: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(tree as TranslationTree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.push([path, value]);
    else result.push(...leafEntries(value, path));
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

function interpolationNames(value: string): string[] {
  return Array.from(value.matchAll(/{{\s*([\w.-]+)\s*}}/g), (match) => match[1]).sort();
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "i18n" ? [] : sourceFiles(path);
    }
    return [".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

function literalTranslationKeys(root: string): string[] {
  const keys = new Set<string>();
  const callPattern = /\b(?:t|tr|i18n\.t)\(\s*["'`]([^"'`$]+)["'`]/g;
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf8");
    if (!source.includes("react-i18next") && !/\bi18n\.t\(/.test(source)) continue;
    for (const match of source.matchAll(callPattern)) keys.add(match[1]);
  }
  return [...keys].sort();
}

const zhAdditionalPatch = zhCNAdditionalTranslations as unknown as TranslationTree;
const enAdditionalPatch = enAdditionalTranslations as unknown as TranslationTree;
const zhYoudaoPatch = zhCNYoudaoTranslations as unknown as TranslationTree;
const enYoudaoPatch = enYoudaoTranslations as unknown as TranslationTree;
const zhDownloadNetworkPatch = zhCNDownloadNetworkTranslations as unknown as TranslationTree;
const enDownloadNetworkPatch = enDownloadNetworkTranslations as unknown as TranslationTree;
const zhMiCloudPatch = zhCNMiCloudProgressTranslations as unknown as TranslationTree;
const enMiCloudPatch = enMiCloudProgressTranslations as unknown as TranslationTree;
const zhLargeDocumentPatch = zhCNLargeDocumentTranslations as unknown as TranslationTree;
const enLargeDocumentPatch = enLargeDocumentTranslations as unknown as TranslationTree;
const zhWorkspaceLayoutPatch = zhCNWorkspaceLayoutTranslations as unknown as TranslationTree;
const enWorkspaceLayoutPatch = enWorkspaceLayoutTranslations as unknown as TranslationTree;
const zhSecurityPatch = zhCNSecurityAddonTranslations as unknown as TranslationTree;
const enSecurityPatch = enSecurityAddonTranslations as unknown as TranslationTree;
const zhDiaryMarkdownPatch = zhCNDiaryMarkdownTranslations as unknown as TranslationTree;
const enDiaryMarkdownPatch = enDiaryMarkdownTranslations as unknown as TranslationTree;
const zhEditorSplitPatch = zhCNEditorSplitTranslations as unknown as TranslationTree;
const enEditorSplitPatch = enEditorSplitTranslations as unknown as TranslationTree;
const zhCoveragePatch = zhCNCoverageTranslations as unknown as TranslationTree;
const enCoveragePatch = enCoverageTranslations as unknown as TranslationTree;

const zh = mergePatches(
  zhBase as TranslationTree,
  zhAdditionalPatch,
  zhYoudaoPatch,
  zhDownloadNetworkPatch,
  zhMiCloudPatch,
  zhLargeDocumentPatch,
  zhWorkspaceLayoutPatch,
  zhSecurityPatch,
  zhDiaryMarkdownPatch,
  zhEditorSplitPatch,
  zhCoveragePatch,
);
const en = mergePatches(
  enBase as TranslationTree,
  enAdditionalPatch,
  enYoudaoPatch,
  enDownloadNetworkPatch,
  enMiCloudPatch,
  enLargeDocumentPatch,
  enWorkspaceLayoutPatch,
  enSecurityPatch,
  enDiaryMarkdownPatch,
  enEditorSplitPatch,
  enCoveragePatch,
);

const criticalNamespaces = [
  "editorError",
  "workspaceMembers",
  "attachmentDetail",
  "settings.versionCompare",
  "dataManager.sync",
  "dataManager.desktopData",
] as const;

function expectPatchParity(
  zhPatch: TranslationTree,
  enPatch: TranslationTree,
  namespace: string,
) {
  const zhEntries = leafEntries(getPath(zhPatch, namespace));
  const enEntries = leafEntries(getPath(enPatch, namespace));

  expect(zhEntries.map(([path]) => path)).toEqual(enEntries.map(([path]) => path));

  const enByPath = new Map(enEntries);
  for (const [path, zhValue] of zhEntries) {
    const enValue = enByPath.get(path);
    expect(enValue, `${namespace}.${path} must exist in English`).toBeTypeOf("string");
    expect(interpolationNames(zhValue)).toEqual(interpolationNames(enValue!));
  }
}

describe("release i18n coverage", () => {
  it("keeps the complete runtime translation trees in parity", () => {
    const zhEntries = leafEntries(zh);
    const enEntries = leafEntries(en);
    const zhPaths = zhEntries.map(([path]) => path);
    const enPaths = enEntries.map(([path]) => path);

    expect(zhPaths.filter((path) => !enPaths.includes(path))).toEqual([]);
    expect(enPaths.filter((path) => !zhPaths.includes(path))).toEqual([]);

    const enByPath = new Map(enEntries);
    for (const [path, zhValue] of zhEntries) {
      expect(interpolationNames(zhValue), `${path} interpolation variables`).toEqual(
        interpolationNames(enByPath.get(path)!),
      );
    }

    expect(
      enEntries
        .filter(([path, value]) => path !== "language.zh" && /[\u3400-\u9fff]/u.test(value))
        .map(([path]) => path),
    ).toEqual([]);
  });

  it("defines every literal translation key used by the frontend", () => {
    const keys = literalTranslationKeys(join(process.cwd(), "src"));
    expect(keys.filter((key) => getPath(zh, key) === undefined)).toEqual([]);
    expect(keys.filter((key) => getPath(en, key) === undefined)).toEqual([]);
  });

  it.each(criticalNamespaces)("keeps %s key and interpolation parity", (namespace) => {
    expectPatchParity(zhAdditionalPatch, enAdditionalPatch, namespace);
  });

  it("keeps Youdao import translation parity", () => {
    expectPatchParity(zhYoudaoPatch, enYoudaoPatch, "youdaoImport");
  });

  it("keeps download translation parity", () => {
    expectPatchParity(zhDownloadNetworkPatch, enDownloadNetworkPatch, "download");
  });

  it("keeps Mi Cloud progress translation parity", () => {
    expectPatchParity(zhMiCloudPatch, enMiCloudPatch, "miCloud");
  });

  it("keeps large-document translation parity", () => {
    expectPatchParity(zhLargeDocumentPatch, enLargeDocumentPatch, "markdown.largeDocument");
  });

  it("keeps workspace layout translation parity", () => {
    expectPatchParity(zhWorkspaceLayoutPatch, enWorkspaceLayoutPatch, "workspaceLayout");
  });

  it("keeps security settings addon translation parity", () => {
    expectPatchParity(zhSecurityPatch, enSecurityPatch, "securitySettings");
  });

  it("keeps diary Markdown translation parity", () => {
    expectPatchParity(zhDiaryMarkdownPatch, enDiaryMarkdownPatch, "diary");
  });

  it("keeps editor split translation parity", () => {
    expectPatchParity(zhEditorSplitPatch, enEditorSplitPatch, "editorTabs");
  });

  it("keeps coverage translation parity", () => {
    expect(leafEntries(zhCoveragePatch).map(([path]) => path)).toEqual(
      leafEntries(enCoveragePatch).map(([path]) => path),
    );
  });

  it("defines the complete LAN discovery key set in both languages", () => {
    for (const key of [
      "lanDiscoveryTitle",
      "lanUnavailable",
      "lanNotFound",
      "lanRescan",
      "lanScanning",
      "lanUseThis",
    ]) {
      expect(getPath(zh, `server.${key}`), `zh-CN server.${key}`).toBeTypeOf("string");
      expect(getPath(en, `server.${key}`), `en server.${key}`).toBeTypeOf("string");
    }
  });

  it("patches the known sidebar locale drift in both directions", () => {
    for (const key of [
      "emptyTrash",
      "emptyTrashConfirmTitle",
      "emptyTrashConfirm",
      "emptyTrashSuccess",
      "emptyTrashSkipped",
      "emptyTrashEmpty",
      "emptyTrashFailed",
      "taskCount",
      "taskCount_plural",
    ]) {
      expect(getPath(zh, `sidebar.${key}`), `zh-CN sidebar.${key}`).toBeTypeOf("string");
      expect(getPath(en, `sidebar.${key}`), `en sidebar.${key}`).toBeTypeOf("string");
    }
  });

  it("defines realtime note deletion notices in both languages", () => {
    expect(getPath(zh, "noteList.noteMovedToTrash")).toBe("该笔记已被移入回收站");
    expect(getPath(en, "noteList.noteMovedToTrash")).toBe("This note was moved to Trash");
    expect(getPath(zh, "noteList.noteDeleted")).toBe("该笔记已被删除");
    expect(getPath(en, "noteList.noteDeleted")).toBe("This note was deleted");
  });
});
