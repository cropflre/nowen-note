import { describe, expect, it } from "vitest";
import {
  isMatchingTiptapSaveAck,
  isRemoteVersionNewer,
  resolveConfirmedTiptapContent,
  shouldSkipUnchangedTitleOnlyUpdate,
} from "../editorSyncGuards";

describe("editor sync guards", () => {
  it("matches only the exact local REST ACK token", () => {
    const ack = {
      noteId: "note-1",
      version: 3,
      content: "server-confirmed",
      saveGeneration: 7,
      preserveLocalEditor: true,
    };
    const matches = (overrides: Partial<Parameters<typeof isMatchingTiptapSaveAck>[0]> = {}) => (
      isMatchingTiptapSaveAck({
      noteChanged: false,
        noteId: "note-1",
        noteVersion: 3,
        noteContent: "server-confirmed",
        ack,
        ...overrides,
      })
    );

    expect(matches()).toBe(true); // local REST ACK
    expect(matches({ noteContent: "remote-body" })).toBe(false); // remote body update
    expect(matches({ ack: null })).toBe(false); // title-only remote update / WS before REST ACK
    expect(matches({ noteVersion: 4 })).toBe(false); // same body at another remote version
    expect(matches({ ack: { ...ack, version: 2 } })).toBe(false); // stale/retried ACK
    expect(matches({ noteChanged: true, noteId: "note-2" })).toBe(false); // ACK for A after switching to B
    expect(matches({ ack: { ...ack, preserveLocalEditor: false } })).toBe(false); // server normalization
    expect(matches({ ack: { ...ack, saveGeneration: 0 } })).toBe(false); // invalid generation
  });

  it("consumes an ACK once and rejects remote, reordered, duplicate, historical, and cross-note updates", () => {
    const ack = {
      noteId: "note-1",
      version: 11,
      content: "confirmed-body",
      saveGeneration: 4,
      preserveLocalEditor: true,
    };
    let pending: typeof ack | null = ack;
    const consume = (input: Omit<Parameters<typeof isMatchingTiptapSaveAck>[0], "ack">) => {
      const matched = isMatchingTiptapSaveAck({ ...input, ack: pending });
      if (matched) pending = null;
      return matched;
    };
    const exact = {
      noteChanged: false,
      noteId: "note-1",
      noteVersion: 11,
      noteContent: "confirmed-body",
    };

    expect(isMatchingTiptapSaveAck({ ...exact, ack: null })).toBe(false); // WS before REST ACK
    expect(isMatchingTiptapSaveAck({ ...exact, noteContent: "remote-body", ack })).toBe(false);
    expect(isMatchingTiptapSaveAck({ ...exact, noteVersion: 12, ack })).toBe(false); // title/body update or same body at a new version
    expect(isMatchingTiptapSaveAck({ ...exact, noteVersion: 10, ack })).toBe(false); // offline historical broadcast
    expect(isMatchingTiptapSaveAck({ ...exact, noteChanged: true, noteId: "note-2", ack })).toBe(false);
    expect(consume(exact)).toBe(true); // direct REST continuation
    expect(consume(exact)).toBe(false); // duplicate REST ACK or later WS echo
  });

  it("skips unchanged title-only updates", () => {
    expect(
      shouldSkipUnchangedTitleOnlyUpdate("Title", { title: "Title" }),
    ).toBe(true);
  });

  it("keeps only server-confirmed content in activeNote while preserving newer editor input", () => {
    const pending = resolveConfirmedTiptapContent({
      serverContent: "confirmed",
      serverContentText: "confirmed",
      sentContent: "confirmed",
      sentContentText: "confirmed",
      editorSnapshot: { content: "newer-local", contentText: "newer-local" },
      fallbackContentText: "old",
    });
    expect(pending).toEqual({
      content: "confirmed",
      contentText: "confirmed",
      preserveLocalEditor: true,
    });
    expect(pending.content).not.toBe("newer-local");

    const normalized = resolveConfirmedTiptapContent({
      serverContent: "server-normalized",
      serverContentText: "server normalized",
      sentContent: "client-json",
      sentContentText: "client",
      editorSnapshot: { content: "client-json", contentText: "client" },
      fallbackContentText: "old",
    });
    expect(normalized.preserveLocalEditor).toBe(false);
    expect(normalized.content).toBe("server-normalized");

    const normalizedWithNewerInput = resolveConfirmedTiptapContent({
      serverContent: "server-normalized",
      serverContentText: "server normalized",
      sentContent: "client-json",
      sentContentText: "client",
      editorSnapshot: { content: "newer-local", contentText: "newer local" },
      fallbackContentText: "old",
    });
    expect(normalizedWithNewerInput).toEqual({
      content: "server-normalized",
      contentText: "server normalized",
      preserveLocalEditor: true,
    });
  });

  it("does not skip content saves or real title changes", () => {
    expect(
      shouldSkipUnchangedTitleOnlyUpdate("Title", {
        title: "Title",
        content: "body",
        contentText: "body",
      }),
    ).toBe(false);
    expect(
      shouldSkipUnchangedTitleOnlyUpdate("Title", { title: "New title" }),
    ).toBe(false);
  });

  it("detects newer remote versions for the active note only", () => {
    const current = { id: "note-1", version: 2 };

    expect(isRemoteVersionNewer(current, { noteId: "note-1", version: 3 })).toBe(true);
    expect(isRemoteVersionNewer(current, { id: "note-1", version: 3 })).toBe(true);
    expect(isRemoteVersionNewer(current, { noteId: "note-1", version: 2 })).toBe(false);
    expect(isRemoteVersionNewer(current, { noteId: "note-2", version: 4 })).toBe(false);
  });
});
