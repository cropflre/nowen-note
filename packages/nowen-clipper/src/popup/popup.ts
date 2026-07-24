import {
  getAccountState,
  getConfig,
  isConfigured,
  normalizeBaseUrl,
  resetAccountState,
  setAccountState,
  setConfig,
  type AccountCaptureState,
  type NowenClipperConfig,
} from "../lib/storage";
import { listNotebooks, listWorkspaces, type NotebookSummary, type WorkspaceSummary } from "../lib/api";
import { describeRuntimeMessageError } from "../lib/runtime-message-error";
import type {
  AIEnhanceMode,
  AIEnhanceTasks,
  ClipMode,
  ClipProgress,
  ClipRequest,
  EnhancedClipRequest,
  EnhancedClipResponse,
} from "../lib/protocol";

let config: NowenClipperConfig;
let accountState: AccountCaptureState;
let workspaces: WorkspaceSummary[] = [];
let notebooks: NotebookSummary[] = [];
let activeTab: chrome.tabs.Tab | undefined;

async function init() {
  config = await getConfig();
  const notConfigured = byId("not-configured");
  const main = byId("main");

  byId("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  byId("open-options-footer").addEventListener("click", () => chrome.runtime.openOptionsPage());

  if (!isConfigured(config)) {
    notConfigured.classList.remove("hidden");
    main.classList.add("hidden");
    return;
  }

  notConfigured.classList.add("hidden");
  main.classList.remove("hidden");
  accountState = await getAccountState(config);

  byId("server-preview").textContent = shortUrl(config.serverUrl);
  byId("account-preview").textContent = config.displayName || config.username || "已登录";
  input("tags").value = config.defaultTags || "";
  select("image-mode").value = accountState.imageMode;
  select("output-format").value = accountState.outputFormat;
  checkbox("pin-note").checked = accountState.isPinned;
  select("clip-mode").value = accountState.clipMode;

  checkbox("ai-enhance").checked = config.aiEnhanceEnabled;
  select("ai-mode").value = config.aiEnhanceMode;
  document.querySelectorAll<HTMLInputElement>("#ai-details input[data-task]").forEach((element) => {
    const key = element.dataset.task as keyof AIEnhanceTasks;
    element.checked = !!config.aiEnhanceTasks[key];
  });

  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageTitle = activeTab?.title || "当前页面";
  byId("page-title").textContent = pageTitle;
  byId("page-title").setAttribute("title", pageTitle);

  await loadLocations();
  bindEvents();
  updateModeUi();
}

async function loadLocations() {
  const workspaceSelect = select("workspace");
  workspaceSelect.disabled = true;
  select("notebook").disabled = true;
  setPermissionHint("正在加载可写位置...", "neutral");

  try {
    workspaces = await listWorkspaces(config);
  } catch (error: any) {
    workspaces = [];
    setPermissionHint(`工作区加载失败：${String(error?.message || error)}`, "error");
  }

  workspaceSelect.innerHTML = "";
  workspaceSelect.append(new Option("👤 个人空间", "personal"));
  for (const workspace of workspaces) {
    const writable = workspace.role !== "viewer";
    const option = new Option(
      `${workspace.icon || "🏢"} ${workspace.name}${writable ? "" : "（只读）"}`,
      workspace.id,
    );
    option.disabled = !writable;
    workspaceSelect.append(option);
  }

  const rememberedWorkspace = accountState.workspaceId || "personal";
  const exists = rememberedWorkspace === "personal" || workspaces.some((workspace) => workspace.id === rememberedWorkspace);
  workspaceSelect.value = exists ? rememberedWorkspace : "personal";
  workspaceSelect.disabled = false;
  await loadNotebooksForWorkspace(workspaceSelect.value, accountState.notebookId);
}

async function loadNotebooksForWorkspace(workspaceValue: string, preferredNotebookId = "") {
  const notebookSelect = select("notebook");
  notebookSelect.disabled = true;
  notebookSelect.innerHTML = "";
  notebookSelect.append(new Option("正在加载笔记本...", ""));

  const workspaceId = workspaceValue === "personal" ? null : workspaceValue;
  try {
    notebooks = await listNotebooks(config, workspaceId);
    notebookSelect.innerHTML = "";
    notebookSelect.append(new Option(`自动使用/创建「${config.defaultNotebook || "Web 剪藏"}」`, ""));

    const labels = buildNotebookLabels(notebooks);
    for (const notebook of [...notebooks].sort((a, b) => labels.get(a.id)!.localeCompare(labels.get(b.id)!))) {
      notebookSelect.append(new Option(labels.get(notebook.id) || notebook.name, notebook.id));
    }

    notebookSelect.value = preferredNotebookId && notebooks.some((notebook) => notebook.id === preferredNotebookId)
      ? preferredNotebookId
      : "";
    notebookSelect.disabled = false;
    updatePermissionState();
  } catch (error: any) {
    notebooks = [];
    notebookSelect.innerHTML = "";
    notebookSelect.append(new Option("无法加载笔记本", ""));
    setPermissionHint(`笔记本加载失败：${String(error?.message || error)}`, "error");
  }
}

function bindEvents() {
  select("clip-mode").addEventListener("change", async () => {
    await persistState({ clipMode: currentMode() });
    updateModeUi();
  });

  select("workspace").addEventListener("change", async () => {
    const workspaceId = select("workspace").value;
    await persistState({ workspaceId, notebookId: "", notebookLabel: "" });
    await loadNotebooksForWorkspace(workspaceId);
    updateModeUi();
  });

  select("notebook").addEventListener("change", async () => {
    const notebookId = select("notebook").value;
    const notebookLabel = select("notebook").selectedOptions[0]?.textContent || "";
    await persistState({ notebookId, notebookLabel });
  });

  select("image-mode").addEventListener("change", () => {
    void persistState({ imageMode: select("image-mode").value as AccountCaptureState["imageMode"] });
  });
  select("output-format").addEventListener("change", () => {
    void persistState({ outputFormat: select("output-format").value as AccountCaptureState["outputFormat"] });
  });
  checkbox("pin-note").addEventListener("change", () => {
    void persistState({ isPinned: checkbox("pin-note").checked });
  });

  checkbox("ai-enhance").addEventListener("change", () => {
    if (checkbox("ai-enhance").checked) byId("ai-details").classList.remove("hidden");
  });
  byId("ai-toggle-details").addEventListener("click", () => byId("ai-details").classList.toggle("hidden"));

  byId("clip").addEventListener("click", () => void save());
  byId("reset-current-account").addEventListener("click", async () => {
    accountState = await resetAccountState(config);
    select("clip-mode").value = accountState.clipMode;
    select("image-mode").value = accountState.imageMode;
    select("output-format").value = accountState.outputFormat;
    checkbox("pin-note").checked = accountState.isPinned;
    select("workspace").value = "personal";
    await loadNotebooksForWorkspace("personal");
    updateModeUi();
    showResult({ ok: true, noteTitle: "已恢复当前账号的默认选择" }, true);
  });
}

async function save() {
  const button = byId("clip") as HTMLButtonElement;
  clearResult();
  if (!canWriteSelectedWorkspace()) {
    showResult({ ok: false, error: "当前工作区为只读权限，请选择可写空间" });
    return;
  }

  const mode = currentMode();
  const workspaceValue = select("workspace").value;
  if ((mode === "screenshot" || mode === "fullScreenshot") && workspaceValue !== "personal") {
    showResult({ ok: false, error: "截图模式暂不支持保存到工作区，请选择个人空间或使用正文剪藏" });
    return;
  }

  const tags = parseTags(input("tags").value);
  const notebookId = select("notebook").value || undefined;
  const notebookName = notebookId
    ? notebooks.find((notebook) => notebook.id === notebookId)?.name
    : (config.defaultNotebook || "Web 剪藏");

  await Promise.all([
    persistState({
      clipMode: mode,
      workspaceId: workspaceValue,
      notebookId: notebookId || "",
      notebookLabel: select("notebook").selectedOptions[0]?.textContent || "",
      imageMode: select("image-mode").value as AccountCaptureState["imageMode"],
      outputFormat: select("output-format").value as AccountCaptureState["outputFormat"],
      isPinned: checkbox("pin-note").checked,
    }),
    setConfig({
      aiEnhanceEnabled: checkbox("ai-enhance").checked,
      aiEnhanceMode: select("ai-mode").value as AIEnhanceMode,
      aiEnhanceTasks: collectAiTasks(),
    }).catch(() => undefined),
  ]);

  if (mode === "screenshot" || mode === "fullScreenshot") {
    if (!activeTab?.id) {
      showResult({ ok: false, error: "未找到当前标签页" });
      return;
    }
    const legacy: ClipRequest = {
      type: "CLIP_REQUEST",
      mode,
      tabId: activeTab.id,
      overrideNotebook: notebookName,
      overrideTags: tags.join(","),
      comment: textarea("comment").value.trim() || undefined,
    };
    void chrome.runtime.sendMessage(legacy).catch(() => undefined);
    window.close();
    return;
  }

  const request: EnhancedClipRequest = {
    type: "ENHANCED_CLIP_REQUEST",
    mode,
    tabId: activeTab?.id,
    targetWorkspaceId: workspaceValue === "personal" ? null : workspaceValue,
    targetNotebookId: notebookId,
    targetNotebookName: notebookName,
    tags,
    comment: textarea("comment").value.trim() || undefined,
    isPinned: checkbox("pin-note").checked,
    imageMode: select("image-mode").value as EnhancedClipRequest["imageMode"],
    outputFormat: select("output-format").value as EnhancedClipRequest["outputFormat"],
    quickNote: mode === "quickNote"
      ? {
          title: input("quick-title").value.trim() || undefined,
          content: textarea("quick-content").value,
        }
      : undefined,
    aiEnhance: mode !== "quickNote" && checkbox("ai-enhance").checked,
    aiTasks: collectAiTasks(),
    aiMode: select("ai-mode").value as AIEnhanceMode,
  };

  button.disabled = true;
  byId("progress").classList.remove("hidden");
  byId("progress-text").textContent = "准备中...";

  const progressHandler = (message: ClipProgress) => {
    if (message?.type === "CLIP_PROGRESS") byId("progress-text").textContent = message.message;
  };
  chrome.runtime.onMessage.addListener(progressHandler);

  try {
    const response = await chrome.runtime.sendMessage(request) as EnhancedClipResponse;
    showResult(response);
    if (response.ok && mode === "quickNote") {
      input("quick-title").value = "";
      textarea("quick-content").value = "";
    }
  } catch (error: any) {
    showResult({
      ok: false,
      error: describeRuntimeMessageError(error),
      errorCode: "BACKGROUND_UNAVAILABLE",
    });
  } finally {
    chrome.runtime.onMessage.removeListener(progressHandler);
    byId("progress").classList.add("hidden");
    button.disabled = false;
  }
}

function updateModeUi() {
  const mode = currentMode();
  const quick = mode === "quickNote";
  const screenshot = mode === "screenshot" || mode === "fullScreenshot";
  byId("quick-note-panel").classList.toggle("hidden", !quick);
  byId("page-title-row").classList.toggle("hidden", quick);
  byId("web-options-panel").classList.toggle("hidden", quick || screenshot);
  byId("image-option").classList.toggle("hidden", quick || screenshot || mode === "simplified");
  select("output-format").disabled = mode === "fullpage" || screenshot;
  if (mode === "fullpage") select("output-format").value = "html";
  byId("clip").textContent = quick ? "保存速记" : screenshot ? "开始截图" : "剪藏到 Nowen Note";
  updatePermissionState();
}

function updatePermissionState() {
  const writable = canWriteSelectedWorkspace();
  const badge = byId("permission-badge");
  badge.textContent = writable ? "可写" : "只读";
  badge.classList.toggle("readonly", !writable);

  const mode = currentMode();
  if (!writable) {
    setPermissionHint("当前账号在该工作区只有查看权限，无法创建笔记。", "error");
  } else if ((mode === "screenshot" || mode === "fullScreenshot") && select("workspace").value !== "personal") {
    setPermissionHint("截图模式暂只支持个人空间；正文、选区和速记支持工作区。", "warning");
  } else {
    setPermissionHint("保存前会由服务器再次校验笔记本写权限。", "success");
  }
  (byId("clip") as HTMLButtonElement).disabled = !writable;
}

function canWriteSelectedWorkspace(): boolean {
  const id = select("workspace").value;
  if (!id || id === "personal") return true;
  return workspaces.find((workspace) => workspace.id === id)?.role !== "viewer";
}

function buildNotebookLabels(items: NotebookSummary[]): Map<string, string> {
  const byNotebookId = new Map(items.map((item) => [item.id, item]));
  const labels = new Map<string, string>();
  for (const item of items) {
    const path: string[] = [];
    const visited = new Set<string>();
    let current: NotebookSummary | undefined = item;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current.name);
      current = current.parentId ? byNotebookId.get(current.parentId) : undefined;
    }
    labels.set(item.id, path.join(" / "));
  }
  return labels;
}

