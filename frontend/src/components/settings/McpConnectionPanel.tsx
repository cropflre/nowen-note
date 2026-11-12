import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, ClipboardCopy, Globe2, LockKeyhole, Network, ShieldCheck, Terminal } from "lucide-react";
import { api, getBaseUrl, type EmbeddedMcpStatus } from "@/lib/api";
import { toast } from "@/lib/toast";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import type { MigrationClientId } from "@/lib/migrationClientSetup";
import MigrationConnectionSetup from "./MigrationConnectionSetup";

const capabilities = [
  { title: "笔记与知识树", detail: "搜索、整理、版本冲突保护", scope: "notes:read · notes:write · notebooks:write" },
  { title: "个人任务", detail: "任务与子任务、具体截止时间、提醒、归档、任务转笔记", scope: "tasks:read · tasks:write" },
  { title: "个人网盘", detail: "文件整理、恢复，不支持永久删除", scope: "notes:read · attachments:write" },
  { title: "个人自动化", detail: "工作流预览、编辑、启停和运行历史", scope: "automations:read · automations:write" },
];

function copyText(value: string) {
  void navigator.clipboard.writeText(value).then(
    () => toast.success("已复制配置，可粘贴到 MCP 客户端"),
    () => toast.error("复制失败，请手动选择文本"),
  );
}

export default function McpConnectionPanel({ purpose, client, notebooks }: {
  purpose?: "migration"; client?: MigrationClientId; notebooks?: { id: string; name: string }[];
} = {}) {
  return purpose === "migration" ? <MigrationConnectionSetup client={client} notebooks={notebooks}/> : <GeneralMcpConnectionPanel/>;
}

