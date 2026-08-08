// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

import {
  hasPersistentNoteAttachmentReference,
  primeNoteAttachmentAccess,
} from "@/lib/noteAttachmentAccessPriming";
import {
  resetAttachmentAccessStateForTests,
  resolveAttachmentAccessUrl,
} from "@/lib/noteAttachmentAccessBridge";

const ATTACHMENT_A = "123e4567-e89b-42d3-a456-426614174216";
const ATTACHMENT_B = "223e4567-e89b-42d3-a456-426614174217";

function signedUrl(id: string, sig: string): string {
  return `/api/attachments/${id}?exp=2000000000&sig=${sig}&scope=v2.scope`;
}

describe("noteAttachmentAccessPriming", () => {
  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    localStorage.clear();
    window.history.replaceState({}, "", "/notes/test");
  });

  it("Case 1/5: detects persisted attachment references in Tiptap, Markdown and legacy absolute URLs", () => {
    expect(hasPersistentNoteAttachmentReference(JSON.stringify({
      type: "image",
      attrs: { src: `/api/attachments/${ATTACHMENT_A}` },
    }))).toBe(true);
    expect(hasPersistentNoteAttachmentReference(`![image](/api/attachments/${ATTACHMENT_A})`)).toBe(true);
    expect(hasPersistentNoteAttachmentReference(
      `http://127.0.0.1:3001/api/attachments/${ATTACHMENT_A}`,
    )).toBe(true);
    expect(hasPersistentNoteAttachmentReference("blob:http://localhost/transient-preview")).toBe(false);
  });

  it("Case 1/5: primes signed access before a persisted raw attachment reference is rendered", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      noteId: "note-1",
      urls: { [ATTACHMENT_A]: signedUrl(ATTACHMENT_A, "signed-a") },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const persistentSrc = `/api/attachments/${ATTACHMENT_A}`;
    const registered = await primeNoteAttachmentAccess("note-1", "https://notes.example.com/api", {
      token: "jwt-token",
      fetchImpl,
    });

    expect(registered).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0];
    expect(requestUrl).toBe("https://notes.example.com/api/attachments/access/urls?noteId=note-1");
    expect(requestInit?.headers).toEqual({ Authorization: "Bearer jwt-token" });

    const resolved = new URL(resolveAttachmentAccessUrl(persistentSrc));
    expect(resolved.origin).toBe("https://notes.example.com");
    expect(resolved.pathname).toBe(`/api/attachments/${ATTACHMENT_A}`);
    expect(resolved.searchParams.get("sig")).toBe("signed-a");
    // The note body stays stable; only the runtime request URL is signed.
    expect(persistentSrc).toBe(`/api/attachments/${ATTACHMENT_A}`);
  });

  it("Case 3: primes all images in a note without converting their persisted references", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      urls: {
        [ATTACHMENT_A]: signedUrl(ATTACHMENT_A, "signed-a"),
        [ATTACHMENT_B]: signedUrl(ATTACHMENT_B, "signed-b"),
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const registered = await primeNoteAttachmentAccess("note-many", "/api", {
      token: "jwt-token",
      fetchImpl,
    });

    expect(registered).toBe(2);
    expect(resolveAttachmentAccessUrl(`/api/attachments/${ATTACHMENT_A}`)).toContain("sig=signed-a");
    expect(resolveAttachmentAccessUrl(`/api/attachments/${ATTACHMENT_B}`)).toContain("sig=signed-b");
  });

  it("does not issue an access request when no authenticated session is available", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response());
    await expect(primeNoteAttachmentAccess("note-1", "/api", {
      token: null,
      fetchImpl,
    })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
