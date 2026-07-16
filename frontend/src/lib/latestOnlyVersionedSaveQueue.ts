export interface VersionedSaveResult {
  version: number;
}

export interface VersionedSaveEnvelope<TPayload, TResult extends VersionedSaveResult> {
  noteId: string;
  baseVersion: number;
  payload: TPayload;
  result: TResult;
}

interface SaveWaiter<TPayload, TResult extends VersionedSaveResult> {
  resolve: (value: VersionedSaveEnvelope<TPayload, TResult>) => void;
  reject: (reason: unknown) => void;
}

interface PendingBatch<TPayload, TResult extends VersionedSaveResult> {
  payload: TPayload;
  waiters: Array<SaveWaiter<TPayload, TResult>>;
}

interface QueueState<TPayload, TResult extends VersionedSaveResult> {
  confirmedVersion: number;
  pending: PendingBatch<TPayload, TResult> | null;
  running: Promise<void> | null;
}

function tagSaveError(error: unknown, baseVersion: number): Error & {
  code?: string;
  saveBaseVersion?: number;
} {
  const tagged = error instanceof Error ? error : new Error(String(error));
  try {
    if ((tagged as any).saveBaseVersion === undefined) {
      (tagged as any).saveBaseVersion = baseVersion;
    }
  } catch {
    // A non-extensible Error can still be rejected safely.
  }
  return tagged as Error & { code?: string; saveBaseVersion?: number };
}

/**
 * Per-key, latest-only versioned write queue.
 *
 * Different keys may run concurrently. For one key, at most one request is in flight;
 * later payloads are merged into one pending snapshot and use the preceding ACK version.
 */
export class LatestOnlyVersionedSaveQueue<TPayload, TResult extends VersionedSaveResult> {
  private readonly states = new Map<string, QueueState<TPayload, TResult>>();

  constructor(
    private readonly send: (key: string, payload: TPayload, version: number) => Promise<TResult>,
    private readonly mergePayload: (previous: TPayload, next: TPayload) => TPayload = (_previous, next) => next,
  ) {}

  enqueue(input: {
    key: string;
    baseVersion: number;
    payload: TPayload;
  }): Promise<VersionedSaveEnvelope<TPayload, TResult>> {
    let state = this.states.get(input.key);
    if (!state) {
      state = { confirmedVersion: input.baseVersion, pending: null, running: null };
      this.states.set(input.key, state);
    } else if (!state.running && !state.pending) {
      state.confirmedVersion = Math.max(state.confirmedVersion, input.baseVersion);
    }

    return new Promise((resolve, reject) => {
      const waiter: SaveWaiter<TPayload, TResult> = { resolve, reject };
      if (state!.pending) {
        state!.pending.payload = this.mergePayload(state!.pending.payload, input.payload);
        state!.pending.waiters.push(waiter);
      } else {
        state!.pending = { payload: input.payload, waiters: [waiter] };
      }
      this.start(input.key, state!);
    });
  }

  getConfirmedVersion(key: string): number | undefined {
    return this.states.get(key)?.confirmedVersion;
  }

  private start(key: string, state: QueueState<TPayload, TResult>): void {
    if (state.running) return;
    state.running = this.drain(key, state).finally(() => {
      state.running = null;
      if (state.pending) this.start(key, state);
    });
  }

  private readPending(state: QueueState<TPayload, TResult>): PendingBatch<TPayload, TResult> | null {
    return state.pending;
  }

  private rejectBatch(batch: PendingBatch<TPayload, TResult>, error: unknown, baseVersion: number): void {
    const tagged = tagSaveError(error, baseVersion);
    for (const waiter of batch.waiters) waiter.reject(tagged);
  }

  private async drain(key: string, state: QueueState<TPayload, TResult>): Promise<void> {
    while (state.pending) {
      const batch = state.pending;
      state.pending = null;
      const baseVersion = state.confirmedVersion;

      let result: TResult;
      try {
        result = await this.send(key, batch.payload, baseVersion);
      } catch (error) {
        this.rejectBatch(batch, error, baseVersion);
        const pending = this.readPending(state);
        if (pending) {
          this.rejectBatch(pending, error, baseVersion);
          state.pending = null;
        }
        return;
      }

      if (!Number.isFinite(result.version) || result.version <= baseVersion) {
        const error = new Error("Server did not confirm a newer version") as Error & {
          code?: string;
          saveBaseVersion?: number;
        };
        error.code = "SAVE_NOT_CONFIRMED";
        error.saveBaseVersion = baseVersion;
        this.rejectBatch(batch, error, baseVersion);
        const pending = this.readPending(state);
        if (pending) {
          this.rejectBatch(pending, error, baseVersion);
          state.pending = null;
        }
        return;
      }

      state.confirmedVersion = result.version;
      const pending = this.readPending(state);
      if (pending) {
        pending.waiters.unshift(...batch.waiters);
        continue;
      }

      const envelope: VersionedSaveEnvelope<TPayload, TResult> = {
        noteId: key,
        baseVersion,
        payload: batch.payload,
        result,
      };
      for (const waiter of batch.waiters) waiter.resolve(envelope);
    }
  }
}
