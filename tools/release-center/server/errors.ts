export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: string,
  ) {
    super(message);
  }
}

export function redact(value: string, secrets: string[] = []): string {
  let text = value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  for (const secret of secrets.filter(Boolean))
    text = text.split(secret).join("[REDACTED]");
  return text
    .replace(
      /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,
      "[REDACTED]",
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer|token)?\s*)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[REDACTED]@")
    .replace(
      /([?&](?:sig|signature|x-amz-signature|x-goog-signature)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}

// Redact string leaves before serialization, preserving durable JSON syntax.
export function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, secrets),
      ]),
    );
  return value;
}
