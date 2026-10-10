type SignedAttachmentScope = {
  version?: number;
  kind?: string;
  noteId?: string;
};

function decodeBase64Url(value: string): string | null {
  if (typeof atob !== "function") return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return null;
  }
}

/**
 * Signed attachment scopes are intentionally self-describing (`v2.<base64url-json>`).
 * Reading noteId client-side does not grant authority; it only tells the client which authenticated
 * `/attachments/access/urls?noteId=...` endpoint to call when an already-issued media URL fails.
 * The server still re-checks ACL before issuing a replacement signature.
 */
export function extractNoteIdFromSignedAttachmentUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  let url: URL;
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    url = new URL(value, base);
  } catch {
    return null;
  }

  const scope = url.searchParams.get("scope") || "";
  if (!scope.startsWith("v2.")) return null;
  const decoded = decodeBase64Url(scope.slice(3));
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as SignedAttachmentScope;
    if (parsed.version !== 2) return null;
    if (parsed.kind !== "user" && parsed.kind !== "share" && parsed.kind !== "publication") return null;
    const noteId = typeof parsed.noteId === "string" ? parsed.noteId.trim() : "";
    if (!noteId || noteId.length > 256) return null;
    return noteId;
  } catch {
    return null;
  }
}
