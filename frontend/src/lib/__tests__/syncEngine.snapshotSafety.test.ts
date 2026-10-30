// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

// Exercise syncNow's real snapshot orchestration, not a source-text assertion.
// The cached entities are deliberately absent from a successful remote listing.
const mocks = vi.hoisted(() => ({
  getNotebooks: vi.fn(async () => []),
  getNotes: vi.fn(async () => []),
  getTags: vi.fn(async () => []),
  getAllNotebooks: vi.fn(async () => [{ id: "cached-notebook", workspaceId: null }]),
  getAllNotes: vi.fn(async () => []),
  getAllTags: vi.fn(async () => [{ id: "cached-tag", workspaceId: null }]),
  deleteNotebook: vi.fn(async () => {}),
  deleteTag: vi.fn(async () => {}),
  putNotebooks: vi.fn(async () => {}),
  putNoteListItems: vi.fn(async () => {}),
  putTags: vi.fn(async () => {}),
  setMeta: vi.fn(async () => {}),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getNotebooks: mocks.getNotebooks,
    getNotes: mocks.getNotes,
    getTags: mocks.getTags,
  },
  getCurrentWorkspace: () => "personal",
}));

vi.mock("@/lib/localStore", () => ({
  setCurrentUser: vi.fn(),
  getAllNotebooks: mocks.getAllNotebooks,
  getAllNotes: mocks.getAllNotes,
  getAllTags: mocks.getAllTags,
  deleteNotebook: mocks.deleteNotebook,
  deleteTag: mocks.deleteTag,
  putNotebooks: mocks.putNotebooks,
  putNoteListItems: mocks.putNoteListItems,
  putTags: mocks.putTags,
  setMeta: mocks.setMeta,
  getMeta: vi.fn(async () => undefined),
  isReady: vi.fn(() => true),
  putNote: vi.fn(async () => {}),
}));

vi.mock("@/lib/offlineQueue", () => ({
  flushQueue: vi.fn(async () => {}),
  discardNoteQueueItems: vi.fn(),
  getFailedQueueItems: vi.fn(() => []),
  getQueue: vi.fn(() => []),
  getQueueLength: vi.fn(() => 0),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock("@/lib/offlineQueueFetch", () => ({ offlineQueueFetch: vi.fn() }));
vi.mock("@/lib/conflictResolution", () => ({
  resolveQueuedNoteConflicts: vi.fn(async () => ({ attempted: 0, resolved: 0, failed: 0 })),
}));

import { syncNow } from "@/lib/syncEngine";

describe("syncEngine snapshot deletion safety", () => {
  it("does not delete local notebooks or tags missing from a remote listing", async () => {
    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(mocks.getNotebooks).toHaveBeenCalledOnce();
    expect(mocks.getTags).toHaveBeenCalledOnce();
    expect(mocks.putNotebooks).toHaveBeenCalledWith([]);
    expect(mocks.putTags).toHaveBeenCalledWith([]);
    expect(mocks.deleteNotebook).not.toHaveBeenCalled();
    expect(mocks.deleteTag).not.toHaveBeenCalled();
  });
});
