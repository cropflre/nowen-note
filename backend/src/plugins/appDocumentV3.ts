import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import type { PluginManifestV3 } from "./types.js";
import type { AppBridgeSessionV3 } from "./appBridgeV3.js";

// Only host-created, one-use tickets can load this document; no general asset URL exists.
export const APP_DOCUMENT_V3_MAX_BYTES = 4 * 1024 * 1024;
export const APP_DOCUMENT_V3_CSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "PLUGIN_UI_INTEGRITY_INVALID" });
}

export function buildAppDocumentV3(directory: string, manifest: PluginManifestV3, entry: string, identity: AppBridgeSessionV3): string {
  const root = fs.realpathSync(directory);
  const assets = new Map<string, Buffer>();
  let total = 0;
  for (const [file, digest] of Object.entries(manifest.contributes.uiAssets)) {
    const target = path.resolve(root, file);
    const relative = path.relative(root, fs.realpathSync(target));
    if (relative.startsWith("..") || path.isAbsolute(relative) || fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile()) invalid("UI 资源路径不安全");
    const size = fs.statSync(target).size;
    if (size + total > APP_DOCUMENT_V3_MAX_BYTES) invalid("UI 资源总量超过 4MiB");
    const bytes = fs.readFileSync(target);
    total += bytes.length;
    if (total > APP_DOCUMENT_V3_MAX_BYTES || digest !== "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex")) invalid("UI 资源已变更，请重新安装插件");
    assets.set(file, bytes);
  }
  const html = assets.get(entry);
  if (!html) invalid("应用入口不存在");
  if (html.length > 512 * 1024) invalid("应用 HTML 超过 512KiB");
  let referenced = 0;
  const dataUrl = (source: string, extension: RegExp, mime: string): string => {
    if (!source || /[:?#%\\]/.test(source) || source.startsWith("/")) invalid("UI 资源只能引用包内文件");
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(entry), source));
    const bytes = assets.get(file);
    if (!bytes || !extension.test(file)) invalid("UI 资源引用未登记或类型不匹配");
    referenced += bytes.length;
    if (referenced > APP_DOCUMENT_V3_MAX_BYTES) invalid("UI 资源引用总量超过 4MiB");
    return `data:${mime};base64,${bytes.toString("base64")}`;
  };
  const markup = sanitizeHtml(html.toString("utf8"), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "html", "head", "body", "title", "script", "style", "link", "img", "button", "input", "textarea", "select", "option", "label"],
    allowVulnerableTags: true,
    allowedAttributes: {
      "*": ["id", "class", "style", "title", "role", "data-*", "aria-*"],
      script: ["src", "type", "defer"], link: ["href", "rel"], img: ["src", "alt", "width", "height"],
      input: ["type", "value", "placeholder", "checked", "disabled", "min", "max"],
      button: ["type", "disabled"], textarea: ["rows", "placeholder"], option: ["value", "selected"], label: ["for"],
    },
    allowedSchemes: ["data"],
    transformTags: {
      script: (_tag, attributes) => ({ tagName: "script", attribs: attributes.src ? { ...attributes, src: dataUrl(attributes.src, /\.js$/, "text/javascript") } : attributes }),
      link: (_tag, attributes) => {
        if (attributes.rel !== "stylesheet") invalid("仅支持包内样式表链接");
        return { tagName: "link", attribs: { rel: "stylesheet", href: dataUrl(attributes.href, /\.css$/, "text/css") } };
      },
      img: (_tag, attributes) => ({ tagName: "img", attribs: { ...attributes, src: dataUrl(attributes.src, /\.(png|jpg|jpeg|webp|gif)$/, /\.jpe?g$/.test(attributes.src) ? "image/jpeg" : `image/${path.posix.extname(attributes.src || "").slice(1)}`) } }),
    },
  });
  // This bootstrap is the only SDK code injected by the host; the host token is never included.
  const bootstrap = `(() => {
    const identity = ${JSON.stringify(identity)};
    let port; let sequence = 0; const pending = new Map(); const listeners = new Map();
    let resolveReady; const ready = new Promise(resolve => { resolveReady = resolve; });
    window.NowenApp = Object.freeze({
      ready,
      call: async (method, params = {}) => { await ready; return new Promise((resolve, reject) => {
        const requestId = 'ui-' + (++sequence);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('PLUGIN_UI_TIMEOUT')); }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        port.postMessage({ protocol: 'nowen.plugin-ui.v3', kind: 'request', ...identity, requestId, method, params });
      }); },
      on: (name, listener) => { const set = listeners.get(name) || new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener); }
    });
    const initialize = event => {
      const data = event.data;
      if (event.source !== parent || !event.ports[0] || data?.protocol !== 'nowen.plugin-ui.v3' || data.kind !== 'init' || data.nonce !== identity.nonce || data.instanceId !== identity.instanceId || data.pluginId !== identity.pluginId) return;
      window.removeEventListener('message', initialize); port = event.ports[0];
      port.onmessage = ({ data }) => {
        if (data?.protocol !== 'nowen.plugin-ui.v3' || data.pluginId !== identity.pluginId || data.instanceId !== identity.instanceId) return;
        if (data?.kind === 'event') { for (const listener of listeners.get(data.name) || []) listener(data.data); return; }
        const request = pending.get(data?.requestId); if (!request) return;
        clearTimeout(request.timer); pending.delete(data.requestId);
        if (data.ok) request.resolve(data.data); else request.reject(Object.assign(new Error(data.error?.message || 'PLUGIN_UI_ERROR'), { code: data.error?.code }));
      };
      port.start(); port.postMessage({ protocol: 'nowen.plugin-ui.v3', kind: 'ready', ...identity }); resolveReady();
    };
    window.addEventListener('message', initialize);
  })();`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${APP_DOCUMENT_V3_CSP}"><meta charset="utf-8"><script>${bootstrap}</script></head><body>${markup}</body></html>`;
}
