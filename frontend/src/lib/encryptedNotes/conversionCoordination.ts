// The draft key is global across accounts, so the lock must be global per note too.
export const conversionLockName = (noteId: string) => `nowen-encrypted-conversion:v1:${encodeURIComponent(noteId)}`;
// Legacy queues are also global. Serialize cleanup against replay in any window.
export const CONVERSION_REPLAY_LOCK = "nowen-encrypted-conversion-replay:v1";

export class ConversionCleanupError extends Error {
  constructor(readonly code: "unavailable" | "busy" | "scope_changed" | "not_committed" | "pending_writes" | "storage_failed" | "invalid_consent" | "converted_note") {
    super(code); // Never copy storage contents or server error bodies into an error.
  }
}

/** Hold before mounting an ordinary editor, release only after unmounting it. */
export function holdConversionEditorLease(noteId: string, ready: () => void, failed: () => void): () => void {
  const controller = new AbortController();
  let released = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  void navigator.locks.request(conversionLockName(noteId), { mode: "shared", signal: controller.signal }, async () => {
    if (!released) ready();
    await held;
  }).catch(() => { if (!released) failed(); });
  return () => { released = true; controller.abort(); release(); };
}

/** No forced takeover, timeout-based success, or unlocked storage fallback. */
export async function withConversionCleanupLease<T>(noteId: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new ConversionCleanupError("unavailable");
  return navigator.locks.request(conversionLockName(noteId), { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new ConversionCleanupError("busy");
    return navigator.locks.request(CONVERSION_REPLAY_LOCK, { mode: "exclusive", ifAvailable: true }, async (replayLock) => {
      if (!replayLock) throw new ConversionCleanupError("busy");
      return operation();
    });
  });
}