function showResult(response: EnhancedClipResponse, informational = false) {
  const result = byId("result");
  const message = byId("result-message");
  const link = byId("result-link") as HTMLAnchorElement;
  const warningList = byId("warning-list");
  const failures = byId("image-failures");
  const failureList = byId("image-failure-list");

  result.classList.remove("hidden", "ok", "err");
  result.classList.add(response.ok ? "ok" : "err");
  message.textContent = informational
    ? response.noteTitle || "已完成"
    : response.ok
      ? `✅ 已保存「${response.noteTitle || "无标题"}」${response.images?.ok ? `，本地化 ${response.images.ok} 张图片` : ""}`
      : `❌ ${response.error || "保存失败"}`;

  if (response.noteUrl) {
    link.href = response.noteUrl;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }

  if (response.warnings?.length) {
    warningList.textContent = response.warnings.join("\n");
    warningList.classList.remove("hidden");
  } else {
    warningList.classList.add("hidden");
  }

  const imageFailures = response.images?.failures || [];
  failureList.innerHTML = "";
  for (const item of imageFailures) {
    const li = document.createElement("li");
    li.textContent = `${shortResource(item.url)} — ${item.error}`;
    li.title = item.url;
    failureList.append(li);
  }
  failures.classList.toggle("hidden", imageFailures.length === 0);
}

