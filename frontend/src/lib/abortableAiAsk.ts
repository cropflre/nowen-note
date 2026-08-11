function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function isAiAskRequest(input: RequestInfo | URL): boolean {
  const url = requestUrl(input);
  return url.includes("/ai/ask") || url.includes("/user-preferences/ai-reliable/ask");
}

/**
 * The legacy and reliable AI clients expose the same high-level `api.aiAsk`
 * function but do not yet accept an AbortSignal. Scope a temporary fetch wrapper
 * to the two streaming ask endpoints so the chat UI can cancel either backend
 * without changing unrelated requests running at the same time.
 */
export async function withAbortableAiFetch<T>(
  controller: AbortController,
  run: () => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const wrappedFetch: typeof fetch = (input, init) => {
    if (!isAiAskRequest(input)) return previousFetch.call(globalThis, input, init);
    return previousFetch.call(globalThis, input, {
      ...init,
      signal: controller.signal,
    });
  };

  globalThis.fetch = wrappedFetch;
  try {
    return await run();
  } finally {
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = previousFetch;
  }
}
