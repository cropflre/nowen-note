/**
 * 图片防盗链兜底：为扩展自身发起的图片下载请求补上页面 Referer。
 *
 * Referer 是浏览器禁止修改的请求头：写进 `fetch(init.headers)` 会被直接丢弃；
 * `RequestInit.referrer` 在跨源时也会被规范钳制，扩展无法声明站点来源。
 * 因此只能在网络层用 `declarativeNetRequest` 的 `modifyHeaders` 改写。
 *
 * 规则按本次待下载图片的域名生成，使用 session 级规则：不写入磁盘、浏览器重启自动清空，
 * 下载结束立即删除，避免长期影响其它页面的同名请求。
 */

/** 单次最多为多少个图片域名生成规则，避免规则数量失控。 */
const MAX_HOSTS = 50;
/** 与项目其它动态规则保持距离的起始 ID。 */
const RULE_ID_BASE = 910_000;

export interface ImageRefererRule {
  ids: number[];
  /** 实际使用的 Referer（页面源），为空表示未安装规则。 */
  referer: string;
}

function originOf(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

function hostsOf(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // 非法地址已在 validateRemoteImageUrl 阶段拦下，这里直接跳过
    }
    if (hosts.size >= MAX_HOSTS) break;
  }
  return Array.from(hosts);
}

export async function installImageRefererRule(
  pageUrl: string,
  urls: string[],
): Promise<ImageRefererRule> {
  const referer = originOf(pageUrl);
  const hosts = hostsOf(urls);
  if (!referer || hosts.length === 0) return { ids: [], referer };
  if (!chrome.declarativeNetRequest?.updateSessionRules) return { ids: [], referer };

  const rules: chrome.declarativeNetRequest.Rule[] = hosts.map((host, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        {
          header: "referer",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: `${referer}/`,
        },
      ],
    },
    condition: {
      requestDomains: [host],
      // fetch() 在 declarativeNetRequest 中归类为 xmlhttprequest
      resourceTypes: [
        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        chrome.declarativeNetRequest.ResourceType.IMAGE,
      ],
    },
  }));

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((rule) => rule.id),
      addRules: rules,
    });
    return { ids: rules.map((rule) => rule.id), referer };
  } catch (error) {
    console.warn("[nowen-clipper image-localizer] 安装 Referer 规则失败:", error);
    return { ids: [], referer };
  }
}

export async function clearImageRefererRule(rule: ImageRefererRule): Promise<void> {
  if (rule.ids.length === 0) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rule.ids });
  } catch (error) {
    console.warn("[nowen-clipper image-localizer] 清理 Referer 规则失败:", error);
  }
}
