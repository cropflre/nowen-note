import { useEffect } from "react";

const HEADING_COPY = {
  zh: "向量检索（Embedding）",
  en: "Vector search (Embedding)",
};

const COPY = {
  zh: {
    oldQueue: "任务队列",
    queue: "索引任务",
    pendingPattern: /待处理\s+(\d+)/,
    statusPattern: /(?:待处理|等待)\s+\d+/,
    pendingReplacement: "等待 $1",
    oldHint: "索引在后台异步执行；失败任务可通过重新构建索引再次处理。",
    help: "AI 助手会在后台为笔记和附件建立搜索索引，不是待办事项或聊天排队，也不会修改笔记原文。",
    blocked: "向量引擎不可用，等待中的索引任务暂时不会开始处理。配置并测试可用的 Embedding 模型后，可重新构建索引。",
    unavailable: "不可用",
  },
  en: {
    oldQueue: "Queue",
    queue: "Index jobs",
    pendingPattern: /pending\s+(\d+)/i,
    statusPattern: /(?:pending|waiting)\s+\d+/i,
    pendingReplacement: "waiting $1",
    oldHint: "Indexing runs in the background. Failed jobs can be retried by rebuilding the index.",
    help: "The AI assistant builds search indexes for notes and attachments in the background. These are not to-dos or chat requests, and original note content is not changed.",
    blocked: "The vector engine is unavailable, so waiting index jobs will not start yet. Configure and test a working embedding model, then rebuild the index.",
    unavailable: "Unavailable",
  },
};

type LocaleKey = keyof typeof COPY;

function exactTextElement(root: ParentNode, text: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).find((element) => {
    if (element.children.length > 0) return false;
    return (element.textContent || "").trim() === text;
  }) || null;
}

function resolveEmbeddingSection(root: ParentNode): { section: HTMLElement; locale: LocaleKey } | null {
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4"));
  for (const heading of headings) {
    const text = (heading.textContent || "").trim();
    const locale: LocaleKey | null = text === HEADING_COPY.zh ? "zh" : text === HEADING_COPY.en ? "en" : null;
    if (!locale) continue;
    const section = heading.closest<HTMLElement>("section");
    if (section) return { section, locale };
  }
  return null;
}

function extractWaitingCount(text: string, locale: LocaleKey): number {
  const match = text.match(locale === "zh" ? /(?:待处理|等待)\s+(\d+)/ : /(?:pending|waiting)\s+(\d+)/i);
  return match ? Number(match[1]) || 0 : 0;
}

export function applyEmbeddingIndexTaskCopy(root: ParentNode = document): boolean {
  const resolved = resolveEmbeddingSection(root);
  if (!resolved) return false;

  const { section, locale } = resolved;
  const copy = COPY[locale];
  const queueLabel = exactTextElement(section, copy.oldQueue) || exactTextElement(section, copy.queue);
  if (!queueLabel) return false;

  if ((queueLabel.textContent || "").trim() !== copy.queue) queueLabel.textContent = copy.queue;
  const queueCard = queueLabel.parentElement;
  if (!queueCard) return false;

  const queueValue = Array.from(queueCard.querySelectorAll<HTMLElement>("div")).find((element) => {
    const text = (element.textContent || "").trim();
    return element !== queueLabel && copy.statusPattern.test(text);
  }) || null;

  if (queueValue) {
    const current = queueValue.textContent || "";
    const next = current.replace(copy.pendingPattern, copy.pendingReplacement);
    if (next !== current) queueValue.textContent = next;
  }

  const separator = locale === "zh" ? "。" : ". ";
  const ariaLabel = `${copy.queue}${separator}${copy.help}`;
  if (queueCard.title !== copy.help) queueCard.title = copy.help;
  if (queueCard.getAttribute("aria-label") !== ariaLabel) queueCard.setAttribute("aria-label", ariaLabel);
  if (!queueCard.hasAttribute("data-embedding-index-task-card")) queueCard.dataset.embeddingIndexTaskCard = "";

  const vectorUnavailable = Array.from(section.querySelectorAll<HTMLElement>("*")).some((element) => {
    if (element.children.length > 0) return false;
    return (element.textContent || "").trim() === copy.unavailable;
  });
  const waiting = extractWaitingCount(queueValue?.textContent || "", locale);
  const helpText = vectorUnavailable && waiting > 0 ? copy.blocked : copy.help;

  const existingHelp = section.querySelector<HTMLElement>("[data-embedding-index-task-help]");
  const oldHint = exactTextElement(section, copy.oldHint);
  const help = existingHelp || oldHint;
  if (help) {
    if ((help.textContent || "").trim() !== helpText) help.textContent = helpText;
    if (!help.hasAttribute("data-embedding-index-task-help")) help.dataset.embeddingIndexTaskHelp = "";
    if (!help.id) help.id = "embedding-index-task-help";
    if (queueCard.getAttribute("aria-describedby") !== help.id) queueCard.setAttribute("aria-describedby", help.id);
  }

  return true;
}

export default function EmbeddingIndexTaskCopyBridge() {
  useEffect(() => {
    let frame = 0;
    let observedSection: HTMLElement | null = null;
    let sectionObserver: MutationObserver | null = null;

    function refresh() {
      const resolved = resolveEmbeddingSection(document);
      const nextSection = resolved?.section || null;

      if (nextSection !== observedSection) {
        sectionObserver?.disconnect();
        observedSection = nextSection;
        sectionObserver = null;
        if (nextSection) {
          sectionObserver = new MutationObserver(schedule);
          sectionObserver.observe(nextSection, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        }
      }

      if (nextSection) applyEmbeddingIndexTaskCopy(nextSection);
    }

    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    }

    schedule();
    const rootObserver = new MutationObserver(schedule);
    rootObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("nowen:ai-settings-changed", schedule);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      rootObserver.disconnect();
      sectionObserver?.disconnect();
      window.removeEventListener("nowen:ai-settings-changed", schedule);
    };
  }, []);

  return null;
}
