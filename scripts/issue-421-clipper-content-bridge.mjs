import { readFileSync, writeFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function write(path, content) {
  writeFileSync(path, content);
}

function replaceRequired(path, before, after, label) {
  const source = read(path);
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  write(path, source.replace(before, after));
}

function replaceBetween(path, start, end, replacement, label) {
  const source = read(path);
  if (source.includes(replacement) && !source.includes(start)) return;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`${label}: markers not found`);
  }
  write(path, source.slice(0, startIndex) + replacement + source.slice(endIndex));
}

const protocolPath = "packages/nowen-clipper/src/lib/protocol.ts";
replaceRequired(
  protocolPath,
  'import type { ExtractResult } from "./extractor";\n',
  'import type { ExtractResult } from "./extractor";\n\nexport const CONTENT_SCRIPT_PROTOCOL_VERSION = "1";\n\nexport type ClipperConnectionErrorCode =\n  | "PAGE_NOT_INJECTABLE"\n  | "FILE_ACCESS_REQUIRED"\n  | "TAB_UNAVAILABLE"\n  | "CONTENT_SCRIPT_UNAVAILABLE"\n  | "CONTENT_SCRIPT_RESPONSE_INVALID"\n  | "BACKGROUND_UNAVAILABLE";\n',
  "protocol connection types",
);
replaceRequired(
  protocolPath,
  'export interface EnhancedClipResponse {\n  ok: boolean;\n  error?: string;\n',
  'export interface EnhancedClipResponse {\n  ok: boolean;\n  error?: string;\n  errorCode?: ClipperConnectionErrorCode;\n',
  "enhanced response error code",
);
replaceRequired(
  protocolPath,
  'export interface ExtractRequest {\n',
  'export interface ContentScriptPingRequest {\n  type: "CONTENT_SCRIPT_PING";\n  protocolVersion: string;\n}\n\nexport interface ContentScriptPingResponse {\n  type: "CONTENT_SCRIPT_PONG";\n  protocolVersion: string;\n  contentVersion: string;\n}\n\nexport interface ExtractRequest {\n',
  "content script ping protocol",
);
replaceRequired(
  protocolPath,
  '  data?: ExtractResult;\n  error?: string;\n}\n',
  '  data?: ExtractResult;\n  error?: string;\n  errorCode?: ClipperConnectionErrorCode;\n}\n',
  "extract response error code",
);

const legacyBackgroundPath = "packages/nowen-clipper/src/background/index.ts";
replaceRequired(
  legacyBackgroundPath,
  'import { buildContentBundle, inlineImages } from "../lib/transform";\n',
  'import { buildContentBundle, inlineImages } from "../lib/transform";\nimport { requestExtractFromTab } from "../lib/content-script-bridge";\n',
  "legacy bridge import",
);
replaceRequired(
  legacyBackgroundPath,
  '  ClipRequest,\n  ExtractRequest,\n  ExtractResponse,\n',
  '  ClipRequest,\n',
  "legacy unused extract imports",
);
replaceRequired(
  legacyBackgroundPath,
  '  const extracted = await requestExtract(req.tabId, extractMode);',
  '  const extracted = await requestExtractFromTab(req.tabId, extractMode);',
  "legacy bridge call",
);
replaceBetween(
  legacyBackgroundPath,
  '// ========== content script 通信 ==========\n',
  '/** 右键"剪藏这个链接"的极简模式：只存 URL/锚点，不下载对端内容 */',
  '',
  "remove legacy requestExtract",
);

const enhancedPath = "packages/nowen-clipper/src/background/enhanced.ts";
replaceRequired(
  enhancedPath,
  'import { localizeRemoteImages } from "../lib/image-localizer";\n',
  'import { localizeRemoteImages } from "../lib/image-localizer";\nimport { requestExtractFromTab } from "../lib/content-script-bridge";\n',
  "enhanced bridge import",
);
replaceRequired(
  enhancedPath,
  '  EnhancedClipResponse,\n  ExtractRequest,\n  ExtractResponse,\n',
  '  EnhancedClipResponse,\n  ExtractResponse,\n',
  "enhanced unused request import",
);
replaceRequired(
  enhancedPath,
  '    extracted = await requestExtract(req.tabId, extractMode);',
  '    extracted = await requestExtractFromTab(req.tabId, extractMode);',
  "enhanced bridge call",
);
replaceRequired(
  enhancedPath,
  '  if (!extracted.ok || !extracted.data) {\n    return { ok: false, error: extracted.error || "内容抽取失败" };\n  }',
  '  if (!extracted.ok || !extracted.data) {\n    return {\n      ok: false,\n      error: extracted.error || "内容抽取失败",\n      errorCode: extracted.errorCode,\n    };\n  }',
  "propagate bridge error code",
);
replaceBetween(
  enhancedPath,
  'async function requestExtract(\n',
  'async function prepareLazyAssets(\n',
  '',
  "remove enhanced requestExtract",
);

