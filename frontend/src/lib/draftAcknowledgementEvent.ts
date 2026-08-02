import type { DraftAcknowledgement } from "@/lib/draftStorage";

export const DRAFT_ACKNOWLEDGED_EVENT = "nowen:draft-acknowledged";

/**
 * Publish an authoritative note body without importing draftStorage at runtime.
 *
 * Block-patch tests deliberately mock draftStorage with only saveDraft/clearDraft. Keeping this
 * event module dependency-free prevents those mocks from breaking the persistence request itself,
 * while the application bootstrap installs the real listener through noteUpdateSerialQueue.
 */
export function publishDraftAcknowledgement(detail: DraftAcknowledgement): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<DraftAcknowledgement>(DRAFT_ACKNOWLEDGED_EVENT, {
    detail,
  }));
}
