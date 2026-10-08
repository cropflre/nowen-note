import { registerPlugin } from "@capacitor/core";

/** Android plugin provides video caching and local-photo preparation. */
interface AttachmentMediaPlugin {
  prepare(options: { attachmentId: string; url: string }): Promise<{ uri: string; size: number }>;
  preparePhoto(options: { attachmentId: string; uri: string }): Promise<{ uri: string }>;
}

// Both media renderers share one registration. Keep it across Vite HMR module
// evaluations too: Capacitor warns if the same native name is registered twice.
const ATTACHMENT_MEDIA_SLOT = Symbol.for("nowen.nativeAttachmentMediaPlugin");
const plugins = globalThis as unknown as Record<symbol, AttachmentMediaPlugin | undefined>;

export const attachmentMediaPlugin: AttachmentMediaPlugin =
  plugins[ATTACHMENT_MEDIA_SLOT]
  ?? (plugins[ATTACHMENT_MEDIA_SLOT] = registerPlugin<AttachmentMediaPlugin>("AttachmentMedia"));
