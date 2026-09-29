// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildNoteAppPath,
  buildNoteDeepLinkUrl,
  getCurrentNoteAppRoute,
  parseNoteAppPath,
  pushNoteAppPath,
  replaceNoteAppPath,
} from "@/lib/noteDeepLink";

const NOTE_ID = "123e4567-e89b-42d3-a456-426614174216";
const ONBOARDING_MARKDOWN_ID = "onboarding-v1-user-42-zh-welcome";

describe("noteDeepLink", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("parses UUID and opaque note resource ids used by real note data", () => {
    expect(parseNoteAppPath(`/notes/${NOTE_ID}`)).toEqual({
      matched: true,
      noteId: NOTE_ID,
    });
    expect(parseNoteAppPath(`/notes/${NOTE_ID}/`)).toEqual({
      matched: true,
      noteId: NOTE_ID,
    });
    expect(parseNoteAppPath(`/notes/${ONBOARDING_MARKDOWN_ID}`)).toEqual({
      matched: true,
      noteId: ONBOARDING_MARKDOWN_ID,
    });
    expect(parseNoteAppPath("/mindmaps/123")).toEqual({
      matched: false,
      noteId: null,
    });
  });

  it("publishes push/replace navigation through the shared app path layer", () => {
    pushNoteAppPath(NOTE_ID);
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);
    expect(getCurrentNoteAppRoute().noteId).toBe(NOTE_ID);

    window.history.replaceState(null, "", "/");
    replaceNoteAppPath(NOTE_ID);
    expect(window.location.pathname).toBe(`/notes/${NOTE_ID}`);
  });

  it("builds a copyable absolute deep link on the web", () => {
    expect(
      buildNoteDeepLinkUrl(NOTE_ID, "https://notes.example.com/"),
    ).toBe(`https://notes.example.com/notes/${NOTE_ID}`);
  });

  it("keeps Electron file routes inside nowenAppPath instead of inventing a file path", () => {
    const url = new URL(buildNoteDeepLinkUrl(
      NOTE_ID,
      "file:///opt/nowen/index.html",
    ));
    expect(url.protocol).toBe("file:");
    expect(url.pathname).toBe("/opt/nowen/index.html");
    expect(url.searchParams.get("nowenAppPath")).toBe(`/notes/${NOTE_ID}`);
  });

  it("builds routes for deterministic onboarding Markdown ids", () => {
    expect(buildNoteAppPath(ONBOARDING_MARKDOWN_ID))
      .toBe(`/notes/${ONBOARDING_MARKDOWN_ID}`);
  });

  it("rejects only path-unsafe or empty note ids", () => {
    expect(buildNoteAppPath("")).toBe("/");
    expect(buildNoteAppPath("..")).toBe("/");
    expect(buildNoteAppPath("bad/id")).toBe("/");
    expect(buildNoteAppPath("bad\\id")).toBe("/");
  });
});
