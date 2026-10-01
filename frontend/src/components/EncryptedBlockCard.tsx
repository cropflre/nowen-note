import { useState } from "react";
import { copyText } from "@/lib/clipboard";
import { encryptedBlockFence, readEncryptedBlock, ENCRYPTED_BLOCK_LANGUAGE } from "@/lib/encryptedNotes/blockDocument";
import EncryptedBlockDialog from "./EncryptedBlockDialog";

type Commit = (source: string) => void | Promise<void>;
export default function EncryptedBlockCard({ source, onCommit, language = ENCRYPTED_BLOCK_LANGUAGE }: { source: string; language?: string; onCommit?: Commit }) {
  // Freeze the source and its write guard for this session. Remote edits cannot retarget a private draft.
  const [session, setSession] = useState<{ source: string; commit?: Commit } | null>(null);
  let valid = false;
  try { readEncryptedBlock(source, language); valid = true; } catch { /* unsupported regions stay opaque */ }
  return <div contentEditable={false} className="my-2 rounded-lg border border-app-border bg-app-surface p-3" aria-label="已锁定加密区域">
    <span className="mr-3 text-sm">🔒 加密区域</span>
    {!valid && <p role="alert">密文格式无效或不受支持，原区域保持锁定。</p>}
    <button type="button" disabled={!valid} className="mr-3 text-sm text-accent-primary" onClick={() => setSession({ source, commit: onCommit })}>查看加密区域</button>
    <button type="button" disabled={!valid} className="text-sm text-tx-secondary" onClick={() => { try { void copyText(encryptedBlockFence(source)); } catch { /* no invalid clipboard data */ } }}>复制密文</button>
    {session && <EncryptedBlockDialog source={session.source} onCommit={session.commit ? async (next) => { await session.commit!(next); setSession(null); } : undefined} onClose={() => setSession(null)} />}
  </div>;
}
