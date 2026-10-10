const INITIAL_LOAD_RETRY_DELAYS_MS = [600, 1_200] as const;

function isRetryableLoadError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;

  return Number.isNaN(status) || status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function loadKnowledgeTreeOnEntry<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      const retryDelay = INITIAL_LOAD_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isRetryableLoadError(error)) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelay));
    }
  }
}
