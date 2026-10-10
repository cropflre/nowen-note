/**
 * Chinese personal-task commands are part of the assistant's input grammar,
 * not display strings. Keep them here rather than translating the recognizer:
 * switching the UI locale must not break existing Chinese commands.
 */
export type AiTaskIntent =
  | { kind: "create"; title: string }
  | { kind: "complete"; taskId: string }
  | { kind: "digest"; mode: "morning" | "evening" };

const PERSONAL_TASK_REQUEST = /(?:今天|今日).*(?:待办|任务)|(?:待办|任务).*(?:今天|今日)/;
const TASK_CREATE = /^\/待办[ ]+创建[ ]+(.{1,300})$/;
const TASK_COMPLETE = /^\/待办[ ]+完成[ ]+([a-zA-Z0-9-]+)$/;
const EVENING_REQUEST = /(?:完成|总结|进度|晚上|晚间)/;

export function parseAiTaskIntent(question: string): AiTaskIntent | null {
  const input = question.trim();
  const create = TASK_CREATE.exec(input);
  if (create) return { kind: "create", title: create[1].trim() };

  const complete = TASK_COMPLETE.exec(input);
  if (complete) return { kind: "complete", taskId: complete[1] };

  if (input === "/待办" || PERSONAL_TASK_REQUEST.test(question)) {
    return { kind: "digest", mode: EVENING_REQUEST.test(question) ? "evening" : "morning" };
  }
  return null;
}
