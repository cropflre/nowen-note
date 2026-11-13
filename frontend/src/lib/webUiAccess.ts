import { getBaseUrl } from "./api.impl";

export async function fetchWebUiEnabled(): Promise<boolean> {
  try {
    const baseUrl = getBaseUrl();
    const res = await fetch(`${baseUrl}/settings`, { cache: "no-store" });
    if (!res.ok) return true;
    const data = await res.json().catch(() => ({}));
    return data?.web_ui_enabled !== "false";
  } catch {
    // 网络/后端异常时不做前端自锁，避免误伤本地开发和临时故障恢复。
    return true;
  }
}
