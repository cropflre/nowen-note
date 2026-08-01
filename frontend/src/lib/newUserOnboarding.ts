import { api, getCurrentWorkspace, getServerUrl } from "@/lib/api";

const ONBOARDING_VERSION = 1;
const MARKER_PREFIX = `nowen:onboarding-welcome-opened:v${ONBOARDING_VERSION}`;
const OPEN_NOTE_EVENT = "nowen:open-note-link";

export type OnboardingOpenResult =
  | "opened"
  | "already-handled"
  | "not-seeded"
  | "skipped";

export function onboardingWelcomeNoteId(userId: string): string {
  return `onboarding-v${ONBOARDING_VERSION}-${userId}-zh-welcome`;
}

function markerKey(userId: string): string {
  let server = getServerUrl();
  if (!server && typeof window !== "undefined") {
    server = window.location.origin || "same-origin";
  }
  const normalizedServer = (server || "same-origin").replace(/\/+$/, "").toLowerCase();
  return `${MARKER_PREFIX}:${encodeURIComponent(normalizedServer)}:${userId}`;
}

function hasMarker(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeMarker(key: string, result: "opened" | "not-seeded"): void {
  try {
    localStorage.setItem(key, JSON.stringify({ result, at: Date.now() }));
  } catch {
    // Disabled storage must not block login or synchronization.
  }
}

function dispatchWelcomeOpen(noteId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, {
    detail: {
      noteId,
      blockId: null,
      href: `/notes/${noteId}`,
      redirected: false,
    },
  }));
}

/**
 * Opens the deterministic Chinese welcome note after the first successful
 * personal-space snapshot.
 *
 * Old accounts deliberately do not receive the guide. Their one expected 404 is
 * stored locally so subsequent logins do not repeat it. Network failures are not
 * marked and can be retried on a later bootstrap.
 */
export async function openSeededOnboardingIfNeeded(
  userId: string,
): Promise<OnboardingOpenResult> {
  if (typeof window === "undefined" || getCurrentWorkspace() !== "personal") {
    return "skipped";
  }

  const key = markerKey(userId);
  if (hasMarker(key)) return "already-handled";

  const noteId = onboardingWelcomeNoteId(userId);
  try {
    await api.getNoteSlim(noteId);
  } catch (error) {
    if ((error as { status?: number })?.status === 404) {
      writeMarker(key, "not-seeded");
      return "not-seeded";
    }
    throw error;
  }

  // AppLayout's existing internal-note subscriber owns fetching and selecting
  // the note. Queue one task so child effects are mounted before the event fires.
  window.setTimeout(() => dispatchWelcomeOpen(noteId), 0);
  writeMarker(key, "opened");
  return "opened";
}
