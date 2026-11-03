// Session rules are shared by all clips, including clips downloading the same CDN URL.
// Serialize the download phase so one clip cannot replace or clean up another's Referer.
const RULE_ID = 910_000;
let pending: Promise<void> = Promise.resolve();

export function withImageReferer<T>(
  pageUrl: string,
  urls: string[],
  download: (referer: string) => Promise<T>,
): Promise<T> {
  const task = pending.then(async () => {
    const api = globalThis.chrome?.declarativeNetRequest;
    if (!api?.updateSessionRules) return download("");

    let referer = "";
    try {
      const page = new URL(pageUrl);
      if (page.protocol === "https:" || page.protocol === "http:") referer = `${page.origin}/`;
    } catch {
      // No usable page origin: leave the request's original no-referrer policy in place.
    }

    // URLs have already passed validateRemoteImageUrl; domain conditions exclude ports.
    const hosts = [...new Set(urls.map((url) => new URL(url).hostname))];
    const rules: chrome.declarativeNetRequest.Rule[] = referer && hosts.length ? [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: api.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [{ header: "referer", operation: api.HeaderOperation.SET, value: referer }],
      },
      condition: {
        requestDomains: hosts,
        initiatorDomains: [new URL(chrome.runtime.getURL("/")).hostname],
        tabIds: [-1],
        resourceTypes: [api.ResourceType.XMLHTTPREQUEST],
      },
    }] : [];

    try {
      // Also discard an abandoned rule after a worker restart or failed cleanup.
      await api.updateSessionRules({ removeRuleIds: [RULE_ID], addRules: rules });
    } catch (error) {
      console.warn("[nowen-clipper image-localizer] 安装 Referer 规则失败:", error);
      return download("");
    }

    try {
      return await download(rules.length ? referer : "");
    } finally {
      if (rules.length) {
        try {
          await api.updateSessionRules({ removeRuleIds: [RULE_ID] });
        } catch (error) {
          console.warn("[nowen-clipper image-localizer] 清理 Referer 规则失败:", error);
        }
      }
    }
  });
  pending = task.then(() => undefined, () => undefined);
  return task;
}
