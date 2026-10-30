export const REPO = "cropflre/nowen-note";
export const WORKFLOW = "release-center-debug.yml";
export const PLATFORMS = ["windows", "macos", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];
export interface PlanInput {
  branch: string;
  version: string;
  channel: "stable" | "prerelease";
  platforms: Platform[];
  notes: string;
}
export interface Check {
  name: string;
  status: "pass" | "fail" | "unknown";
  detail: string;
}
export interface Plan extends PlanInput {
  id: string;
  sha: string;
  createdAt: string;
  checks: Check[];
  ready: boolean;
  debugReady: boolean;
  workflowRef: string;
  workflowSha: string;
  effects: string[];
}
export type TaskState =
  | "queued"
  | "running"
  | "reconciling"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; status: string; conclusion: string | null }[];
}
export interface Artifact {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  expired: boolean;
  verification: "not_downloaded";
}
export interface VerifiedFile {
  name: string;
  architecture: string;
  size: number;
  sha256: string;
  updaterMetadata: boolean;
}
export interface Verification {
  artifactId: number;
  platform: Platform;
  archiveDigest: string;
  verifiedAt: string;
  metadata: string[];
  files: VerifiedFile[];
}
export interface Task {
  id: string;
  key: string;
  mode: "dry-run" | "debug" | "verify" | "publication";
  plan: Plan;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  deadline: number;
  runId?: number;
  dispatchedAt?: string;
  cancelReason?: "cancelled" | "timed_out";
  jobs: Job[];
  artifacts: Artifact[];
  error?: string;
  sourceTaskId?: string;
  verifications?: Verification[];
  publication?: {
    candidateId: string;
    operation: "verify" | "draft" | "publish";
    intent?: { kind: "draft" | "asset" | "publish"; name?: string };
    retryAt?: number;
  };
  acceptance?: {
    at: string;
    digest: string;
    scope: "debug-only";
    actor: "local-maintainer";
  };
}
export interface Audit {
  seq: number;
  taskId: string | null;
  at: string;
  event: string;
  detail: string;
}
export interface Release {
  id: number;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  url: string;
  assets: { name: string; size: number; digest: string | null }[];
}
export interface Run {
  id: number;
  title: string;
  workflow: string;
  sha: string;
  status: string;
  conclusion: string | null;
  url: string;
  event: string;
}
export interface Overview {
  repo: string;
  branch: string;
  localSha: string;
  localVersion: string;
  dirty: boolean;
  tokenConfigured: boolean;
  debugEnabled: boolean;
  releases: Release[];
  branches: string[];
  runs: Run[];
  githubError?: string;
  tasks: Task[];
}

export const CHANNELS = ["microsoft-store", "docker-hub", "nas"] as const;
export type ChannelId = (typeof CHANNELS)[number];
export type ChannelState = "available" | "pending" | "not_found" | "not_configured" | "unknown" | "error";
export interface ChannelObservation {
  channel: ChannelId;
  version: string;
  at: string;
  state: ChannelState;
  summary: string;
  details: string[];
  url: string;
  // Provider metadata is observed evidence, never a content-validation result.
  evidence: Record<string, unknown>;
}
export interface DistributionAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  contentVerified: false;
}
export interface DistributionSource {
  releaseId: number;
  tag: string;
  sha: string;
  url: string;
  publishedAt: string;
  assets: DistributionAsset[];
}
export interface ChannelHandoff {
  channel: ChannelId;
  target: string;
  blockers: string[];
  instructions: string[];
  assets: DistributionAsset[];
  metadata: Record<string, unknown>;
}
export interface DistributionPlan {
  id: string;
  version: string;
  createdAt: string;
  source: DistributionSource;
  handoffs: ChannelHandoff[];
  executable: false;
  approval: "not_connected";
}
export const RECEIPT_STATES = ["submitted", "reviewing", "published", "rejected", "withdrawn"] as const;
export interface DistributionReceipt {
  id: string;
  planId: string;
  channel: ChannelId;
  version: string;
  sha: string;
  at: string;
  status: (typeof RECEIPT_STATES)[number];
  reference: string;
  evidenceUrl: string;
  notes: string;
  source: "maintainer-report";
  verifiedByProvider: false;
}
export interface ChannelView {
  version: string;
  observations: ChannelObservation[];
  history: ChannelObservation[];
  plans: DistributionPlan[];
  receipts: DistributionReceipt[];
  formalDistribution: false;
}

export interface ReleaseCandidate {
  id: string;
  version: string;
  tag: string;
  sha: string;
  runId: number;
  runAttempt: number;
  notes: string;
  createdAt: string;
  state: "verifying" | "verified" | "drafting" | "draft" | "approved" | "publishing" | "published" | "failed" | "blocked";
  artifacts: Artifact[];
  verifications: Verification[];
  digest?: string;
  draftId?: number;
  authorId?: number;
  approval?: { at: string; actorId: number; login: string; digest: string };
  error?: string;
}
export interface PublicationView {
  candidates: ReleaseCandidate[];
  draftsEnabled: boolean;
  publishEnabled: boolean;
  buildDispatchEnabled: false;
}
