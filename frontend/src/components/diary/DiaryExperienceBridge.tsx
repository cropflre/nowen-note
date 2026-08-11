import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import SayMarkdownContent from "@/components/diary/SayMarkdownContent";
import SayMarkdownToolbar, {
  type SayMarkdownMode,
} from "@/components/diary/SayMarkdownToolbar";
import DiaryAiReportDialog from "@/components/diary/DiaryAiReportDialog";

interface DiaryExperienceBridgeProps {
  rootRef: React.RefObject<HTMLDivElement | null>;
}

interface EnhancerRecord {
  host: HTMLDivElement;
  root: Root;
}

interface PreviousInlineStyle {
  position: string;
  zIndex: string;
  overflow: string;
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function isDiaryTextarea(textarea: HTMLTextAreaElement): boolean {
  return textarea.classList.contains("min-h-[52px]")
    && !textarea.closest('[data-diary-ai-report="true"]')
    && !textarea.dataset.nowenDiaryEnhanced;
}

function DiaryTextareaEnhancer({ textarea }: { textarea: HTMLTextAreaElement }) {
  const [value, setValue] = useState(textarea.value);
  const [mode, setMode] = useState<SayMarkdownMode>("write");
  const textareaRef = useMemo<React.RefObject<HTMLTextAreaElement>>(
    () => ({ current: textarea }),
    [textarea],
  );
  const previousDisplayRef = useRef(textarea.style.display);

  useEffect(() => {
    const handleInput = () => setValue(textarea.value);
    const forceWrite = (event: Event) => {
      const target = (event as CustomEvent<{ textarea?: HTMLTextAreaElement }>).detail?.textarea;
      if (target === textarea) setMode("write");
    };
    textarea.addEventListener("input", handleInput);
    window.addEventListener("nowen:diary-force-write", forceWrite);
    return () => {
      textarea.removeEventListener("input", handleInput);
      window.removeEventListener("nowen:diary-force-write", forceWrite);
    };
  }, [textarea]);

  useEffect(() => {
    textarea.style.display = mode === "preview"
      ? "none"
      : previousDisplayRef.current;
    return () => {
      textarea.style.display = previousDisplayRef.current;
    };
  }, [mode, textarea]);

  const updateValue = useCallback((next: string) => {
    setValue(next);
    setNativeTextareaValue(textarea, next);
  }, [textarea]);

  return (
    <div className="nowen-diary-markdown-enhancer">
      {mode === "preview" && (
        <div className="min-h-[52px] rounded-lg bg-app-bg/40 px-3 py-2">
          {value.trim() ? (
            <SayMarkdownContent content={value} />
          ) : (
            <span className="text-sm text-tx-tertiary">Markdown 预览</span>
          )}
        </div>
      )}
      <SayMarkdownToolbar
        textareaRef={textareaRef}
        value={value}
        onChange={updateValue}
        mode={mode}
        onModeChange={setMode}
      />
    </div>
  );
}

function restoreElevatedLayers(
  records: Map<HTMLElement, PreviousInlineStyle>,
): void {
  records.forEach((previous, element) => {
    element.style.position = previous.position;
    element.style.zIndex = previous.zIndex;
    element.style.overflow = previous.overflow;
  });
  records.clear();
}

function elevateOpenDiaryPopovers(
  root: HTMLElement,
  records: Map<HTMLElement, PreviousInlineStyle>,
): void {
  const next = new Set<HTMLElement>();
  root.querySelectorAll<HTMLElement>(".absolute").forEach((panel) => {
    const isFloatingPanel = panel.classList.contains("top-full")
      || panel.classList.contains("bottom-full");
    if (!isFloatingPanel || panel.getClientRects().length === 0) return;

    let current = panel.parentElement;
    while (current && current !== root) {
      next.add(current);
      current = current.parentElement;
    }
  });

  Array.from(records.entries()).forEach(([element, previous]) => {
    if (next.has(element)) return;
    element.style.position = previous.position;
    element.style.zIndex = previous.zIndex;
    element.style.overflow = previous.overflow;
    records.delete(element);
  });

  next.forEach((element) => {
    if (!records.has(element)) {
      records.set(element, {
        position: element.style.position,
        zIndex: element.style.zIndex,
        overflow: element.style.overflow,
      });
    }
    if (getComputedStyle(element).position === "static" && element.style.position !== "relative") {
      element.style.position = "relative";
    }
    if (element.style.zIndex !== "120") element.style.zIndex = "120";
    if (element.style.overflow !== "visible") element.style.overflow = "visible";
  });
}

function markDiaryResponsiveRegions(container: HTMLElement): void {
  const heading = container.querySelector("h1");
  const header = heading?.closest<HTMLElement>(".justify-between");
  if (header) {
    header.dataset.diarySectionHeader = "true";
    if (header.parentElement) header.parentElement.dataset.diaryContent = "true";
  }

  const searchInput = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
  ).find((candidate) => !candidate.closest('[data-diary-ai-report="true"]'));

  if (searchInput?.parentElement) {
    const search = searchInput.parentElement;
    search.dataset.diarySearch = "true";

    const mediaRow = search.parentElement;
    if (mediaRow) {
      mediaRow.dataset.diaryMediaFilters = "true";
      mediaRow.parentElement?.setAttribute("data-diary-filters", "true");

      const timeRow = mediaRow.previousElementSibling;
      if (timeRow instanceof HTMLElement) {
        timeRow.dataset.diaryTimeFilters = "true";
        if (timeRow.firstElementChild instanceof HTMLElement) {
          timeRow.firstElementChild.dataset.diaryTimeScroller = "true";
        }
      }

      const mediaSegment = Array.from(mediaRow.children).find((child) => {
        return child instanceof HTMLElement
          && child !== search
          && child.tagName === "DIV"
          && child.querySelectorAll(":scope > button").length >= 4;
      });
      if (mediaSegment instanceof HTMLElement) {
        mediaSegment.dataset.diaryMediaSegment = "true";
      }
    }
  }

