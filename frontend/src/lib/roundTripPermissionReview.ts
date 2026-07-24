import type { RoundTripPermissionInspection } from "./roundTripImportReview";

export interface RoundTripPermissionReviewDecision {
  applyPermissions: boolean;
  permissionMappings: Record<string, string>;
}

export interface RoundTripPermissionReviewRequest {
  id: number;
  inspection: RoundTripPermissionInspection;
}

type Listener = (requests: RoundTripPermissionReviewRequest[]) => void;

let sequence = 1;
let requests: RoundTripPermissionReviewRequest[] = [];
const listeners = new Set<Listener>();
const resolvers = new Map<number, (decision: RoundTripPermissionReviewDecision) => void>();

function emit(): void {
  const snapshot = requests.slice();
  for (const listener of listeners) listener(snapshot);
}

export function suggestedPermissionMappings(
  inspection: RoundTripPermissionInspection,
): Record<string, string> {
  return Object.fromEntries(
    inspection.principals
      .filter((principal) => principal.suggestedTarget?.id)
      .map((principal) => [principal.sourceUserId, principal.suggestedTarget!.id]),
  );
}

export function requestRoundTripPermissionReview(
  inspection: RoundTripPermissionInspection | undefined,
): Promise<RoundTripPermissionReviewDecision> {
  if (!inspection?.included) {
    return Promise.resolve({ applyPermissions: false, permissionMappings: {} });
  }
  const id = sequence++;
  requests = [...requests, { id, inspection }];
  emit();
  return new Promise((resolve) => {
    resolvers.set(id, resolve);
  });
}

export function resolveRoundTripPermissionReview(
  id: number,
  decision: RoundTripPermissionReviewDecision,
): void {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  requests = requests.filter((request) => request.id !== id);
  emit();
  resolve?.(decision);
}

export function subscribeRoundTripPermissionReviews(listener: Listener): () => void {
  listeners.add(listener);
  listener(requests.slice());
  return () => listeners.delete(listener);
}

export const roundTripPermissionReviewTestUtils = {
  reset(): void {
    for (const resolve of resolvers.values()) {
      resolve({ applyPermissions: false, permissionMappings: {} });
    }
    resolvers.clear();
    requests = [];
    sequence = 1;
    emit();
  },
};
