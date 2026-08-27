let upstreamFetch: typeof globalThis.fetch | null = null;

/**
 * Capture the fetch transport immediately before the attachment access bridge wraps window.fetch.
 *
 * The captured transport still includes the previously installed Ugreen / Android / Desktop
 * network bridges. It only skips the attachment bridge's note-detail prerequisite wait, so note
 * text can become visible before signed media access preparation finishes.
 */
export function captureAttachmentAccessUpstreamFetch(): typeof globalThis.fetch | null {
  if (upstreamFetch) return upstreamFetch;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return null;
  upstreamFetch = window.fetch.bind(window);
  return upstreamFetch;
}

export function getAttachmentAccessUpstreamFetch(): typeof globalThis.fetch {
  if (upstreamFetch) return upstreamFetch;
  if (typeof window !== "undefined" && typeof window.fetch === "function") {
    return window.fetch.bind(window);
  }
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new Error("Fetch transport is unavailable");
}

/** Test isolation only. */
export function resetAttachmentAccessUpstreamFetchForTests(): void {
  upstreamFetch = null;
}
