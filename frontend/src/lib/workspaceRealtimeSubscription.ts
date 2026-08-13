import { realtime } from "@/lib/realtime";

const WORKSPACE_KEY = "nowen-current-workspace";
const WORKSPACE_CHANGED_EVENT = "nowen:workspace-changed";
let installed = false;
let activeRoom: string | null = null;
let removeOpenListener: (() => void) | null = null;

function resolveWorkspaceRoom(): string | null {
  try {
    const workspaceId = localStorage.getItem(WORKSPACE_KEY) || "personal";
    return workspaceId === "personal" ? null : `workspace:${workspaceId}`;
  } catch {
    return null;
  }
}

function syncWorkspaceRoom(): void {
  const nextRoom = resolveWorkspaceRoom();
  if (activeRoom === nextRoom) {
    if (nextRoom) realtime.subscribe(nextRoom);
    return;
  }
  if (activeRoom) realtime.unsubscribe(activeRoom);
  activeRoom = nextRoom;
  if (activeRoom) realtime.subscribe(activeRoom);
}

/**
 * 跟踪当前工作区并维护对应 WebSocket room 订阅。
 * RealtimeClient 会在断线重连后自动重放 subscribedRooms，因此这里仅负责
 * personal/workspace 切换与跨标签页 storage 同步。
 */
export function installWorkspaceRealtimeSubscription(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  syncWorkspaceRoom();
  removeOpenListener = realtime.on("open", syncWorkspaceRoom);
  window.addEventListener(WORKSPACE_CHANGED_EVENT, syncWorkspaceRoom);
  window.addEventListener("storage", (event) => {
    if (event.key === WORKSPACE_KEY) syncWorkspaceRoom();
  });
}

export function getActiveWorkspaceRealtimeRoom(): string | null {
  return activeRoom;
}

export function resetWorkspaceRealtimeSubscriptionForTests(): void {
  if (activeRoom) realtime.unsubscribe(activeRoom);
  activeRoom = null;
  removeOpenListener?.();
  removeOpenListener = null;
  installed = false;
}