const contentPath = "packages/nowen-clipper/src/content/index.ts";
replaceRequired(
  contentPath,
  ' *   - 解决：整个脚本包成 IIFE，并在 window 上挂一个 `__nowenClipperLoaded` 标记，\n *     第二次进来直接 return，不会再触达任何顶层声明。\n',
  ' *   - 解决：整个脚本包成 IIFE，并在每次注入时安全替换旧 listener。\n *     即使插件刚更新、旧标签页残留标记，也会重新建立消息通道。\n',
  "content script recovery comment",
);
replaceRequired(
  contentPath,
  'import { extractArticle, extractSelection, extractSimplified, extractFullPage } from "../lib/extractor";\nimport type {\n  ExtractRequest,\n  ExtractResponse,\n  PageDimensionsRequest,\n  PageDimensionsResponse,\n  ScrollToRequest,\n  ScrollToResponse,\n} from "../lib/protocol";\n',
  'import { extractArticle, extractSelection, extractSimplified, extractFullPage } from "../lib/extractor";\nimport { installContentScriptListener } from "../lib/content-script-runtime";\nimport { CONTENT_SCRIPT_PROTOCOL_VERSION } from "../lib/protocol";\nimport type {\n  ContentScriptPingRequest,\n  ContentScriptPingResponse,\n  ExtractRequest,\n  ExtractResponse,\n  PageDimensionsRequest,\n  PageDimensionsResponse,\n  ScrollToRequest,\n  ScrollToResponse,\n} from "../lib/protocol";\n',
  "content imports",
);
replaceBetween(
  contentPath,
  '(function initNowenClipperContent() {\n',
  '  function messageHandler(\n',
  '(function initNowenClipperContent() {\n  const win = window as unknown as Record<string, unknown>;\n\n  // 版本标记——用于确认 content script 是否已更新\n  const CONTENT_SCRIPT_VERSION = "0.5.0";\n\n  type MessageType = ContentScriptPingRequest | ExtractRequest | PageDimensionsRequest | ScrollToRequest;\n\n  function messageHandler(\n',
  "content bootstrap",
);
replaceRequired(
  contentPath,
  '    sendResponse: (r: ExtractResponse | PageDimensionsResponse | ScrollToResponse) => void,\n',
  '    sendResponse: (r: ContentScriptPingResponse | ExtractResponse | PageDimensionsResponse | ScrollToResponse) => void,\n',
  "content ping response type",
);
replaceRequired(
  contentPath,
  '    console.log(`[nowen-clipper content v${CONTENT_SCRIPT_VERSION}] 收到消息:`, msg.type);\n\n    if (msg.type === "EXTRACT_REQUEST") {\n',
  '    console.log(`[nowen-clipper content v${CONTENT_SCRIPT_VERSION}] 收到消息:`, msg.type);\n\n    if (msg.type === "CONTENT_SCRIPT_PING") {\n      sendResponse({\n        type: "CONTENT_SCRIPT_PONG",\n        protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,\n        contentVersion: CONTENT_SCRIPT_VERSION,\n      });\n      return undefined;\n    }\n\n    if (msg.type === "EXTRACT_REQUEST") {\n',
  "content ping handler",
);
replaceRequired(
  contentPath,
  '  // 注册新 listener 并保存到 window 全局，供后续版本移除\n  chrome.runtime.onMessage.addListener(messageHandler as any);\n  win.__nowenClipperListener = messageHandler;\n',
  '  installContentScriptListener(win, chrome.runtime as any, CONTENT_SCRIPT_VERSION, messageHandler as any);\n',
  "content listener replacement",
);

const popupPath = "packages/nowen-clipper/src/popup/popup.ts";
replaceRequired(
  popupPath,
  'import { listNotebooks, listWorkspaces, type NotebookSummary, type WorkspaceSummary } from "../lib/api";\n',
  'import { listNotebooks, listWorkspaces, type NotebookSummary, type WorkspaceSummary } from "../lib/api";\nimport { describeRuntimeMessageError } from "../lib/runtime-message-error";\n',
  "popup runtime error import",
);
replaceRequired(
  popupPath,
  '  } catch (error: any) {\n    showResult({ ok: false, error: String(error?.message || error) });\n',
  '  } catch (error: any) {\n    showResult({\n      ok: false,\n      error: describeRuntimeMessageError(error),\n      errorCode: "BACKGROUND_UNAVAILABLE",\n    });\n',
  "popup runtime error message",
);

const packagePath = "packages/nowen-clipper/package.json";
replaceRequired(
  packagePath,
  '    "pack:all": "npm run pack:chrome && npm run pack:edge && npm run pack:firefox",\n    "lint": "tsc --noEmit"\n',
  '    "pack:all": "npm run pack:chrome && npm run pack:edge && npm run pack:firefox",\n    "test": "node --import tsx --test tests/*.test.ts",\n    "lint": "tsc --noEmit"\n',
  "clipper test script",
);
replaceRequired(
  packagePath,
  '    "sharp": "^0.33.5",\n    "typescript": "^5.7.3",\n',
  '    "sharp": "^0.33.5",\n    "tsx": "^4.19.2",\n    "typescript": "^5.7.3",\n',
  "clipper tsx dependency",
);

console.log("Issue #421 clipper bridge patch applied");
