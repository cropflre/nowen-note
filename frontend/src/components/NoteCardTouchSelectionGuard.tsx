import { useEffect } from "react";
import {
  MOBILE_NOTE_CARD_TOUCH_RELEASE_DELAY_MS,
  getNoteCardSelectionRoot,
  shouldSuppressNoteCardSelection,
} from "@/components/MobileDrawerUxBridge";

/**
 * 手机长按笔记卡片时不触发原生选字（逻辑原样移自 MobileDrawerUxBridge）。
 *
 * 必须常驻挂载：MobileDrawerUxBridge 只挂在命令面板里，而构建里命令面板是关闭时不渲染的
 * 懒加载壳（vite.config.ts 的 LazyCommandPaletteRuntime 别名），这段守卫因此一直没生效。
 */
export default function NoteCardTouchSelectionGuard() {
  useEffect(() => {
    // Android/iOS browsers may begin a native text selection just before dispatching the
    // long-press contextmenu event. NoteList deliberately does not preventDefault touchstart/
    // touchmove because those events also power scrolling, pull-to-refresh and touch sorting.
    // Instead, remember only the card that received the current touch and cancel `selectstart`
    // for that card. Mouse selection on desktop remains untouched.
    let activeTouchCard: HTMLElement | null = null;
    let releaseTimer: number | null = null;

    const clearReleaseTimer = () => {
      if (releaseTimer == null) return;
      window.clearTimeout(releaseTimer);
      releaseTimer = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      clearReleaseTimer();
      activeTouchCard = getNoteCardSelectionRoot(event.target);
    };

    const handleSelectStart = (event: Event) => {
      if (!shouldSuppressNoteCardSelection(event.target, activeTouchCard)) return;
      event.preventDefault();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!shouldSuppressNoteCardSelection(event.target, activeTouchCard)) return;
      // Defensive cleanup for WebViews that created a range before honoring selectstart.
      window.getSelection()?.removeAllRanges();
    };

    const scheduleTouchRelease = () => {
      clearReleaseTimer();
      releaseTimer = window.setTimeout(() => {
        activeTouchCard = null;
        releaseTimer = null;
      }, MOBILE_NOTE_CARD_TOUCH_RELEASE_DELAY_MS);
    };

    document.addEventListener("touchstart", handleTouchStart, true);
    document.addEventListener("selectstart", handleSelectStart, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("touchend", scheduleTouchRelease, true);
    document.addEventListener("touchcancel", scheduleTouchRelease, true);

    return () => {
      document.removeEventListener("touchstart", handleTouchStart, true);
      document.removeEventListener("selectstart", handleSelectStart, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("touchend", scheduleTouchRelease, true);
      document.removeEventListener("touchcancel", scheduleTouchRelease, true);
      clearReleaseTimer();
    };
  }, []);

  return null;
}
