export type AutomationSource = "user" | "plugin" | "workflow" | "sync" | "system";

export interface NowenEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  apiVersion: 1;
  occurredAt: string;
  actor: { userId: string };
  scope: { type: "personal" | "workspace"; workspaceId?: string };
  resource: { type: string; id: string };
  data: T;
  metadata: {
    source: AutomationSource;
    sourceId?: string;
    correlationId: string;
    causationId?: string;
    depth: number;
    batchId?: string;
    replayedFrom?: string;
    bulkImport?: boolean;
  };
}

export type WorkflowStep =
  | { id: string; type: "action"; pluginId: string; actionId: string; input?: unknown; maxAttempts?: number }
  | { id: string; type: "condition"; if: { left: unknown; operator: string; right?: unknown }; then?: string; else?: string }
  | { id: string; type: "delay"; seconds: number }
  | { id: string; type: "transform"; output: unknown }
  | { id: string; type: "stop"; reason?: string };

export type WorkflowTrigger =
  | { type: "event"; event: string }
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "webhook"; requireSignature?: boolean }
  | { type: "manual" };

export interface WorkflowDefinition {
  version: 1;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  userId: string;
  workspaceId: string | null;
  enabled: number;
  triggerType: WorkflowTrigger["type"];
  triggerConfigJson: string;
  definitionJson: string;
  ignoreSync: number;
  ignoreBulk: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  eventId: string | null;
  userId: string;
  workspaceId: string | null;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string | null;
  finishedAt: string | null;
  resumeAt: string | null;
  currentStep: number;
  errorCode: string | null;
  errorMessage: string | null;
  correlationId: string;
  requiresAttention: number;
  createdAt: string;
}

export interface ExecutionVariables {
  event: NowenEvent;
  steps: Record<string, { output: unknown }>;
  workflow: { id: string; name: string };
  user: { id: string };
  workspace: { id: string | null };
}
