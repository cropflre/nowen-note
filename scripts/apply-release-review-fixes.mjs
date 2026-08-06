import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (file, content) => fs.writeFileSync(path.join(root, file), content);

function replaceOnce(file, search, replacement) {
  const content = read(file);
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`Missing expected snippet in ${file}: ${search.slice(0, 120)}`);
  if (content.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Expected a unique snippet in ${file}: ${search.slice(0, 120)}`);
  }
  write(file, content.slice(0, index) + replacement + content.slice(index + search.length));
}

function replaceSection(file, startMarker, endMarker, replacement) {
  const content = read(file);
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Cannot locate section in ${file}`);
  write(file, content.slice(0, start) + replacement + content.slice(end));
}

function updateJson(file, updater) {
  const value = JSON.parse(read(file));
  updater(value);
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

// 1. Keep the task offline adapter optional at module-import time. Partial test/plugin API
// facades must not crash unrelated editor modules before their tests can start.
{
  const file = "frontend/src/lib/taskOfflineRuntime.ts";
  const marker = "export function installTaskOfflineApi(api: any, options: Options) {\n";
  const helpers = `const REQUIRED_NATIVE_API_METHODS = [\n  "getTasks", "getTaskStats", "createTask", "updateTask", "toggleTask", "deleteTask",\n  "getHabits", "getHabitStats", "getHabitCheckinLog", "createHabit", "updateHabit",\n  "archiveHabit", "deleteHabit", "checkInHabit",\n] as const;\n\nconst DISABLED_TASK_OFFLINE_CONTROLLER = {\n  flush: async () => {},\n  pending: () => 0,\n};\n\nfunction bindNativeTaskApi(api: unknown): NativeApi | null {\n  if (!api || typeof api !== "object") return null;\n  const source = api as Record<string, unknown>;\n  const missing = REQUIRED_NATIVE_API_METHODS.filter((name) => typeof source[name] !== "function");\n  if (missing.length > 0) {\n    console.warn(\n      \`[task-offline] adapter disabled because the API facade is incomplete: \${missing.join(", ")}\`,\n    );\n    return null;\n  }\n  return Object.fromEntries(\n    REQUIRED_NATIVE_API_METHODS.map((name) => [name, (source[name] as Function).bind(api)]),\n  ) as unknown as NativeApi;\n}\n\n${marker}`;
  replaceOnce(file, marker, helpers);
  replaceOnce(
    file,
    `  if (api[FLAG]) return api[FLAG] as { flush: () => Promise<void>; pending: () => number };\n  const native: NativeApi = {\n    getTasks: api.getTasks.bind(api), getTaskStats: api.getTaskStats.bind(api),\n    createTask: api.createTask.bind(api), updateTask: api.updateTask.bind(api),\n    toggleTask: api.toggleTask.bind(api), deleteTask: api.deleteTask.bind(api),\n    getHabits: api.getHabits.bind(api), getHabitStats: api.getHabitStats.bind(api),\n    getHabitCheckinLog: api.getHabitCheckinLog.bind(api), createHabit: api.createHabit.bind(api),\n    updateHabit: api.updateHabit.bind(api), archiveHabit: api.archiveHabit.bind(api),\n    deleteHabit: api.deleteHabit.bind(api), checkInHabit: api.checkInHabit.bind(api),\n  };\n`,
    `  if (api?.[FLAG]) return api[FLAG] as { flush: () => Promise<void>; pending: () => number };\n  const native = bindNativeTaskApi(api);\n  if (!native) return DISABLED_TASK_OFFLINE_CONTROLLER;\n`,
  );
}

// 2. Make the orphan/source-note correction the final response writer while preserving the
// knowledge capability filter as the inner security boundary.
{
  const file = "backend/src/runtime/knowledge-tree.ts";
  replaceOnce(
    file,
    `  const wrapper = new Hono<any>();\n  wrapper.use("*", middleware);\n  if (normalized === "/api/files") {\n    // Keep the release branch orphan/source-note visibility correction after access filtering.\n    wrapper.use("*", fileOrphanVisibilityMiddleware);\n  }\n`,
    `  const wrapper = new Hono<any>();\n  if (normalized === "/api/files") {\n    // Hono middleware unwinds in reverse registration order. Register the response correction\n    // first so the capability guard filters the route response before orphan metadata is applied.\n    wrapper.use("*", fileOrphanVisibilityMiddleware);\n  }\n  wrapper.use("*", middleware);\n`,
  );
}

{
  const file = "backend/src/runtime/file-orphan-visibility.ts";
  replaceOnce(
    file,
    `import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url.js";\n`,
    `import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url.js";\nimport {\n  hasKnowledgeCapability,\n  resolveResourceKnowledgeAccess,\n} from "../services/knowledgeCapabilities.js";\n`,
  );
  replaceOnce(
    file,
    `const MANUAL_UPLOAD_SOURCE = "file_manager";\n`,
    `const MANUAL_UPLOAD_SOURCE = "file_manager";\n\nfunction noteCapability(noteId: string, userId: string, capability: "canView" | "canDownload"): boolean {\n  if (!noteId || !userId) return false;\n  return hasKnowledgeCapability(\n    resolveResourceKnowledgeAccess("note", noteId, userId),\n    capability,\n  );\n}\n`,
  );

  const summary = `export function getImmediateOrphanSummary(\n  db: Database.Database,\n  scope: FilesScope,\n  userId: string,\n): { count: number; bytes: number } {\n  const where: string[] = [\n    "EXISTS(SELECT 1 FROM notes owner_note WHERE owner_note.id = a.noteId)",\n    "NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",\n    "COALESCE(a.uploadSource, '') <> 'file_manager'",\n  ];\n  const params: Array<string | number> = [];\n  appendAttachmentScope(where, params, scope, userId);\n\n  const rows = db.prepare(\`\n    SELECT a.noteId, COALESCE(a.size, 0) AS size\n      FROM attachments a\n     WHERE \${where.join(" AND ")}\n  \`).all(...params) as Array<{ noteId: string; size: number }>;\n\n  let count = 0;\n  let bytes = 0;\n  for (const row of rows) {\n    if (!noteCapability(row.noteId, userId, "canView")) continue;\n    count += 1;\n    bytes += Number(row.size || 0);\n  }\n  return { count, bytes };\n}\n\n`;
  replaceSection(
    file,
    "export function getImmediateOrphanSummary(",
    "/**\n * 返回当前真正引用附件的首篇笔记。",
    summary,
  );

  replaceOnce(
    file,
    `  for (const row of rows) {\n    if (result.has(row.attachmentId)) continue;\n`,
    `  for (const row of rows) {\n    if (result.has(row.attachmentId)) continue;\n    if (!noteCapability(row.id, userId, "canView")) continue;\n`,
  );

  const listBuilder = `function buildImmediateOrphanList(\n  db: Database.Database,\n  c: Context,\n  scope: FilesScope,\n  userId: string,\n) {\n  const category = (c.req.query("category") || "all").toLowerCase();\n  const mime = c.req.query("mime") || "";\n  const notebookId = c.req.query("notebookId") || "";\n  const noteId = c.req.query("noteId") || "";\n  const folderId = c.req.query("folderId") || "";\n  const q = (c.req.query("q") || "").trim();\n  const page = Math.max(1, Number(c.req.query("page") || 1));\n  const pageSize = Math.min(200, Math.max(1, Number(c.req.query("pageSize") || 50)));\n\n  const where: string[] = [\n    "NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",\n    "COALESCE(a.uploadSource, '') <> 'file_manager'",\n  ];\n  const params: Array<string | number> = [];\n  appendAttachmentScope(where, params, scope, userId);\n\n  if (category === "image") {\n    where.push("a.mimeType LIKE 'image/%'");\n  } else if (category === "file") {\n    where.push("(a.mimeType IS NULL OR a.mimeType NOT LIKE 'image/%')");\n  }\n  if (mime) {\n    where.push("a.mimeType = ?");\n    params.push(mime.toLowerCase());\n  }\n  if (notebookId) {\n    where.push("n.notebookId = ?");\n    params.push(notebookId);\n  }\n  if (q) {\n    where.push("a.filename LIKE ? COLLATE NOCASE");\n    params.push(\`%\${q}%\`);\n  }\n  if (folderId) {\n    if (folderId === "__unarchived") where.push("a.folderId IS NULL");\n    else {\n      where.push("a.folderId = ?");\n      params.push(folderId);\n    }\n  }\n  if (noteId) where.push("1 = 0");\n\n  const rows = db.prepare(\`\n    SELECT a.id, a.filename, a.mimeType, a.size, a.path, a.createdAt, a.noteId,\n           a.hash, a.folderId, a.uploadSource, af.name AS folderName\n      FROM attachments a\n      INNER JOIN notes n ON n.id = a.noteId\n      LEFT JOIN attachment_folders af ON af.id = a.folderId\n     WHERE \${where.join(" AND ")}\n     ORDER BY \${resolveOrderBy(c.req.query("sort"))}\n  \`).all(...params) as FileListRow[];\n\n  const visibleRows = rows.filter((row) => noteCapability(row.noteId, userId, "canView"));\n  const pageRows = visibleRows.slice((page - 1) * pageSize, page * pageSize);\n  const downloadableRows = pageRows.filter((row) =>\n    noteCapability(row.noteId, userId, "canDownload"),\n  );\n  const downloadableIds = new Set(downloadableRows.map((row) => row.id));\n  const items = pageRows.map((row) => {\n    const item = toOrphanFileOut(row) as Record<string, unknown>;\n    if (downloadableIds.has(row.id)) return { ...item, downloadAllowed: true };\n    delete item.url;\n    delete item.thumbnailUrl;\n    return { ...item, downloadAllowed: false };\n  });\n\n  return {\n    items,\n    accessUrls: createUserAttachmentAccessUrls(userId, downloadableRows),\n    total: visibleRows.length,\n    page,\n    pageSize,\n  };\n}\n\n`;
  replaceSection(file, "function buildImmediateOrphanList(", "function replaceJsonResponse", listBuilder);
}

// 3. Demand-load deferred event centers and wait for a ready handshake before dispatching a
// one-shot image export request.
write("frontend/src/lib/noteImageExportBridge.ts", `import { parseServerTime } from "@/lib/dateTime";\nimport {\n  isMarkdownImageExportSource,\n  prepareMarkdownFootnotesForImageExport,\n  refreshNoteImageAttachmentAccess,\n} from "@/lib/noteImageExportPreparation";\n\nexport type NoteImageExportFormat = "png" | "jpg" | "svg";\nexport type NoteImageExportLayout = "auto" | "long" | "pages";\nexport type NoteImageExportTheme = "current" | "light" | "dark";\nexport type NoteImageExportDestination = "download" | "gallery" | "files" | "share";\n\nexport interface ExportableNoteImageSource {\n  id: string;\n  title: string;\n  content: string;\n  contentText: string;\n  contentFormat?: string;\n  createdAt?: string;\n  updatedAt?: string;\n}\n\nexport interface NoteImageExportInitialOptions {\n  format?: NoteImageExportFormat;\n  quality?: number;\n  pixelRatio?: number;\n  layout?: NoteImageExportLayout;\n  theme?: NoteImageExportTheme;\n  destination?: NoteImageExportDestination;\n}\n\nexport interface NoteImageExportRequestDetail {\n  requestId: string;\n  note: ExportableNoteImageSource;\n  options: NoteImageExportInitialOptions;\n}\n\nexport const NOTE_IMAGE_EXPORT_REQUEST_EVENT = "nowen:note-image-export-request";\nexport const DEFERRED_FEATURE_CENTERS_NEEDED_EVENT = "nowen:deferred-feature-centers-needed";\n\nconst pending = new Map<string, (ok: boolean) => void>();\nconst readyWaiters = new Set<(ready: boolean) => void>();\nlet sequence = 0;\nlet centerReady = false;\n\nfunction createRequestId(): string {\n  sequence += 1;\n  return \`note-image-export-\${Date.now()}-\${sequence}\`;\n}\n\nexport function setNoteImageExportCenterReady(ready: boolean): void {\n  centerReady = ready;\n  if (!ready) return;\n  for (const resolve of readyWaiters) resolve(true);\n  readyWaiters.clear();\n}\n\nfunction waitForNoteImageExportCenter(timeoutMs = 5_000): Promise<boolean> {\n  if (centerReady) return Promise.resolve(true);\n  return new Promise((resolve) => {\n    let settled = false;\n    const finish = (ready: boolean) => {\n      if (settled) return;\n      settled = true;\n      window.clearTimeout(timer);\n      readyWaiters.delete(finish);\n      resolve(ready);\n    };\n    const timer = window.setTimeout(() => finish(false), timeoutMs);\n    readyWaiters.add(finish);\n  });\n}\n\nexport function normalizeNoteImageExportTimestamp(\n  value: string | null | undefined,\n): string | undefined {\n  return parseServerTime(value)?.toISOString();\n}\n\nexport function normalizeNoteImageExportSource(\n  note: ExportableNoteImageSource,\n): ExportableNoteImageSource {\n  const normalized = { ...note };\n  const createdAt = normalizeNoteImageExportTimestamp(note.createdAt);\n  const updatedAt = normalizeNoteImageExportTimestamp(note.updatedAt);\n  if (createdAt) normalized.createdAt = createdAt;\n  else delete normalized.createdAt;\n  if (updatedAt) normalized.updatedAt = updatedAt;\n  else delete normalized.updatedAt;\n  return normalized;\n}\n\nexport function prepareNoteImageExportSource(\n  note: ExportableNoteImageSource,\n): ExportableNoteImageSource {\n  const prepared = normalizeNoteImageExportSource(note);\n  if (!isMarkdownImageExportSource(prepared.content || prepared.contentText || "", prepared.contentFormat)) {\n    return prepared;\n  }\n  if (prepared.content) prepared.content = prepareMarkdownFootnotesForImageExport(prepared.content);\n  if (prepared.contentText) prepared.contentText = prepareMarkdownFootnotesForImageExport(prepared.contentText);\n  return prepared;\n}\n\nexport async function requestNoteImageExport(\n  note: ExportableNoteImageSource,\n  options: NoteImageExportInitialOptions = {},\n): Promise<boolean> {\n  if (typeof window === "undefined") return false;\n\n  const exportNote = prepareNoteImageExportSource(note);\n  await refreshNoteImageAttachmentAccess(\n    exportNote.id,\n    \`\${exportNote.content || ""}\\n\${exportNote.contentText || ""}\`,\n  );\n\n  window.dispatchEvent(new Event(DEFERRED_FEATURE_CENTERS_NEEDED_EVENT));\n  if (!(await waitForNoteImageExportCenter())) return false;\n\n  const requestId = createRequestId();\n  return new Promise<boolean>((resolve) => {\n    pending.set(requestId, resolve);\n    window.dispatchEvent(new CustomEvent<NoteImageExportRequestDetail>(\n      NOTE_IMAGE_EXPORT_REQUEST_EVENT,\n      { detail: { requestId, note: exportNote, options } },\n    ));\n  });\n}\n\nexport function settleNoteImageExportRequest(requestId: string, ok: boolean): void {\n  const resolve = pending.get(requestId);\n  if (!resolve) return;\n  pending.delete(requestId);\n  resolve(ok);\n}\n\nexport function cancelAllNoteImageExportRequests(): void {\n  for (const resolve of pending.values()) resolve(false);\n  pending.clear();\n}\n`);

write("frontend/src/components/DeferredGlobalFeatureCentersMount.tsx", `import React, { Suspense, useEffect, useState } from "react";\nimport { DEFERRED_FEATURE_CENTERS_NEEDED_EVENT } from "@/lib/noteImageExportBridge";\n\nconst LazyDeferredGlobalFeatureCenters = React.lazy(\n  () => import("./DeferredGlobalFeatureCenters"),\n);\n\nconst TOKEN_KEY = "nowen-token";\nconst TOKEN_CHANGED_EVENT = "nowen:token-changed";\nconst IDLE_TIMEOUT_MS = 2_000;\n\ntype IdleWindow = Window & {\n  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;\n  cancelIdleCallback?: (handle: number) => void;\n};\n\nfunction hasLoginToken(): boolean {\n  try {\n    return Boolean(window.localStorage.getItem(TOKEN_KEY));\n  } catch {\n    return false;\n  }\n}\n\nexport default function DeferredGlobalFeatureCentersMount() {\n  const [mounted, setMounted] = useState(false);\n\n  useEffect(() => {\n    let disposed = false;\n    let idleHandle: number | null = null;\n    let timeoutHandle: number | null = null;\n\n    const cancelScheduledMount = () => {\n      const idleWindow = window as IdleWindow;\n      if (idleHandle !== null && idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(idleHandle);\n      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);\n      idleHandle = null;\n      timeoutHandle = null;\n    };\n\n    const mountNow = () => {\n      cancelScheduledMount();\n      if (!disposed && hasLoginToken()) setMounted(true);\n    };\n\n    const scheduleMount = () => {\n      if (disposed || mounted || !hasLoginToken() || idleHandle !== null || timeoutHandle !== null) return;\n      const commit = () => {\n        idleHandle = null;\n        timeoutHandle = null;\n        if (!disposed && hasLoginToken()) setMounted(true);\n      };\n      const idleWindow = window as IdleWindow;\n      if (idleWindow.requestIdleCallback) {\n        idleHandle = idleWindow.requestIdleCallback(commit, { timeout: IDLE_TIMEOUT_MS });\n      } else {\n        timeoutHandle = window.setTimeout(commit, 250);\n      }\n    };\n\n    const syncToken = () => {\n      if (hasLoginToken()) scheduleMount();\n      else {\n        cancelScheduledMount();\n        setMounted(false);\n      }\n    };\n    const handleStorage = (event: StorageEvent) => {\n      if (event.key === TOKEN_KEY) syncToken();\n    };\n\n    scheduleMount();\n    window.addEventListener(TOKEN_CHANGED_EVENT, syncToken);\n    window.addEventListener(DEFERRED_FEATURE_CENTERS_NEEDED_EVENT, mountNow);\n    window.addEventListener("storage", handleStorage);\n    return () => {\n      disposed = true;\n      cancelScheduledMount();\n      window.removeEventListener(TOKEN_CHANGED_EVENT, syncToken);\n      window.removeEventListener(DEFERRED_FEATURE_CENTERS_NEEDED_EVENT, mountNow);\n      window.removeEventListener("storage", handleStorage);\n    };\n  }, [mounted]);\n\n  if (!mounted) return null;\n  return (\n    <Suspense fallback={null}>\n      <LazyDeferredGlobalFeatureCenters />\n    </Suspense>\n  );\n}\n`);

{
  const file = "frontend/src/components/NoteImageExportCenter.tsx";
  replaceOnce(
    file,
    `  settleNoteImageExportRequest,\n`,
    `  settleNoteImageExportRequest,\n  setNoteImageExportCenterReady,\n`,
  );
  replaceOnce(
    file,
    `  const [result, setResult] = useState<NoteImageExportResult | null>(null);\n\n  useEffect(() => {\n`,
    `  const [result, setResult] = useState<NoteImageExportResult | null>(null);\n\n  useEffect(() => {\n    setNoteImageExportCenterReady(true);\n    return () => setNoteImageExportCenterReady(false);\n  }, []);\n\n  useEffect(() => {\n`,
  );
}

// 4. Use an explicit mobile image-viewer event from Tiptap instead of observing and hiding its DOM.
write("frontend/src/lib/mobileImageViewer.ts", `import { Capacitor } from "@capacitor/core";\n\nexport const MOBILE_IMAGE_VIEWER_OPEN_EVENT = "nowen:mobile-image-viewer-open";\n\nexport interface MobileImageViewerRequest {\n  src: string;\n  alt?: string;\n  source: "markdown" | "tiptap";\n}\n\nexport function shouldUseMobileImageViewer(): boolean {\n  if (Capacitor.getPlatform() === "android") return true;\n  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;\n  return window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;\n}\n\nexport function openMobileImageViewer(request: MobileImageViewerRequest): boolean {\n  if (typeof window === "undefined" || !request.src) return false;\n  window.dispatchEvent(new CustomEvent<MobileImageViewerRequest>(\n    MOBILE_IMAGE_VIEWER_OPEN_EVENT,\n    { detail: request },\n  ));\n  return true;\n}\n`);

write("frontend/src/components/MobileImageViewerBridge.tsx", `import React, { useEffect, useState } from "react";\nimport MobileImageViewer from "@/components/MobileImageViewer";\nimport {\n  MOBILE_IMAGE_VIEWER_OPEN_EVENT,\n  openMobileImageViewer,\n  shouldUseMobileImageViewer,\n  type MobileImageViewerRequest,\n} from "@/lib/mobileImageViewer";\n\nfunction getImageSource(image: HTMLImageElement): string {\n  return image.currentSrc || image.src || image.getAttribute("src") || "";\n}\n\nexport default function MobileImageViewerBridge() {\n  const [request, setRequest] = useState<MobileImageViewerRequest | null>(null);\n\n  useEffect(() => {\n    const handleOpen = (event: Event) => {\n      const detail = (event as CustomEvent<MobileImageViewerRequest>).detail;\n      if (!detail?.src) return;\n      setRequest(detail);\n    };\n    window.addEventListener(MOBILE_IMAGE_VIEWER_OPEN_EVENT, handleOpen);\n    return () => window.removeEventListener(MOBILE_IMAGE_VIEWER_OPEN_EVENT, handleOpen);\n  }, []);\n\n  useEffect(() => {\n    const handleMarkdownImageClick = (event: MouseEvent) => {\n      if (!shouldUseMobileImageViewer() || !(event.target instanceof Element)) return;\n      const image = event.target.closest<HTMLImageElement>(".nowen-md-preview img");\n      if (!image || image.closest("[data-nowen-mobile-image-viewer]")) return;\n      const src = getImageSource(image);\n      if (!src) return;\n\n      event.preventDefault();\n      event.stopPropagation();\n      event.stopImmediatePropagation();\n      openMobileImageViewer({ src, alt: image.alt || "", source: "markdown" });\n    };\n\n    document.addEventListener("click", handleMarkdownImageClick, true);\n    return () => document.removeEventListener("click", handleMarkdownImageClick, true);\n  }, []);\n\n  return (\n    <MobileImageViewer\n      open={!!request}\n      src={request?.src || ""}\n      alt={request?.alt || ""}\n      onClose={() => setRequest(null)}\n    />\n  );\n}\n`);

{
  const file = "frontend/src/components/TiptapEditor.tsx";
  let content = read(file);
  const callPattern = /setPreviewImage\((?!null\b)([^;\n]+)\);/g;
  const calls = [...content.matchAll(callPattern)];
  if (calls.length === 0) throw new Error("No non-null Tiptap image preview calls found");
  content = content.replace(callPattern, "openImagePreview($1);");
  write(file, content);
  replaceOnce(
    file,
    `import { saveImageToGallery, isAndroidNative } from "@/lib/nativeImageSave";\n`,
    `import { saveImageToGallery, isAndroidNative } from "@/lib/nativeImageSave";\nimport { openMobileImageViewer, shouldUseMobileImageViewer } from "@/lib/mobileImageViewer";\n`,
  );
  replaceOnce(
    file,
    `  const [previewImage, setPreviewImage] = useState<string | null>(null);\n`,
    `  const [previewImage, setPreviewImage] = useState<string | null>(null);\n  const openImagePreview = useCallback((src: string) => {\n    if (shouldUseMobileImageViewer()) {\n      openMobileImageViewer({ src, alt: "", source: "tiptap" });\n      return;\n    }\n    setPreviewImage(src);\n  }, []);\n`,
  );
}

write("frontend/src/components/TiptapEditorInitializationRuntime.tsx", `import React, { forwardRef } from "react";\n\nimport type { NoteEditorHandle } from "@/components/editors/types";\nimport { useEditorInitializationTimeout } from "@/hooks/useEditorInitializationTimeout";\nimport TiptapEditorRuntime from "./TiptapEditorRuntime";\n\ntype TiptapEditorInitializationRuntimeProps = React.ComponentPropsWithoutRef<typeof TiptapEditorRuntime>;\n\n/** Adds the shared initialization watchdog around the existing Tiptap runtime shell. */\nconst TiptapEditorInitializationRuntime = forwardRef<\n  NoteEditorHandle,\n  TiptapEditorInitializationRuntimeProps\n>(function TiptapEditorInitializationRuntime(props, ref) {\n  const onEditorReady = useEditorInitializationTimeout({\n    noteId: props.note.id,\n    engine: "tiptap",\n    onEditorReady: props.onEditorReady,\n  });\n\n  return (\n    <TiptapEditorRuntime\n      {...props}\n      ref={ref}\n      onEditorReady={onEditorReady}\n    />\n  );\n});\n\nTiptapEditorInitializationRuntime.displayName = "TiptapEditorInitializationRuntime";\n\nexport default TiptapEditorInitializationRuntime;\n`);

write("frontend/src/lib/__tests__/mobileImageViewerContract.test.ts", `import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nfunction source(relativeUrl: string) {\n  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");\n}\n\ndescribe("mobile image viewer contract", () => {\n  it("keeps close controls outside the gesture stage and handles Android back", () => {\n    const viewer = source("../../components/MobileImageViewer.tsx");\n    expect(viewer).toContain('data-nowen-mobile-image-viewer=""');\n    expect(viewer).toContain('style={{ touchAction: "none" }}');\n    expect(viewer).toContain("onPointerDown={handleClosePointerDown}");\n    expect(viewer).toContain('CapacitorApp.addListener("backButton"');\n    expect(viewer).toContain("setPointerCapture");\n    expect(viewer).toContain("releasePointerCapture");\n  });\n\n  it("uses one explicit viewer state source for Markdown and Tiptap", () => {\n    const bridge = source("../../components/MobileImageViewerBridge.tsx");\n    const editor = source("../../components/TiptapEditor.tsx");\n    expect(bridge).toContain("MOBILE_IMAGE_VIEWER_OPEN_EVENT");\n    expect(bridge).toContain('document.addEventListener("click", handleMarkdownImageClick, true)');\n    expect(bridge).not.toContain("MutationObserver");\n    expect(bridge).not.toContain('img[alt="preview"]');\n    expect(editor).toContain('openMobileImageViewer({ src, alt: "", source: "tiptap" })');\n  });\n});\n`);

write("frontend/src/lib/__tests__/androidImagePreviewTapCloseContract.test.ts", `import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nfunction source(relativeUrl: string) {\n  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");\n}\n\ndescribe("Android image preview routing contract", () => {\n  it("routes Tiptap previews explicitly instead of probing lightbox DOM", () => {\n    const runtime = source("../../components/TiptapEditorInitializationRuntime.tsx");\n    const editor = source("../../components/TiptapEditor.tsx");\n    expect(runtime).not.toContain("PREVIEW_IMAGE_SELECTOR");\n    expect(runtime).not.toContain('document.addEventListener("pointerdown"');\n    expect(editor).toContain("shouldUseMobileImageViewer()");\n    expect(editor).toContain("openMobileImageViewer");\n  });\n});\n`);

// 5. Prevent the daily-journal container from handling a note link already consumed by the anchor.
replaceOnce(
  "frontend/src/components/daily-records/DailyJournalContentPreview.tsx",
  `  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {\n    const target = event.target as HTMLElement | null;\n`,
  `  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {\n    if (event.defaultPrevented) return;\n    const target = event.target as HTMLElement | null;\n`,
);

// 6. Align updater documentation with the intentional Windows/macOS browser-download policy.
replaceOnce(
  "electron/updater.js",
  `//   Windows/Linux: idle -> checking -> available -> downloading -> downloaded -> installing\n//   macOS:         idle -> checking -> available -> browser manual download\n`,
  `//   Linux:         idle -> checking -> available -> downloading -> downloaded -> installing\n//   Windows/macOS: idle -> checking -> available -> browser manual download\n`,
);

// 7. Standardize frontend/Capacitor jobs on Node 22.
{
  const workflowsDir = path.join(root, ".github/workflows");
  let changed = 0;
  for (const name of fs.readdirSync(workflowsDir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const file = path.join(".github/workflows", name);
    const before = read(file);
    const after = before.replace(
      /node-version:\s*20(\n\s+cache:\s*npm\n\s+cache-dependency-path:\s*frontend\/package-lock\.json)/g,
      "node-version: 22$1",
    );
    if (after !== before) {\n      write(file, after);\n      changed += 1;\n    }\n  }\n  if (changed === 0) throw new Error("No frontend Node 20 workflow was updated");\n}\n\nupdateJson("frontend/package.json", (pkg) => {\n  pkg.engines = { ...(pkg.engines || {}), node: ">=22.0.0" };\n});\nupdateJson("frontend/package-lock.json", (lock) => {\n  lock.packages ||= {};\n  lock.packages[""] ||= {};\n  lock.packages[""].engines = { ...(lock.packages[""].engines || {}), node: ">=22.0.0" };\n});\n\n// 8. Bump every release identity source and add a v1.4.6 changelog entry.\nconst releaseVersion = "1.4.6";\nconst releaseDate = "2026-08-06";\nfor (const file of ["package.json", "backend/package.json"]) {\n  updateJson(file, (pkg) => { pkg.version = releaseVersion; });\n}\nfor (const file of ["package-lock.json", "backend/package-lock.json"]) {\n  updateJson(file, (lock) => {\n    lock.version = releaseVersion;\n    lock.packages ||= {};\n    lock.packages[""] ||= {};\n    lock.packages[""].version = releaseVersion;\n  });\n}\n\n{\n  const file = "frontend/android/app/build.gradle";\n  let content = read(file);\n  content = content.replace(/versionCode\s+10405/, "versionCode 10406");\n  content = content.replace(/versionName\s+"1\.4\.5"/, 'versionName "1.4.6"');\n  if (!content.includes("versionCode 10406") || !content.includes('versionName "1.4.6"')) {\n    throw new Error("Android version bump failed");\n  }\n  write(file, content);\n}\n\nconst releaseBody = `### ✨ 新增\n\n- 强化知识树与团队空间权限边界，补齐文件、搜索、离线同步与导出过滤。\n- Android 接入原生任务提醒和统一移动端图片查看器。\n- 日记预览保留 Markdown、富文本和内部笔记链接。\n\n### 🐛 修复\n\n- 修复同步冲突、文件孤儿误判、代码块复制、笔记树刷新和客户端启动兼容问题。\n- 修复 Linux better-sqlite3 原生模块兼容和 Electron 渲染进程恢复。\n- 修复 Docker/NAS 自定义端口健康检查与静态资源缓存协商。\n\n### ⚡ 优化\n\n- 拆分首屏重型模块，增加 Brotli/gzip 预压缩、ETag 与 304 缓存。\n- 优化编辑器、笔记切换和开发环境启动性能。`;

{
  const file = "CHANGELOG.md";
  const content = read(file);
  if (!content.includes("## v1.4.6 -")) {
    const marker = "<!-- ADD_NEW_HERE -->\n";
    if (!content.includes(marker)) throw new Error("CHANGELOG marker missing");
    write(file, content.replace(marker, `${marker}\n## v${releaseVersion} - ${releaseDate}\n\n${releaseBody}\n\n`));
  }
}

updateJson("frontend/public/changelog.json", (value) => {
  value.generatedAt = new Date().toISOString();
  value.entries ||= [];
  value.entries = value.entries.filter((entry) => entry.version !== releaseVersion);
  value.entries.unshift({ version: releaseVersion, date: releaseDate, body: releaseBody });
});

// 9. Keep a permanent release identity regression test.
write("scripts/tests/release-version-consistency.test.mjs", `import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport test from "node:test";\n\nconst json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));\n\ntest("release version sources stay consistent", () => {\n  const root = json("package.json");\n  const rootLock = json("package-lock.json");\n  const backend = json("backend/package.json");\n  const backendLock = json("backend/package-lock.json");\n  const frontend = json("frontend/package.json");\n  const changelog = json("frontend/public/changelog.json");\n  const android = fs.readFileSync("frontend/android/app/build.gradle", "utf8");\n  const markdown = fs.readFileSync("CHANGELOG.md", "utf8");\n\n  assert.match(root.version, /^\\d+\\.\\d+\\.\\d+$/);\n  assert.equal(rootLock.version, root.version);\n  assert.equal(rootLock.packages[""].version, root.version);\n  assert.equal(backend.version, root.version);\n  assert.equal(backendLock.version, root.version);\n  assert.equal(backendLock.packages[""].version, root.version);\n  assert.equal(changelog.entries[0].version, root.version);\n  assert.match(markdown, new RegExp(\`## v\${root.version.replace(/\\./g, "\\\\.")} - \\d{4}-\\d{2}-\\d{2}\`));\n\n  const [major, minor, patch] = root.version.split(".").map(Number);\n  const expectedCode = major * 10_000 + minor * 100 + patch;\n  assert.match(android, new RegExp(\`versionName \\\"\${root.version.replace(/\\./g, "\\\\.")}\\\"\`));\n  assert.match(android, new RegExp(\`versionCode\\\\s+\${expectedCode}\\\\b\`));\n  assert.equal(frontend.engines?.node, ">=22.0.0");\n});\n`);

updateJson("package.json", (pkg) => {
  const command = "node --test scripts/tests/release-version-consistency.test.mjs";
  if (!String(pkg.scripts["test:update-release"] || "").includes("release-version-consistency")) {
    pkg.scripts["test:update-release"] = `${pkg.scripts["test:update-release"]} scripts/tests/release-version-consistency.test.mjs`;
  }
});

// 10. Update source-contract tests for the two event-handling fixes.
{
  const file = "frontend/src/components/daily-records/__tests__/dailyJournalContentPreview.test.tsx";
  let content = read(file);
  if (!content.includes("event.defaultPrevented")) {
    content = content.replace(
      `    expect(viewSource).not.toContain('className="w-full min-h-[190px] text-left"');\n`,
      `    expect(viewSource).not.toContain('className="w-full min-h-[190px] text-left"');\n    expect(previewSource).toContain("if (event.defaultPrevented) return");\n`,
    );
    write(file, content);
  }
}

{
  const file = "frontend/src/lib/__tests__/noteImageExportBridge.test.ts";
  let content = read(file);
  content = content.replace(
    `  NOTE_IMAGE_EXPORT_REQUEST_EVENT,\n`,
    `  DEFERRED_FEATURE_CENTERS_NEEDED_EVENT,\n  NOTE_IMAGE_EXPORT_REQUEST_EVENT,\n`,
  );
  content = content.replace(
    `  requestNoteImageExport,\n`,
    `  requestNoteImageExport,\n  setNoteImageExportCenterReady,\n`,
  );
  content = content.replace(
    `afterEach(() => {\n  cancelAllNoteImageExportRequests();\n`,
    `afterEach(() => {\n  setNoteImageExportCenterReady(false);\n  cancelAllNoteImageExportRequests();\n`,
  );
  content = content.replace(
    `  it("dispatches only prepared timestamps to the shared image export center", async () => {\n`,
    `  it("dispatches only after the deferred center reports ready", async () => {\n    const needed = new Promise<void>((resolve) => {\n      window.addEventListener(DEFERRED_FEATURE_CENTERS_NEEDED_EVENT, () => resolve(), { once: true });\n    });\n`,
  );
  content = content.replace(
    `    const detail = await detailPromise;\n`,
    `    await needed;\n    setNoteImageExportCenterReady(true);\n    const detail = await detailPromise;\n`,
  );
  write(file, content);
}

console.log("Applied v1.4.6 release-review fixes");
