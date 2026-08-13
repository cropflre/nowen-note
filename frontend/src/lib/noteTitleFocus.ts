const NEW_NOTE_TITLE_FOCUS_TTL_MS = 30_000;

let nextRequestId = 0;
let pendingRequest: { id: number; expiresAt: number } | null = null;

/**
 * Mark the next newly opened note as wanting title focus.
 *
 * The request is intentionally short-lived: the create flow can pause on the notebook picker,
 * but a cancelled flow must not make an unrelated note steal focus much later.
 */
export function requestNewNoteTitleFocus(): number {
  const id = ++nextRequestId;
  pendingRequest = {
    id,
    expiresAt: Date.now() + NEW_NOTE_TITLE_FOCUS_TTL_MS,
  };
  return id;
}

/** Cancel the request only when it is still the same create attempt. */
export function cancelNewNoteTitleFocus(requestId: number): void {
  if (pendingRequest?.id === requestId) pendingRequest = null;
}

/** Consume the one-shot focus request when the newly created note becomes active. */
export function consumeNewNoteTitleFocus(): boolean {
  if (!pendingRequest) return false;
  if (pendingRequest.expiresAt < Date.now()) {
    pendingRequest = null;
    return false;
  }
  pendingRequest = null;
  return true;
}
