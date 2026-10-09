import { EncryptedContentError } from "./envelope";

let running = false;
/** Shared by one-shot operations and session opens; updates do not run a KDF. */
export function acquireKdfSlot(): () => void {
  if (running) throw new EncryptedContentError("busy");
  running = true;
  let released = false;
  return () => { if (!released) { released = true; running = false; } };
}
