/**
 * UrlValidator - 服务器地址校验工具
 */

/** 校验服务器地址是否合法 */
export function isValidServerUrl(url: string): boolean {
  if (!url || url.trim().length === 0) {
    return false;
  }
  const trimmed = url.trim();
  // 必须以 http:// 或 https:// 开头
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return false;
  }
  try {
    // ArkTS 没有 URL 构造器，用正则校验基本格式
    const pattern = /^https?:\/\/[a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
    return pattern.test(trimmed);
  } catch {
    return false;
  }
}

/** 规范化服务器地址：去尾部斜杠 */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 从用户输入构建完整 URL（自动补 scheme） */
export function buildServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // 已有 scheme
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return normalizeServerUrl(trimmed);
  }

  // 纯 IP 或域名 → 默认 http
  return normalizeServerUrl(`http://${trimmed}`);
}
