/**
 * Options 页：所有配置项 + 登录认证。
 */
import { getConfig, setConfig, normalizeBaseUrl, type NowenClipperConfig } from "../lib/storage";
import { login, verify2FA, ping } from "../lib/api";

/** 暂存 2FA ticket（登录第一步返回 requires2FA 时保存） */
let pending2FATicket = "";
let pending2FAServerUrl = "";

async function init() {
  const cfg = await getConfig();

  // 基础字段
  (document.getElementById("serverUrl") as HTMLInputElement).value = cfg.serverUrl;
  (document.getElementById("username") as HTMLInputElement).value = cfg.username;
  (document.getElementById("defaultNotebook") as HTMLInputElement).value = cfg.defaultNotebook;
  (document.getElementById("defaultTags") as HTMLInputElement).value = cfg.defaultTags;
  (document.getElementById("imageMode") as HTMLSelectElement).value = cfg.imageMode;
  (document.getElementById("outputFormat") as HTMLSelectElement).value = cfg.outputFormat;
  (document.getElementById("includeSource") as HTMLInputElement).checked = cfg.includeSource;

  // 密码切换
  document.getElementById("toggle-password")!.addEventListener("click", () => {
    const el = document.getElementById("password") as HTMLInputElement;
    el.type = el.type === "password" ? "text" : "password";
  });

  // 登录按钮
  document.getElementById("login-btn")!.addEventListener("click", onLogin);
  // 2FA 验证按钮
  document.getElementById("twofa-btn")!.addEventListener("click", on2FAVerify);
  // 退出 & 重新登录
  document.getElementById("logout-btn")!.addEventListener("click", onLogout);
  document.getElementById("relogin-btn")!.addEventListener("click", onRelogin);
  // 保存
  document.getElementById("save")!.addEventListener("click", onSave);

  // 检查现有登录状态
  if (cfg.token) {
    try {
      const r = await ping(cfg);
      showLoggedIn(r.username, r.role);
    } catch {
      // token 已失效，显示登录表单
      showLoginForm();
    }
  } else {
    showLoginForm();
  }
}

/** 显示登录表单，隐藏状态卡片 */
function showLoginForm() {
  document.getElementById("login-card")!.classList.remove("hidden");
  document.getElementById("status-card")!.classList.add("hidden");
}

/** 显示已登录状态，隐藏登录表单 */
function showLoggedIn(username: string, role: string) {
  document.getElementById("login-card")!.classList.add("hidden");
  document.getElementById("status-card")!.classList.remove("hidden");
  document.getElementById("status-user")!.textContent = `${username}（${role}）`;
}

async function onLogin() {
  const el = document.getElementById("login-result")!;
  el.className = "test-result";
  el.textContent = "登录中...";

  const serverUrl = normalizeBaseUrl(
    (document.getElementById("serverUrl") as HTMLInputElement).value,
  );
  const username = (document.getElementById("username") as HTMLInputElement).value.trim();
  const password = (document.getElementById("password") as HTMLInputElement).value;

  if (!serverUrl) {
    el.classList.add("err");
    el.textContent = "请先填写服务器地址";
    return;
  }
  if (!username || !password) {
    el.classList.add("err");
    el.textContent = "请填写用户名和密码";
    return;
  }

  try {
    const r = await login(serverUrl, username, password);

    // 2FA 拦截
    if (r.requires2FA && r.ticket) {
      pending2FATicket = r.ticket;
      pending2FAServerUrl = serverUrl;
      el.classList.add("ok");
      el.textContent = `密码验证通过，请输入两步验证码（${r.username}）`;
      document.getElementById("twofa-section")!.classList.remove("hidden");
      (document.getElementById("twofa-code") as HTMLInputElement).focus();
      return;
    }

    // 登录成功
    await handleLoginSuccess(serverUrl, username, r);
    el.classList.add("ok");
    el.textContent = `✅ 登录成功`;
  } catch (e: any) {
    el.classList.add("err");
    el.textContent = `❌ ${String(e?.message || e)}`;
  }
}

async function on2FAVerify() {
  const el = document.getElementById("twofa-result")!;
  el.className = "test-result";
  el.textContent = "验证中...";

  const code = (document.getElementById("twofa-code") as HTMLInputElement).value.trim();
  if (!code) {
    el.classList.add("err");
    el.textContent = "请输入验证码";
    return;
  }

  try {
    const r = await verify2FA(pending2FAServerUrl, pending2FATicket, code);
    const username = (document.getElementById("username") as HTMLInputElement).value.trim();
    await handleLoginSuccess(pending2FAServerUrl, username, r);
    el.classList.add("ok");
    el.textContent = "✅ 验证成功";
    document.getElementById("twofa-section")!.classList.add("hidden");
  } catch (e: any) {
    el.classList.add("err");
    el.textContent = `❌ ${String(e?.message || e)}`;
  }
}

async function handleLoginSuccess(serverUrl: string, username: string, r: { token: string; user: { role: string; displayName?: string | null } }) {
  await setConfig({
    serverUrl,
    username,
    token: r.token,
    displayName: r.user.displayName || username,
  });
  showLoggedIn(username, r.user.role);
  // 清除密码字段
  (document.getElementById("password") as HTMLInputElement).value = "";
}

async function onLogout() {
  await setConfig({ token: "", displayName: "" });
  showLoginForm();
  const el = document.getElementById("login-result")!;
  el.className = "test-result ok";
  el.textContent = "已退出登录";
  setTimeout(() => (el.textContent = ""), 2000);
}

function onRelogin() {
  showLoginForm();
  (document.getElementById("login-result")!).textContent = "";
}

function readForm(): Partial<NowenClipperConfig> {
  return {
    serverUrl: normalizeBaseUrl(
      (document.getElementById("serverUrl") as HTMLInputElement).value,
    ),
    defaultNotebook: (document.getElementById("defaultNotebook") as HTMLInputElement).value.trim(),
    defaultTags: (document.getElementById("defaultTags") as HTMLInputElement).value.trim(),
    imageMode: (document.getElementById("imageMode") as HTMLSelectElement).value as any,
    outputFormat: (document.getElementById("outputFormat") as HTMLSelectElement).value as any,
    includeSource: (document.getElementById("includeSource") as HTMLInputElement).checked,
  };
}

async function onSave() {
  const el = document.getElementById("save-result")!;
  el.className = "save-result";
  const patch = readForm();
  await setConfig(patch);
  el.classList.add("ok");
  el.textContent = "已保存";
  setTimeout(() => (el.textContent = ""), 2000);
}

void init();
