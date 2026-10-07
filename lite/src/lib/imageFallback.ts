/**
 * 附件图片的兜底加载。
 *
 * 背景（从服务端日志推出来的事实）：
 *   App 能拿到签名 URL（`access/urls` 一直返回 200），
 *   但服务端日志里**从来没见过对图片本身的请求** → 说明 <img> 的请求
 *   在客户端就被拦掉了，根本没发出去。
 *
 * 而同一页面里的 fetch() 是**通的**（笔记/说说列表都正常加载）——
 * 所以这里用 fetch 兜底：直连失败就自己把图片取回来，转成 blob URL 再塞给 <img>。
 * blob: 是本源地址，不再有任何跨源/混合内容的讲究，必定能显示。
 *
 * ⚠️ 为什么不用 `<img onError>` 就完事：笔记正文是 dangerouslySetInnerHTML 渲染的，
 *    拿不到每个 <img> 的引用 —— 所以用**捕获阶段的 error 监听**（error 不冒泡但会捕获），
 *    挂在正文容器上就能兜住里面所有图片。
 */

/** 已经是 blob/data 的别再兜 */
function isLocal(url: string): boolean {
  return /^(blob:|data:)/i.test(url);
}

const inflight = new Map<string, Promise<string | null>>();

/** 用 fetch 取回图片并转成 blob URL；失败返回 null（不抛） */
export async function fetchAsBlobUrl(url: string): Promise<string | null> {
  if (!url || isLocal(url)) return null;
  const cached = inflight.get(url);
  if (cached) return cached;

  const task = (async () => {
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size) return null;
      return URL.createObjectURL(blob);
    } catch {
      // 网络/跨源/被拦：都当作"兜底失败"，让调用方保留破图
      return null;
    } finally {
      // 同一个 URL 只兜一次，避免失败时反复打接口
      setTimeout(() => inflight.delete(url), 30_000);
    }
  })();

  inflight.set(url, task);
  return task;
}

/**
 * 给 <img> 挂兜底：直连失败时用 fetch 取回来换成 blob URL。
 * 返回 true 表示已经接管（调用方无需再处理）。
 */
export async function retryImageViaFetch(img: HTMLImageElement): Promise<boolean> {
  const original = img.dataset.fallbackFrom || img.src;
  if (!original || isLocal(original)) return false;
  // 只兜一次，避免 blob 也失败时无限循环
  if (img.dataset.fallbackFrom) return false;

  const blobUrl = await fetchAsBlobUrl(original);
  if (!blobUrl) return false;

  img.dataset.fallbackFrom = original;
  img.src = blobUrl;
  img.removeAttribute("loading");
  return true;
}
