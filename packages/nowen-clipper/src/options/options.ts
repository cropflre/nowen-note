import {
  getConfig,
  normalizeBaseUrl,
  resetAccountState,
  setConfig,
  type NowenClipperConfig,
} from "../lib/storage";
import { login, ping, verify2FA } from "../lib/api";
import type { AIEnhanceTasks } from "../lib/protocol";

let pending2FATicket = "";
let pending2FAServerUrl = "";
let currentConfig: NowenClipperConfig;

async function init() {
  currentConfig = await getConfig();
  fillForm(currentConfig);

  byId("toggle-password").addEventListener("click", () => {
    const element = input("password");
    element.type = element.type === "password" ? "text" : "password";
  });
  byId("login-btn").addEventListener("click", () => void onLogin());
  byId("twofa-btn").addEventListener("click", () => void on2FAVerify());
  byId("logout-btn").addEventListener("click", () => void onLogout());
  byId("relogin-btn").addEventListener("click", onRelogin);
  byId("save").addEventListener("click", () => void onSave());
  byId("reset-account-preferences").addEventListener("click", () => void onResetAccountPreferences());

  if (currentConfig.token) {
    try {
      const user = await ping(currentConfig);
      if (user.id && currentConfig.userId !== user.id) {
        currentConfig = await setConfig({ userId: user.id });
      }
      showLoggedIn(user.username, user.role);
    } catch {
      showLoginForm();
    }
  } else {
    showLoginForm();
  }
}

function fillForm(config: NowenClipperConfig) {
  input("serverUrl").value = config.serverUrl;
  input("username").value = config.username;
  input("defaultNotebook").value = config.defaultNotebook;
  input("defaultTags").value = config.defaultTags;
  select("imageMode").value = config.imageMode;
  select("outputFormat").value = config.outputFormat;
  checkbox("includeSource").checked = config.includeSource;

  checkbox("lazyLoadScroll").checked = config.lazyLoadScroll;
  input("maxImageCount").value = String(config.maxImageCount);
  input("maxSingleImageMb").value = bytesToMegabytes(config.maxSingleImageBytes);
  input("maxTotalImageMb").value = bytesToMegabytes(config.maxTotalImageBytes);
  input("imageTimeoutSeconds").value = String(Math.max(1, Math.round(config.imageTimeoutMs / 1000)));

  checkbox("aiEnhanceEnabled").checked = config.aiEnhanceEnabled;
  select("aiEnhanceMode").value = config.aiEnhanceMode;
  select("aiEnhanceLanguage").value = config.aiEnhanceLanguage;
  input("aiMaxInputChars").value = String(config.aiMaxInputChars);
  select("aiFailureStrategy").value = config.aiFailureStrategy;
  textarea("aiCustomInstruction").value = config.aiCustomInstruction;
  document.querySelectorAll<HTMLInputElement>('.ai-tasks-grid input[data-task]').forEach((element) => {
    const key = element.dataset.task as keyof AIEnhanceTasks;
    element.checked = !!config.aiEnhanceTasks[key];
  });
}

function showLoginForm() {
  byId("login-card").classList.remove("hidden");
  byId("status-card").classList.add("hidden");
}

function showLoggedIn(username: string, role: string) {
  byId("login-card").classList.add("hidden");
  byId("status-card").classList.remove("hidden");
  byId("status-user").textContent = `${username}（${role}）`;
}

async function onLogin() {
  const result = byId("login-result");
  setInlineStatus(result, "登录中...");

  const serverUrl = normalizeBaseUrl(input("serverUrl").value);
  const username = input("username").value.trim();
  const password = input("password").value;

  if (!serverUrl) {
    setInlineStatus(result, "请先填写服务器地址", "err");
    return;
  }
  if (!username || !password) {
    setInlineStatus(result, "请填写用户名和密码", "err");
    return;
  }

  try {
    const response = await login(serverUrl, username, password);
    if (response.requires2FA && response.ticket) {
      pending2FATicket = response.ticket;
      pending2FAServerUrl = serverUrl;
      setInlineStatus(result, `密码验证通过，请输入两步验证码（${response.username || username}）`, "ok");
      byId("twofa-section").classList.remove("hidden");
      input("twofa-code").focus();
      return;
    }

    await handleLoginSuccess(serverUrl, username, response);
    setInlineStatus(result, "✅ 登录成功", "ok");
  } catch (error: any) {
    setInlineStatus(result, `❌ ${String(error?.message || error)}`, "err");
  }
}