function GeneralMcpConnectionPanel() {
  const [mode, setMode] = useState<"stdio" | "http" | "standalone-http">("http");
  const [remoteUrl, setRemoteUrl] = useState("https://your-domain.example/mcp");
  const [service, setService] = useState<EmbeddedMcpStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [testToken, setTestToken] = useState("");
  const [checked, setChecked] = useState<"idle" | "ok" | "error">("idle");
  const [checking, setChecking] = useState(false);
  const testController = useRef<AbortController | null>(null);
  const scope = getOfflineQueueStorageKey();
  const apiUrl = new URL(getBaseUrl(), window.location.href).href.replace(/\/api\/?$/, "");
  const embeddedUrl = service?.publicUrl || `${apiUrl}/mcp`;
  useEffect(() => {
    testController.current?.abort();
    setChecking(false);
    setChecked("idle");
    setTestToken("");
    return () => { testController.current?.abort(); };
  }, [mode, embeddedUrl, remoteUrl, scope]);
  useEffect(() => {
    let active = true;
    setService(null);
    setLoadError(false);
    setTestToken("");
    setChecked("idle");
    void api.mcp.status().then(status => {
      if (!active) return;
      setService(status);
      setPublicUrl(status.publicUrl || `${apiUrl}/mcp`);
      setAllowWrite(status.allowWrite);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [apiUrl, scope]);

  const saveService = async (enabled: boolean) => {
    setSaving(true);
    setChecked("idle");
    try {
      const status = await api.mcp.configure({ enabled, allowWrite, publicUrl: publicUrl.trim() });
      if (getOfflineQueueStorageKey() !== scope) return;
      setService(status);
      toast.success(enabled ? "MCP 服务已开启" : "MCP 服务已关闭");
    } catch (error) { toast.error(error instanceof Error ? error.message : "MCP 设置保存失败"); }
    finally { setSaving(false); }
  };
  const config = useMemo(() => mode === "stdio"
    ? JSON.stringify({
      mcpServers: {
        "nowen-note": {
          command: "node",
          args: ["/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"],
          env: {
            NOWEN_URL: apiUrl,
            NOWEN_API_TOKEN: "<paste-personal-api-token>",
            MCP_ACCESS_MODE: "read-only",
            ALLOWED_NOTEBOOK_IDS: "<authorized-notebook-id>",
          },
        },
      },
    }, null, 2)
    : JSON.stringify({
      mcpServers: {
        "nowen-note": {
          type: "streamable-http",
          url: mode === "http" ? embeddedUrl : remoteUrl,
          headers: { Authorization: mode === "http" ? "Bearer <your-personal-api-token>" : "Bearer <your-separate-http-gateway-token>" },
        },
      },
    }, null, 2),
  [mode, remoteUrl, apiUrl, embeddedUrl]);

  const checkMcp = async () => {
    const controller = new AbortController();
    testController.current = controller;
    setChecking(true);
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted && getOfflineQueueStorageKey() === scope) setChecked("error");
      controller.abort();
    }, 15_000);
    try {
      const endpoint = mode === "http" ? embeddedUrl : remoteUrl;
      const call = async (method: string, params: unknown, id: number) => {
        const response = await fetch(endpoint, {
          method: "POST", signal: controller.signal, cache: "no-store", credentials: "omit",
          headers: { Authorization: `Bearer ${testToken.trim()}`, "Content-Type": "application/json",
            Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (body.error) throw new Error("MCP 协议错误");
        return body.result;
      };
      const handshake = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "nowen-settings-check", version: "1.0.0" } }, 1);
      if (controller.signal.aborted || getOfflineQueueStorageKey() !== scope) return;
      const listed = await call("tools/list", {}, 2);
      if (controller.signal.aborted || getOfflineQueueStorageKey() !== scope) return;
      setChecked(handshake?.serverInfo?.name === "nowen-note" && Array.isArray(listed?.tools) ? "ok" : "error");
    } catch { if (!controller.signal.aborted && getOfflineQueueStorageKey() === scope) setChecked("error"); }
    finally {
      clearTimeout(timeout);
      if (testController.current === controller) { setChecking(false); setTestToken(""); }
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
            <Network className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">MCP 连接中心</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">连接 AI 客户端，配置权限，查看接入能力</p>
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {capabilities.map((feature) => (
          <div key={feature.title} className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              <Check className="h-3.5 w-3.5 text-emerald-600" />{feature.title}
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{feature.detail}</p>
            <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">{feature.scope}</p>
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-2 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-900">
        <button type="button" onClick={() => setMode("stdio")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${mode === "stdio" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500"}`}>
          <Terminal className="h-3.5 w-3.5" /> 本机 stdio
        </button>
        <button type="button" onClick={() => setMode("http")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${mode === "http" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500"}`}>
          <Globe2 className="h-3.5 w-3.5" /> Docker 内置 MCP
        </button>
        <button type="button" onClick={() => setMode("standalone-http")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${mode === "standalone-http" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500"}`}>
          <Network className="h-3.5 w-3.5" /> 独立 HTTP 网关
        </button>
      </div>
      {mode === "http" && (
        <div className="mt-3 space-y-3 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <p role="status" className="text-zinc-600 dark:text-zinc-300">
            {loadError ? "无法加载 MCP 服务状态，请重新打开设置重试。" : !service ? "正在读取 MCP 服务状态…" :
              !service.available ? "当前安装未包含内置 MCP，请升级至支持此功能的官方 Docker 镜像，或使用独立 HTTP 网关。" :
                service.enabled ? "MCP 服务已开启" : "MCP 服务已关闭（默认）"}
          </p>
          {service?.available && <>
            <label className="block text-xs text-zinc-600 dark:text-zinc-300" htmlFor="embedded-mcp-url">MCP 对外连接地址</label>
            <div className="flex flex-wrap gap-2">
              <input id="embedded-mcp-url" type="url" value={publicUrl} disabled={!service.canManage || saving}
                onChange={event => setPublicUrl(event.target.value)} placeholder="https://note.example.com/mcp"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm dark:border-zinc-700 dark:text-zinc-200" />
              <button type="button" onClick={() => copyText(embeddedUrl)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700 dark:text-zinc-200">复制地址</button>
            </div>
            {service.canManage ? <>
              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <input type="checkbox" checked={allowWrite} disabled={saving} onChange={event => setAllowWrite(event.target.checked)} />
                允许写入（仍需 Token 的写入权限）
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={saving} onClick={() => void saveService(!service.enabled)}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                  {saving ? "保存中…" : service.enabled ? "关闭 MCP 服务" : "开启 MCP 服务"}
                </button>
                {service.enabled && <button type="button" disabled={saving} onClick={() => void saveService(true)}
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700 dark:text-zinc-200">保存配置</button>}
              </div>
            </> : <p className="text-xs text-zinc-500">服务开关由管理员管理；每位用户使用自己的个人访问令牌。</p>}
            <p className="text-xs text-zinc-500">对外访问请使用 HTTPS，反向代理保留 Host。开关和授权随数据卷保留，修改后立即生效。</p>
          </>}
        </div>
      )}
      {mode === "standalone-http" && (
        <div className="mt-3">
          <label htmlFor="mcp-http-endpoint" className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">你的 HTTPS MCP 地址</label>
          <input id="mcp-http-endpoint" type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm text-zinc-700 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:text-zinc-200"
            placeholder="https://mcp.example.com/mcp" />
        </div>
      )}
      {mode !== "stdio" && <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor="mcp-test-token" className="w-full text-xs text-zinc-500">{mode === "http" ? "个人 API Token" : "独立网关密钥"}（仅用于本次检测，检测后清除）</label>
        <input id="mcp-test-token" type="password" autoComplete="off" value={testToken} disabled={checking}
          onChange={event => { setTestToken(event.target.value); setChecked("idle"); }}
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm dark:border-zinc-700 dark:text-zinc-200" />
        <button type="button" disabled={checking || !testToken.trim() || (mode === "http" && !service?.enabled)} onClick={() => void checkMcp()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700 dark:text-zinc-200 disabled:opacity-50">
          <Activity className="h-3.5 w-3.5" />{checking ? "检测中…" : "测试 MCP 连接"}
        </button>
        {checked !== "idle" && <p role="status" className="w-full text-xs text-zinc-500">
          {checked === "ok" ? "MCP 握手与工具列表检测通过" : "MCP 检测失败，请检查开关、地址、HTTPS 和令牌权限"}
        </p>}
      </div>}
      <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs text-zinc-300">
          <span>客户端连接配置 · JSON 示例</span>
          <button type="button" onClick={() => copyText(config)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-zinc-800">
            <ClipboardCopy className="h-3.5 w-3.5" /> 复制
          </button>
        </div>
        <pre className="max-h-60 overflow-auto whitespace-pre p-3 text-[11px] leading-relaxed text-zinc-200">{config}</pre>
      </div>
      <div className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          默认使用只读 Token，按需授权笔记本。Docker 内置 MCP 使用下方创建的个人 API Token，
          每个 AI 助手独立授权，可随时吊销。独立 HTTP 网关仍需单独启动并配置网关密钥。
          下方可创建、限制与吊销 Personal API Token。
        </p>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <LockKeyhole className="h-3.5 w-3.5" /> 自动化写入须额外授权 automations:write；高风险插件操作仍需显式开启
      </div>
    </section>
  );
}