function clearResult() {
  byId("result").classList.add("hidden");
  byId("warning-list").classList.add("hidden");
  byId("image-failures").classList.add("hidden");
}

async function persistState(patch: Partial<AccountCaptureState>) {
  accountState = await setAccountState(config, patch);
}

function collectAiTasks(): AIEnhanceTasks {
  const tasks: AIEnhanceTasks = {};
  document.querySelectorAll<HTMLInputElement>("#ai-details input[data-task]").forEach((element) => {
    const key = element.dataset.task as keyof AIEnhanceTasks;
    if (element.checked) tasks[key] = true;
  });
  return tasks;
}

function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean))).slice(0, 20);
}

function currentMode(): ClipMode {
  return select("clip-mode").value as ClipMode;
}

function setPermissionHint(message: string, tone: "neutral" | "success" | "warning" | "error") {
  const element = byId("permission-hint");
  element.textContent = message;
  element.dataset.tone = tone;
}

function shortUrl(value: string): string {
  try {
    return new URL(normalizeBaseUrl(value)).host;
  } catch {
    return value;
  }
}

function shortResource(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.host}${parsed.pathname}`.slice(0, 80);
  } catch {
    return value.slice(0, 80);
  }
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}
function input(id: string): HTMLInputElement {
  return byId(id) as HTMLInputElement;
}
function textarea(id: string): HTMLTextAreaElement {
  return byId(id) as HTMLTextAreaElement;
}
function select(id: string): HTMLSelectElement {
  return byId(id) as HTMLSelectElement;
}
function checkbox(id: string): HTMLInputElement {
  return byId(id) as HTMLInputElement;
}

void init();