async function on2FAVerify() {
  const result = byId("twofa-result");
  setInlineStatus(result, "验证中...");
  const code = input("twofa-code").value.trim();
  if (!code) {
    setInlineStatus(result, "请输入验证码", "err");
    return;
  }

  try {
    const response = await verify2FA(pending2FAServerUrl, pending2FATicket, code);
    const username = input("username").value.trim();
    await handleLoginSuccess(pending2FAServerUrl, username, response);
    setInlineStatus(result, "✅ 验证成功", "ok");
    byId("twofa-section").classList.add("hidden");
  } catch (error: any) {
    setInlineStatus(result, `❌ ${String(error?.message || error)}`, "err");
  }
}

async function handleLoginSuccess(
  serverUrl: string,
  username: string,
  response: { token: string; user: { id: string; role: string; displayName?: string | null } },
) {
  currentConfig = await setConfig({
    serverUrl,
    username,
    userId: response.user.id,
    token: response.token,
    displayName: response.user.displayName || username,
  });
  showLoggedIn(username, response.user.role);
  input("password").value = "";
}

async function onLogout() {
  currentConfig = await setConfig({ token: "", displayName: "", userId: "" });
  showLoginForm();
  setInlineStatus(byId("login-result"), "已退出登录", "ok");
  window.setTimeout(() => {
    byId("login-result").textContent = "";
  }, 2000);
}

function onRelogin() {
  showLoginForm();
  byId("login-result").textContent = "";
}

function readForm(): Partial<NowenClipperConfig> {
  const aiTasks: AIEnhanceTasks = {};
  document.querySelectorAll<HTMLInputElement>('.ai-tasks-grid input[data-task]').forEach((element) => {
    const key = element.dataset.task as keyof AIEnhanceTasks;
    if (element.checked) aiTasks[key] = true;
  });

  const maxInputChars = clampInt(input("aiMaxInputChars").value, 6000, 1000, 12000);
  const maxImageCount = clampInt(input("maxImageCount").value, 120, 1, 500);
  const maxSingleImageMb = clampInt(input("maxSingleImageMb").value, 8, 1, 50);
  const maxTotalImageMb = clampInt(input("maxTotalImageMb").value, 60, maxSingleImageMb, 250);
  const imageTimeoutSeconds = clampInt(input("imageTimeoutSeconds").value, 10, 1, 30);

  return {
    serverUrl: normalizeBaseUrl(input("serverUrl").value),
    defaultNotebook: input("defaultNotebook").value.trim(),
    defaultTags: input("defaultTags").value.trim(),
    imageMode: select("imageMode").value as NowenClipperConfig["imageMode"],
    outputFormat: select("outputFormat").value as NowenClipperConfig["outputFormat"],
    includeSource: checkbox("includeSource").checked,
    lazyLoadScroll: checkbox("lazyLoadScroll").checked,
    maxImageCount,
    maxSingleImageBytes: maxSingleImageMb * 1024 * 1024,
    maxTotalImageBytes: maxTotalImageMb * 1024 * 1024,
    imageTimeoutMs: imageTimeoutSeconds * 1000,

    aiEnhanceEnabled: checkbox("aiEnhanceEnabled").checked,
    aiEnhanceTasks: aiTasks,
    aiEnhanceMode: select("aiEnhanceMode").value as NowenClipperConfig["aiEnhanceMode"],
    aiEnhanceLanguage: select("aiEnhanceLanguage").value as NowenClipperConfig["aiEnhanceLanguage"],
    aiMaxInputChars: maxInputChars,
    aiFailureStrategy: select("aiFailureStrategy").value as NowenClipperConfig["aiFailureStrategy"],
    aiCustomInstruction: textarea("aiCustomInstruction").value.trim(),
  };
}

async function onSave() {
  const result = byId("save-result");
  setInlineStatus(result, "保存中...");
  try {
    currentConfig = await setConfig(readForm());
    fillForm(currentConfig);
    setInlineStatus(result, "已保存", "ok");
    window.setTimeout(() => {
      result.textContent = "";
    }, 2000);
  } catch (error: any) {
    setInlineStatus(result, `保存失败：${String(error?.message || error)}`, "err");
  }
}

async function onResetAccountPreferences() {
  const result = byId("reset-result");
  if (!currentConfig.serverUrl || (!currentConfig.userId && !currentConfig.username)) {
    setInlineStatus(result, "请先登录账号", "err");
    return;
  }
  try {
    await resetAccountState(currentConfig);
    setInlineStatus(result, "已恢复当前账号默认选择", "ok");
  } catch (error: any) {
    setInlineStatus(result, `恢复失败：${String(error?.message || error)}`, "err");
  }
}

function setInlineStatus(element: HTMLElement, message: string, tone?: "ok" | "err") {
  element.className = element.id.includes("result") && element.id !== "login-result" && element.id !== "twofa-result"
    ? "save-result"
    : "test-result";
  if (tone) element.classList.add(tone);
  element.textContent = message;
}

function bytesToMegabytes(bytes: number): string {
  return String(Math.max(1, Math.round(bytes / 1024 / 1024)));
}

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
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
