import { getCurrentWorkspace, setCurrentWorkspace } from "./api";
import { pushAppPathState } from "./appPathNavigation";

export const OPEN_NOTIFICATIONS_EVENT = "nowen:open-notifications";
export const NOTIFICATIONS_CHANGED_EVENT = "nowen:notifications-changed";

export function parseIssueAppPath(path: string): { matched: boolean; issueId: string | null } {
  if (/^\/issues\/?$/.test(path)) return { matched: true, issueId: null };
  const match = /^\/issues\/([a-zA-Z0-9-]+)\/?$/.exec(path);
  return { matched: Boolean(match), issueId: match?.[1] ?? null };
}

export function openWorkspaceIssue(issueId: string | null, workspaceId?: string) {
  if (workspaceId && getCurrentWorkspace() !== workspaceId) {
    setCurrentWorkspace(workspaceId);
    window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId } }));
  }
  pushAppPathState(issueId ? `/issues/${encodeURIComponent(issueId)}` : "/issues");
}
