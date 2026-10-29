import { useMemo, useState } from "react";
import { Activity, Check, ClipboardCopy, Globe2, LockKeyhole, Network, ShieldCheck, Terminal } from "lucide-react";
import { getBaseUrl } from "@/lib/api";
import { toast } from "@/lib/toast";

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

export default function McpConnectionPanel({ purpose }: { purpose?: "migration" } = {}) {
  const [mode, setMode] = useState<"stdio" | "http">("stdio");
  const [remoteUrl, setRemoteUrl] = useState("https://your-domain.example/mcp");
  const [checked, setChecked] = useState<"idle" | "ok" | "error">("idle");
  const [checking, setChecking] = useState(false);
  const apiUrl = getBaseUrl().replace(/\/api\/?$/, "");
  const config = useMemo(() => mode === "stdio"
    ? JSON.stringify({
      mcpServers: {
        "nowen-note": {
          command: "node",
          args: ["/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"],
          env: {
            NOWEN_URL: apiUrl,
            NOWEN_API_TOKEN: "<paste-personal-api-token>",
            MCP_ACCESS_MODE: purpose === "migration" ? "read-write" : "read-only",
            ALLOWED_NOTEBOOK_IDS: "<authorized-notebook-id>",
          },
        },
      },
    }, null, 2)
    : JSON.stringify({
      mcpServers: {
        "nowen-note": {
          type: "streamable-http",
          url: remoteUrl,
          headers: { Authorization: "Bearer <your-separate-http-gateway-token>" },
        },
      },
    }, null, 2),
  [mode, remoteUrl, apiUrl, purpose]);

  const checkBackend = async () => {
    setChecking(true);
    try {
      const controller = new AbortController();
      const response = await fetch(`${apiUrl}/api/health`, { signal: controller.signal, cache: "no-store" });
      setChecked(response.ok ? "ok" : "error");
    } catch { setChecked("error"); }
    finally { setChecking(false); }
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
        <button type="button" disabled={checking} onClick={() => void checkBackend()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900">
          <Activity className="h-3.5 w-3.5" />
          {checking ? "检测中…" : checked === "ok" ? "后端可访问" : checked === "error" ? "后端无法访问 · 重试" : "测试后端连接"}
        </button>
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
          <Globe2 className="h-3.5 w-3.5" /> 远程 Streamable HTTP
        </button>
      </div>
      {mode === "http" && (
        <div className="mt-3">
          <label htmlFor="mcp-http-endpoint" className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">你的 HTTPS MCP 地址</label>
          <input id="mcp-http-endpoint" type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm text-zinc-700 outline-none focus:border-indigo-500 dark:border-zinc-700 dark:text-zinc-200"
            placeholder="https://mcp.example.com/mcp" />
        </div>
      )}
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
          默认使用只读 Token，按需授权笔记本。远程 MCP 必须在服务器单独启动，绑定 127.0.0.1，
          用独立的 HTTP Bearer 密钥和 HTTPS 反向代理；本页面不会保存或回显密钥。
          下方可创建、限制与吊销 Personal API Token。
        </p>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <LockKeyhole className="h-3.5 w-3.5" /> 自动化写入须额外授权 automations:write；高风险插件操作仍需显式开启
      </div>
    </section>
  );
}
