/**
 * PushPlus webhook-only JSON presentation for personal task reminders.
 *
 * PushPlus supports POST /send/{token}?template=json and renders the request
 * body as the message content. Never put the token in the payload or change
 * the destination URL. Generic Webhooks must retain their original contract.
 */
export type DigestPushEvent = "task.digest.morning" | "task.digest.evening" | "task.due";

export function isPushPlusJsonWebhook(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
    if (!["pushplus.plus", "www.pushplus.plus", "api.pushplus.plus"].includes(url.hostname.toLowerCase())) return false;
    const tokenInPath = /^\/send\/[^/]+\/?$/.test(url.pathname);
    const tokenInQuery = /^\/send\/?$/.test(url.pathname) && !!url.searchParams.get("token");
    return (tokenInPath || tokenInQuery) && url.searchParams.get("template")?.toLowerCase() === "json";
  } catch {
    return false;
  }
}

function taskCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function displayTime(timestamp: string, timezone: unknown): string {
  // The webhook timestamp already has a local UTC offset. Do not add +8h again.
  const cleanTime = timestamp.replace("T", " ").replace(/\.\d{3}/, "");
  const zone = typeof timezone === "string" && timezone ? timezone : "UTC";
  return `${cleanTime}（${zone}）`;
}

function dueTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未设置";
  return value.replace("T", " ").slice(0, 25);
}

/** Localized PushPlus JSON body; intentionally excludes user IDs, task IDs and tokens. */
export function formatPushPlusTaskEvent(
  event: DigestPushEvent,
  timestamp: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const isTest = data.test === true;
  const time = displayTime(timestamp, data.timezone);
  if (event === "task.due") {
    return {
      "标题": `任务到点提醒${isTest ? "（测试）" : ""}`,
      "推送时间": time,
      "任务名称": typeof data.title === "string" ? data.title.slice(0, 200) : "未命名任务",
      "截止时间": dueTime(data.dueAt),
    };
  }

  const morning = event === "task.digest.morning";
  const counts = data.counts && typeof data.counts === "object" && !Array.isArray(data.counts)
    ? data.counts as Record<string, unknown> : {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const taskTitles = tasks.slice(0, 8).map((task: unknown) => {
    if (!task || typeof task !== "object" || !("title" in task)) return "";
    const title = (task as { title: unknown }).title;
    return typeof title === "string" ? title.trim().slice(0, 200) : "";
  }).filter(Boolean);

  return {
    "标题": `每日任务简报 · ${morning ? "早间计划" : "晚间总结"}${isTest ? "（测试）" : ""}`,
    "日期": typeof data.date === "string" ? data.date : timestamp.slice(0, 10),
    "推送时间": time,
    "今日概览": typeof data.summary === "string" ? data.summary : "",
    "任务统计": {
      "今日到期": taskCount(counts.dueToday),
      "今日待完成": taskCount(counts.pendingToday),
      "今日到期已完成": taskCount(counts.completedDueToday),
      "今日已完成": taskCount(counts.completedToday),
      "逾期未完成": taskCount(counts.overdue),
    },
    "重点任务": taskTitles.length > 0 ? taskTitles : "暂无需要关注的任务",
  };
}

/** PushPlus returns an application-level result even for HTTP 200. */
export function isPushPlusAccepted(body: string): boolean {
  try {
    const response: unknown = JSON.parse(body);
    return response !== null && typeof response === "object"
      && "code" in response && (response as { code?: unknown }).code === 200;
  } catch {
    return false;
  }
}
