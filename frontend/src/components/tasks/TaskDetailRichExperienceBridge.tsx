import React, { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "@/lib/api";
import type { Task } from "@/types";
import TaskDescriptionRichEditor from "./TaskDescriptionRichEditor";
import TaskAttachmentSection from "./TaskAttachmentSection";
import { getDateValue } from "./taskDateUtils";

interface EnhancementRecord {
  panel: HTMLElement;
  host: HTMLDivElement;
  legacyDescription: HTMLElement;
  previousDisplay: string;
  root: Root;
}

const records = new Map<HTMLElement, EnhancementRecord>();
const resolving = new WeakSet<HTMLElement>();

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  // TaskDetailPanel persists description on blur. React maps onBlur to focusout,
  // so preserve the original save path instead of bypassing TaskCenter state.
  queueMicrotask(() => {
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

function taskMatchesDates(task: Task, panel: HTMLElement): boolean {
  const dateInputs = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  if (dateInputs.length < 2) return true;
  const start = dateInputs[0]?.value || "";
  const due = dateInputs[1]?.value || "";
  return getDateValue(task.startDate) === start
    && getDateValue(task.dueDate || task.dueAt) === due;
}

async function resolveTask(
  panel: HTMLElement,
  titleTextarea: HTMLTextAreaElement,
  descriptionTextarea: HTMLTextAreaElement,
): Promise<Task | null> {
  const tasks = await api.getTasks("all");
  const title = titleTextarea.value;
  const description = descriptionTextarea.value;

  const titleMatches = tasks.filter((task) => task.title === title);
  if (titleMatches.length === 1) return titleMatches[0];
  if (titleMatches.length === 0) return null;

  const descriptionMatches = titleMatches.filter((task) => (task.description || "") === description);
  if (descriptionMatches.length === 1) return descriptionMatches[0];

  const pool = descriptionMatches.length > 0 ? descriptionMatches : titleMatches;
  const dateMatches = pool.filter((task) => taskMatchesDates(task, panel));
  return dateMatches.length === 1 ? dateMatches[0] : null;
}

function TaskDetailRichSurface({
  task: initialTask,
  titleTextarea,
  descriptionTextarea,
}: {
  task: Task;
  titleTextarea: HTMLTextAreaElement;
  descriptionTextarea: HTMLTextAreaElement;
}) {
  const [task, setTask] = useState<Task>({
    ...initialTask,
    title: titleTextarea.value,
    description: descriptionTextarea.value,
  });

  useEffect(() => {
    const syncDescription = () => {
      setTask((current) => ({ ...current, description: descriptionTextarea.value }));
    };
    const syncTitle = () => {
      setTask((current) => ({ ...current, title: titleTextarea.value }));
    };
    descriptionTextarea.addEventListener("input", syncDescription);
    titleTextarea.addEventListener("input", syncTitle);
    return () => {
      descriptionTextarea.removeEventListener("input", syncDescription);
      titleTextarea.removeEventListener("input", syncTitle);
    };
  }, [descriptionTextarea, titleTextarea]);

  return (
    <div className="space-y-3" data-task-detail-rich-surface="true">
      <div>
        <div className="mb-1.5 flex items-end justify-between gap-2">
          <div>
            <div className="text-xs uppercase tracking-wider text-tx-tertiary">详情</div>
            <div className="mt-0.5 text-[10px] text-tx-tertiary">富文本编辑 · Markdown 兼容存储</div>
          </div>
          <div className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] text-accent-primary">富文本</div>
        </div>
        <TaskDescriptionRichEditor
          taskId={task.id}
          value={task.description || ""}
          placeholder="补充步骤、备注、验收标准…"
          onSave={(description) => {
            setTask((current) => ({ ...current, description }));
            setNativeTextareaValue(descriptionTextarea, description);
          }}
        />
      </div>
      <TaskAttachmentSection task={task} />
    </div>
  );
}

function findTaskDetailPanels(root: ParentNode = document): Array<{
  panel: HTMLElement;
  titleTextarea: HTMLTextAreaElement;
  descriptionTextarea: HTMLTextAreaElement;
  legacyDescription: HTMLElement;
}> {
  const result: Array<{
    panel: HTMLElement;
    titleTextarea: HTMLTextAreaElement;
    descriptionTextarea: HTMLTextAreaElement;
    legacyDescription: HTMLElement;
  }> = [];

  root.querySelectorAll<HTMLTextAreaElement>("textarea.font-mono").forEach((titleTextarea) => {
    const panel = titleTextarea.closest<HTMLElement>(".h-full.border-l");
    if (!panel || panel.dataset.taskDetailRichEnhanced === "true") return;
    const textareas = Array.from(panel.querySelectorAll<HTMLTextAreaElement>("textarea"));
    const descriptionTextarea = textareas.find((textarea) => textarea !== titleTextarea);
    if (!descriptionTextarea) return;
    const legacyDescription = descriptionTextarea.parentElement;
    if (!(legacyDescription instanceof HTMLElement)) return;
    result.push({ panel, titleTextarea, descriptionTextarea, legacyDescription });
  });
  return result;
}

function cleanupDisconnected(): void {
  Array.from(records.entries()).forEach(([panel, record]) => {
    if (panel.isConnected && record.host.isConnected) return;
    record.root.unmount();
    record.legacyDescription.style.display = record.previousDisplay;
    records.delete(panel);
  });
}

async function enhancePanel(
  panel: HTMLElement,
  titleTextarea: HTMLTextAreaElement,
  descriptionTextarea: HTMLTextAreaElement,
  legacyDescription: HTMLElement,
): Promise<void> {
  if (records.has(panel) || resolving.has(panel) || !panel.isConnected) return;
  resolving.add(panel);
  try {
    const task = await resolveTask(panel, titleTextarea, descriptionTextarea);
    if (!task || !panel.isConnected || records.has(panel)) return;

    const host = document.createElement("div");
    host.dataset.taskDetailRichHost = "true";
    host.className = "min-w-0";
    legacyDescription.insertAdjacentElement("afterend", host);

    const previousDisplay = legacyDescription.style.display;
    legacyDescription.style.display = "none";
    panel.dataset.taskDetailRichEnhanced = "true";

    const root = createRoot(host);
    records.set(panel, { panel, host, legacyDescription, previousDisplay, root });
    root.render(
      <TaskDetailRichSurface
        task={task}
        titleTextarea={titleTextarea}
        descriptionTextarea={descriptionTextarea}
      />,
    );
  } catch (error) {
    console.warn("[tasks] rich detail enhancement unavailable", error);
  } finally {
    resolving.delete(panel);
  }
}

function reconcile(): void {
  cleanupDisconnected();
  for (const candidate of findTaskDetailPanels(document)) {
    void enhancePanel(
      candidate.panel,
      candidate.titleTextarea,
      candidate.descriptionTextarea,
      candidate.legacyDescription,
    );
  }
}

export const TASK_DETAIL_RICH_CSS = `
@media (min-width: 768px) {
  [data-task-detail-rich-enhanced="true"] {
    width: min(520px, 46vw) !important;
    min-width: min(440px, 42vw) !important;
  }
}

[data-task-detail-rich-host] .task-description-prosemirror > *:first-child { margin-top: 0; }
[data-task-detail-rich-host] .task-description-prosemirror > *:last-child { margin-bottom: 0; }
[data-task-detail-rich-host] .task-description-prosemirror p { margin: 0.35rem 0; }
[data-task-detail-rich-host] .task-description-prosemirror h1 { margin: 0.8rem 0 0.4rem; font-size: 1.35rem; line-height: 1.35; font-weight: 700; }
[data-task-detail-rich-host] .task-description-prosemirror h2 { margin: 0.7rem 0 0.35rem; font-size: 1.15rem; line-height: 1.4; font-weight: 700; }
[data-task-detail-rich-host] .task-description-prosemirror h3 { margin: 0.6rem 0 0.3rem; font-size: 1rem; line-height: 1.45; font-weight: 650; }
[data-task-detail-rich-host] .task-description-prosemirror ul:not([data-type="taskList"]) { list-style: disc; padding-left: 1.4rem; margin: 0.4rem 0; }
[data-task-detail-rich-host] .task-description-prosemirror ol { list-style: decimal; padding-left: 1.4rem; margin: 0.4rem 0; }
[data-task-detail-rich-host] .task-description-prosemirror ul[data-type="taskList"] { list-style: none; padding-left: 0; margin: 0.4rem 0; }
[data-task-detail-rich-host] .task-description-prosemirror li[data-type="taskItem"] { display: flex; align-items: flex-start; gap: 0.45rem; }
[data-task-detail-rich-host] .task-description-prosemirror li[data-type="taskItem"] > label { margin-top: 0.12rem; }
[data-task-detail-rich-host] .task-description-prosemirror li[data-type="taskItem"] > div { flex: 1; min-width: 0; }
[data-task-detail-rich-host] .task-description-prosemirror blockquote { border-left: 3px solid var(--color-border, #d1d5db); margin: 0.6rem 0; padding-left: 0.75rem; color: var(--color-text-secondary, #64748b); }
[data-task-detail-rich-host] .task-description-prosemirror pre { overflow-x: auto; border-radius: 8px; background: var(--color-elevated, #f3f4f6); padding: 0.7rem 0.8rem; font-size: 12px; line-height: 1.55; }
[data-task-detail-rich-host] .task-description-prosemirror code { border-radius: 4px; background: var(--color-elevated, #f3f4f6); padding: 0.1rem 0.25rem; font-size: 0.9em; }
[data-task-detail-rich-host] .task-description-prosemirror pre code { background: transparent; padding: 0; }
[data-task-detail-rich-host] .task-description-prosemirror a { color: var(--color-accent-primary, #3b82f6); text-decoration: underline; text-underline-offset: 2px; }
[data-task-detail-rich-host] .task-description-prosemirror table { width: 100%; border-collapse: collapse; margin: 0.6rem 0; table-layout: fixed; }
[data-task-detail-rich-host] .task-description-prosemirror th,
[data-task-detail-rich-host] .task-description-prosemirror td { border: 1px solid var(--color-border, #d1d5db); padding: 0.35rem 0.45rem; vertical-align: top; min-width: 56px; }
[data-task-detail-rich-host] .task-description-prosemirror th { background: var(--color-elevated, #f3f4f6); font-weight: 600; }
[data-task-detail-rich-host] .task-description-prosemirror img { display: block; max-width: 100%; max-height: 320px; object-fit: contain; margin: 0.6rem auto; border-radius: 8px; }
[data-task-detail-rich-host] .task-description-prosemirror p.is-editor-empty:first-child::before { color: var(--color-text-tertiary, #94a3b8); content: attr(data-placeholder); float: left; height: 0; pointer-events: none; }
`;

export default function TaskDetailRichExperienceBridge() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reconcile);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("focus", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("focus", schedule);
      records.forEach((record) => {
        record.root.unmount();
        record.legacyDescription.style.display = record.previousDisplay;
      });
      records.clear();
    };
  }, []);

  return <style data-task-detail-rich-experience="true">{TASK_DETAIL_RICH_CSS}</style>;
}