  container
    .querySelectorAll<HTMLTextAreaElement>('textarea[data-nowen-diary-enhanced="true"]')
    .forEach((textarea) => {
      const shell = textarea.closest<HTMLElement>(".rounded-2xl");
      if (!shell) return;
      shell.dataset.diaryEditorShell = "true";
      shell.dataset.diaryEditorKind = textarea.autofocus ? "edit" : "compose";

      const actionBar = Array.from(shell.children).find((child) => {
        return child instanceof HTMLElement && child.classList.contains("justify-between");
      });
      if (actionBar instanceof HTMLElement) {
        actionBar.dataset.diaryEditorActions = "true";
      }
    });

  container.querySelectorAll<HTMLElement>(".group").forEach((group) => {
    const card = group.firstElementChild;
    const body = card?.firstElementChild;
    if (!(card instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
    if (!card.classList.contains("rounded-xl")) return;
    if (!card.querySelector(".markdown-body, img, video")) return;

    group.dataset.diaryCard = "true";
    body.dataset.diaryCardBody = "true";
    if (group.parentElement) group.parentElement.dataset.diaryDayItems = "true";

    const actionRow = Array.from(body.children).find((child) => {
      return child instanceof HTMLElement && child.classList.contains("border-t");
    });
    if (actionRow instanceof HTMLElement) {
      actionRow.dataset.diaryCardActions = "true";
    }
  });
}

export default function DiaryExperienceBridge({
  rootRef,
}: DiaryExperienceBridgeProps) {
  const { t } = useTranslation();
  const enhancersRef = useRef(new Map<HTMLTextAreaElement, EnhancerRecord>());
  const elevatedRef = useRef(new Map<HTMLElement, PreviousInlineStyle>());
  const reportButtonHostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [reportButtonHost, setReportButtonHost] = useState<HTMLDivElement | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const syncEnhancements = useCallback(() => {
    const container = rootRef.current;
    if (!container) return;

    container.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((textarea) => {
      if (!isDiaryTextarea(textarea)) return;
      textarea.dataset.nowenDiaryEnhanced = "true";
      const host = document.createElement("div");
      host.dataset.nowenDiaryEnhancerHost = "true";
      textarea.insertAdjacentElement("afterend", host);
      const root = createRoot(host);
      root.render(<DiaryTextareaEnhancer textarea={textarea} />);
      enhancersRef.current.set(textarea, { host, root });
    });

    Array.from(enhancersRef.current.entries()).forEach(([textarea, record]) => {
      if (textarea.isConnected && record.host.isConnected) return;
      textarea.removeAttribute("data-nowen-diary-enhanced");
      record.root.unmount();
      record.host.remove();
      enhancersRef.current.delete(textarea);
    });

    markDiaryResponsiveRegions(container);

    if (!reportButtonHostRef.current?.isConnected) {
      const heading = container.querySelector("h1");
      const header = heading?.closest<HTMLElement>(".justify-between");
      if (header) {
        const host = document.createElement("div");
        host.dataset.nowenDiaryReportButton = "true";
        header.appendChild(host);
        reportButtonHostRef.current = host;
        setReportButtonHost(host);
      }
    }

    elevateOpenDiaryPopovers(container, elevatedRef.current);
  }, [rootRef]);

  const scheduleSync = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncEnhancements();
    });
  }, [syncEnhancements]);

  useEffect(() => {
    const container = rootRef.current;
    if (!container) return;
    syncEnhancements();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      enhancersRef.current.forEach((record, textarea) => {
        textarea.removeAttribute("data-nowen-diary-enhanced");
        record.root.unmount();
        record.host.remove();
      });
      enhancersRef.current.clear();
      restoreElevatedLayers(elevatedRef.current);
      reportButtonHostRef.current?.remove();
      reportButtonHostRef.current = null;
    };
  }, [rootRef, scheduleSync, syncEnhancements]);

  useEffect(() => {
    const handleUseReport = (event: Event) => {
      const content = (event as CustomEvent<{ content?: string }>).detail?.content;
      const container = rootRef.current;
      if (!content || !container) return;
      const textarea = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea"))
        .find((candidate) => candidate.dataset.nowenDiaryEnhanced === "true");
      if (!textarea) return;
      window.dispatchEvent(new CustomEvent("nowen:diary-force-write", {
        detail: { textarea },
      }));
      setNativeTextareaValue(textarea, content);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(content.length, content.length);
        textarea.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    };
    window.addEventListener("nowen:diary-use-report", handleUseReport);
    return () => window.removeEventListener("nowen:diary-use-report", handleUseReport);
  }, [rootRef]);

  return (
    <>
      {reportButtonHost && createPortal(
        <button
          type="button"
          onClick={() => setReportOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-600 transition-all hover:bg-violet-500/20 dark:text-violet-300"
        >
          <Sparkles size={14} />
          <span className="hidden sm:inline">
            {t("diary.aiReportAction", { defaultValue: "AI 总结" })}
          </span>
        </button>,
        reportButtonHost,
      )}
      <DiaryAiReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />
    </>
  );
}
