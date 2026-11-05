import { htmlToMarkdown } from "../lib/transform";
import type { CapturePreview } from "./types";

/** Background-only normalization preserves the standalone classic content.js build. */
export async function normalizePreview(preview: CapturePreview): Promise<CapturePreview> {
  const messages = await Promise.all(preview.snapshot.messages.map(async ({ capturedHtml, ...message }) => {
    const text = capturedHtml === undefined ? message.text : htmlToMarkdown(capturedHtml).trim();
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const contentHash = Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
    return { ...message, text, blocks: [{ type: "markdown" as const, text }], contentHash };
  }));
  return { ...preview, snapshot: { ...preview.snapshot, messages } };
}
