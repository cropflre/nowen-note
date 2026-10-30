// The draft key is global across accounts, so the lock must be global per note too.
export const conversionLockName = (noteId: string) => `nowen-encrypted-conversion:v1:${encodeURIComponent(noteId)}`;
// Legacy queues are also global. Serialize cleanup against replay in any window.
export const CONVERSION_REPLAY_LOCK = "nowen-encrypted-conversion-replay:v1";
export interface ConversionLease { readonly noteId: string }
const activeLeases = new WeakSet<ConversionLease>();
export function withHeldConversionLease<T>(lease: ConversionLease, noteId: string, operation: () => Promise<T>): Promise<T> {
  if (lease.noteId !== noteId || !activeLeases.has(lease)) throw new ConversionCleanupError("busy");
  return operation();
}

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

/** Queue behind short-lived readers/writers; an editor still open after the wait stays protected. */
async function withExclusiveLock<T>(name: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 5_000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await navigator.locks.request(name, { mode: "exclusive", signal: controller.signal }, async (lock) => {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort);
      if (!lock) throw new ConversionCleanupError("busy");
      if (signal?.aborted) throw new ConversionCleanupError("scope_changed");
      return operation();
    });
  } catch (error) {
    if (controller.signal.aborted) throw new ConversionCleanupError(signal?.aborted ? "scope_changed" : "busy");
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

/** No forced takeover, timeout-based success, or unlocked storage fallback. */
export async function withConversionCleanupLease<T>(noteId: string, operation: (lease: ConversionLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!navigator.locks?.request) throw new ConversionCleanupError("unavailable");
  return withExclusiveLock(conversionLockName(noteId), async () => {
    return withExclusiveLock(CONVERSION_REPLAY_LOCK, async () => {
      const lease = { noteId }; activeLeases.add(lease);
      try { return await operation(lease); } finally { activeLeases.delete(lease); }
    }, signal);
  }, signal);
}
