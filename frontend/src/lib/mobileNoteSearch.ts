export const OPEN_COMMAND_PALETTE_EVENT = "nowen:open-command-palette";

/**
 * Close the mobile navigation drawer before opening global note search.
 * Deferring the event to the next task lets the drawer unmount first, avoiding
 * focus and soft-keyboard contention on Android while the palette input mounts.
 */
export function openMobileNoteSearch(
  closeSidebar: () => void,
  target: Window = window,
): void {
  closeSidebar();
  target.setTimeout(() => {
    target.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
  }, 0);
}
