export const LOGIN_RETRY_DELAY_MS = 300;

/**
 * 登录、两步验证这类请求没有拿到任何 HTTP 响应时，自动补发一次。
 *
 * Android 客户端经原生 HTTP 发 POST，偶尔第一次就直接失败、没有任何响应（例如复用了
 * 已被网络中途断开的连接），用户再点一次就能登录。登录可以安全重放，所以这里替用户
 * 补发一次。服务端返回的任何 HTTP 状态（含 4xx/5xx）都原样交给调用方，不会重试。
 * init.body 必须可重复发送（字符串）。
 */
export async function fetchLoginRequest(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    console.warn("[login] no HTTP response, retrying once:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS));
    return fetch(url, init);
  }
}
