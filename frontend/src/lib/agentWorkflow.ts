import type { TaskCandidate } from "./taskComposerApi";

export interface AgentWorkflow {
  id: string; notebookId: string; workspaceId: string | null; status: string;
  createdAt: string; updatedAt: string; errorCode: string | null;
  steps: Array<{ sequence: number; toolName: string; status: string }>;
  sources?: Array<{ id: string; title: string; version: number }>;
  actions: Array<{ kind: "note" | "tasks"; status: string; resourceIds: string[]; errorCode: string | null }>;
  preview?: {
    summary: string; note?: { title: string; content: string };
    tasks?: { previewId: string; timezone: string; warnings: string[]; tasks: Omit<TaskCandidate, "selected" | "allowDuplicate">[] };
    sources: Array<{ id: string; title: string; version: number }>;
    contextTruncated: boolean; linkNoteId: string | null; token?: string;
  };
}
export interface AgentWorkflowInput {
  notebookId: string; includeChildren: boolean; instruction: string;
  lang: "zh-CN" | "en"; timezone: string; linkNoteId?: string;
}
export const workflowActive = (run: AgentWorkflow | null) => !!run && ["queued", "running", "waiting_approval", "applying"].includes(run.status);
