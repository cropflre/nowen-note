import { openDB } from "idb";
import type { RecordedVoice } from "./voiceRecorder";

export interface VoiceMemoAttachment {
  attachmentId: string;
  src: string;
  filename: string;
  mimeType: string;
  size: number;
  durationMs: number;
}
export interface VoiceMemoDraft {
  id: string;
  scope: string;
  noteId: string;
  createdAt: number;
  mimeType: string;
  durationMs: number;
  blob: Blob;
  status: "recorded" | "upload-failed";
  attachment?: VoiceMemoAttachment;
}

const database = () => openDB("nowen-voice-memo-drafts", 1, { upgrade(db) { db.createObjectStore("drafts", { keyPath: "id" }); } });
export const voiceMemoDraftStore = {
  async put(draft: VoiceMemoDraft) { const db = await database(); try { await db.put("drafts", draft); } finally { db.close(); } },
  async list(scope: string): Promise<VoiceMemoDraft[]> { const db = await database(); try { return (await db.getAll("drafts") as VoiceMemoDraft[]).filter((draft) => draft.scope === scope).sort((a, b) => a.createdAt - b.createdAt); } finally { db.close(); } },
  async remove(id: string) { const db = await database(); try { await db.delete("drafts", id); } finally { db.close(); } },
};

export function createVoiceMemoDraft(scope: string, noteId: string, voice: RecordedVoice): VoiceMemoDraft {
  return { id: crypto.randomUUID(), scope, noteId, createdAt: Date.now(), mimeType: voice.mimeType, durationMs: voice.durationMs, blob: voice.blob, status: "recorded" };
}
