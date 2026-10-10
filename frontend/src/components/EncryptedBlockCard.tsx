import { useState } from "react";
import { readEncryptedBlock, ENCRYPTED_BLOCK_LANGUAGE } from "@/lib/encryptedNotes/blockDocument";
import EncryptedBlockDialog from "./EncryptedBlockDialog";

type Commit = (source: string) => void | Promise<void>;
export default function EncryptedBlockCard({ source, onCommit, onEdit, language = ENCRYPTED_BLOCK_LANGUAGE }: { source: string; language?: string; onCommit?: Commit; onEdit?: () => void }) {
  // Freeze the source and its write guard for this session. Remote edits cannot retarget a private draft.
  const [session, setSession] = useState<{ source: string; commit?: Commit } | null>(null);
  const [error, setError] = useState("");
  let valid = false;
  try { readEncryptedBlock(source, language); valid = true; } catch { /* unsupported regions stay opaque */ }
  return <div contentEditable={false} className="my-2 rounded-lg border border-app-border bg-app-surface p-3" aria-label="已锁定加密区域">
    <button type="button" aria-label="解锁加密内容" disabled={!valid} className="w-full text-left text-sm text-accent-primary" onClick={() => {
      try { setError(""); if (onEdit) onEdit(); else setSession({ source, commit: onCommit }); }
      catch { setError("内容已更新，请稍后重试。"); }
    }}>🔒 加密内容</button>
    {!valid && <p role="alert">此内容暂时无法打开，请更新应用后重试。</p>}
    {error && <p role="alert">{error}</p>}
    {session && <EncryptedBlockDialog source={session.source} onCommit={session.commit ? async (next) => { await session.commit!(next); setSession(null); } : undefined} onClose={() => setSession(null)} />}
  </div>;
}
