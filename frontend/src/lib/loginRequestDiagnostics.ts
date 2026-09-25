/** Keep the request destination useful for troubleshooting without exposing URL credentials or query tokens. */
export function safeLoginRequestTarget(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, window.location.origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid request URL)";
  }
}
