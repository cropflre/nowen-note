import type { ShareEffectiveStatus, SharePermission } from "@/types";

export function sharePermissionLabel(permission: SharePermission): string {
  if (permission === "comment") return "可评论";
  if (permission === "edit") return "访客可编辑";
  if (permission === "edit_auth") return "登录后可编辑";
  return "仅查看";
}

export function shareStatusMeta(status: ShareEffectiveStatus): { label: string; className: string } {
  switch (status) {
    case "disabled":
      return { label: "已停用", className: "border-zinc-400/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300" };
    case "expired":
      return { label: "已过期", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" };
    case "exhausted":
      return { label: "次数耗尽", className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" };
    default:
      return { label: "正常", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" };
  }
}

export function formatShareDate(value: string | null | undefined): string {
  if (!value) return "无限制";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function compactShareToken(token: string): string {
  if (token.length <= 14) return token;
  return `${token.slice(0, 7)}…${token.slice(-5)}`;
}
