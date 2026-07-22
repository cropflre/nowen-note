import {
  executeNoteTransfer,
  type NoteTransferRequest,
  type NoteTransferResult,
  NoteTransferError,
} from "./noteTransfer.js";

function normalizedIds(input: NoteTransferRequest): string[] {
  return Array.from(new Set(
    input.sourceNoteIds.map((id) => String(id || "").trim()).filter(Boolean),
  ));
}

/**
 * Moving is destructive on the source side, so every selected note must carry the version
 * returned by the immediately preceding preview. An empty or partial object must not silently
 * fall back to the server's current versions, otherwise callers can bypass the confirmation step.
 */
function assertCompleteMovePreview(input: NoteTransferRequest): void {
  if (input.mode !== "move") return;
  const missing = normalizedIds(input).filter(
    (id) => !Number.isFinite(input.expectedVersions?.[id]),
  );
  if (missing.length === 0) return;
  throw new NoteTransferError(
    "TRANSFER_PREVIEW_REQUIRED",
    "移动前必须重新预检，并提交所有源笔记的版本号",
    409,
    { missingExpectedVersions: missing },
  );
}

export async function executeNoteTransferSafe(
  input: NoteTransferRequest,
): Promise<NoteTransferResult> {
  assertCompleteMovePreview(input);
  return executeNoteTransfer(input);
}
