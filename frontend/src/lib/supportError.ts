/**
 * The reference can be copied into a GitHub Issue without including a signed
 * URL, note content, backend stack trace or local filesystem paths.
 */
export type SupportError = {
  message: string;
  code?: string;
  reference?: string;
  referenceKind?: "requestId" | "operationId";
};

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const REFERENCE_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export function formatSupportError(error: unknown, fallbackMessage: string): SupportError {
  const data = error !== null && typeof error === "object"
    ? error as { message?: unknown; code?: unknown; requestId?: unknown; operationId?: unknown }
    : null;
  const code = typeof data?.code === "string" && CODE_PATTERN.test(data.code)
    ? data.code : undefined;
  const requestId = typeof data?.requestId === "string" && REFERENCE_PATTERN.test(data.requestId)
    ? data.requestId : undefined;
  const operationId = typeof data?.operationId === "string" && REFERENCE_PATTERN.test(data.operationId)
    ? data.operationId : undefined;
  // In the absence of a classified code, the thrown error may contain SQL,
  // private paths or response bodies. Do not put it in a support notice.
  const safeText = code && typeof data?.message === "string" && data.message.length <= 200
    ? data.message : fallbackMessage;
  return {
    message: safeText,
    ...(code ? { code } : {}),
    ...(requestId
      ? { reference: requestId, referenceKind: "requestId" as const }
      : operationId ? { reference: operationId, referenceKind: "operationId" as const } : {}),
  };
}

export function formatSupportReference(error: SupportError): string | null {
  if (!error.code && !error.reference) return null;
  return [error.code, error.reference].filter(Boolean).join(" · ");
}
