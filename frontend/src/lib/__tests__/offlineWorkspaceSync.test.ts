import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isOfflineAttachmentWanted,
  normalizeOfflineSyncSettings,
} from "../offlineWorkspaceSync";

describe("complete offline workspace settings", () => {
  it("deduplicates selected workspaces and clamps the polling interval", () => {
    const settings = normalizeOfflineSyncSettings({
      enabled: true,
      workspaceMode: "selected",
      workspaceIds: ["a", "b", "a", ""],
      attachmentMode: "all",
      wifiOnly: false,
      maxAttachmentBytes: 0,
      intervalMinutes: 0,
      paused: false,
    });

    expect(settings.workspaceIds).toEqual(["a", "b"]);
    expect(settings.intervalMinutes).toBe(1);
    expect(settings.maxAttachmentBytes).toBe(0);
  });

  it("keeps every note body independent from the attachment download mode", () => {
    const image = { mimeType: "image/png" } as any;
    const pdf = { mimeType: "application/pdf" } as any;

    expect(isOfflineAttachmentWanted(image, normalizeOfflineSyncSettings({ attachmentMode: "all" }))).toBe(true);
    expect(isOfflineAttachmentWanted(pdf, normalizeOfflineSyncSettings({ attachmentMode: "all" }))).toBe(true);
    expect(isOfflineAttachmentWanted(image, normalizeOfflineSyncSettings({ attachmentMode: "images" }))).toBe(true);
    expect(isOfflineAttachmentWanted(pdf, normalizeOfflineSyncSettings({ attachmentMode: "images" }))).toBe(false);
    expect(isOfflineAttachmentWanted(image, normalizeOfflineSyncSettings({ attachmentMode: "none" }))).toBe(false);
  });

  it("syncs the knowledge tree before note data", () => {
    const source = readFileSync("src/lib/offlineWorkspaceSync.ts", "utf8");
    const syncTarget = source.slice(source.indexOf("async function syncTarget("));
    const knowledgeTreeSync = syncTarget.indexOf("`/knowledge-tree/?${scopeQuery(target.workspaceId)}`");
    const notebookSync = syncTarget.indexOf("await putCompleteOfflineNotebooks(plan.notebooks);");

    expect(knowledgeTreeSync).toBeGreaterThan(-1);
    expect(notebookSync).toBeGreaterThan(knowledgeTreeSync);
  });
});
