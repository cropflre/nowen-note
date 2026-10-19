import type { PluginAppSession } from "./pluginApi";

const PROTOCOL = "nowen.plugin-ui.v3";
export function connectPluginAppFrame(frame: HTMLIFrameElement, session: PluginAppSession, call: (message: Record<string, unknown>) => Promise<unknown>, onFailure: () => void, onReady: () => void) {
  const channel = new MessageChannel();
  let closed = false, ready = false, inFlight = 0, windowStart = Date.now(), calls = 0;
  const envelope = { protocol: PROTOCOL, pluginId: session.pluginId, instanceId: session.instanceId };
  const close = () => { if (closed) return; channel.port1.postMessage({ ...envelope, kind: "event", name: "destroy", data: {} }); closed = true; clearTimeout(timeout); channel.port1.close(); channel.port2.close(); };
  const fail = () => { if (!closed) { close(); onFailure(); } };
  const timeout = setTimeout(fail, 10000);
  channel.port1.onmessage = async event => {
    if (closed) return;
    const message: Record<string, unknown> | null = event.data;
    if (Date.now() - windowStart >= 60000) { calls = 0; windowStart = Date.now(); }
    if (++calls > 120 || inFlight >= 16 || !message || message.protocol !== PROTOCOL || message.nonce !== session.nonce || message.instanceId !== session.instanceId || message.pluginId !== session.pluginId) { fail(); return; }
    if (message.kind === "ready" && !ready) { ready = true; clearTimeout(timeout); onReady(); return; }
    let size: number;
    try { size = new TextEncoder().encode(JSON.stringify(message)).byteLength; } catch { fail(); return; }
    if (!ready || message.kind !== "request" || size > 64 * 1024) { fail(); return; }
    inFlight++;
    try {
      const response = await call(message);
      const result = response as Record<string, unknown> | null;
      if (!result || result.protocol !== PROTOCOL || result.pluginId !== session.pluginId || result.instanceId !== session.instanceId || result.requestId !== message.requestId || result.kind !== "response") { fail(); return; }
      if (!closed) channel.port1.postMessage(response);
    } catch (error: unknown) {
      const failure = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
      const code = typeof failure?.code === "string" ? failure.code : "PLUGIN_UI_ERROR";
      const messageText = typeof failure?.message === "string" ? failure.message : "PLUGIN_UI_ERROR";
      if (!closed) channel.port1.postMessage({ ...envelope, kind: "response", requestId: message.requestId, ok: false, error: { code, message: messageText } });
    } finally { inFlight--; }
  };
  channel.port1.start();
  // Opaque origin requires '*'; identity comes from this exact contentWindow and transferred port.
  frame.contentWindow?.postMessage({ protocol: PROTOCOL, kind: "init", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce }, "*", [channel.port2]);
  return { close, event: (name: string, data: unknown) => { if (!closed && ready) channel.port1.postMessage({ ...envelope, kind: "event", name, data }); } };
}
