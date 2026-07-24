import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldCheck, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  resolveRoundTripPermissionExport,
  subscribeRoundTripPermissionExports,
  type RoundTripPermissionExportRequest,
} from "@/lib/roundTripPermissionExport";

function ExportDialog({ request }: { request: RoundTripPermissionExportRequest }) {
  const [includePermissions, setIncludePermissions] = useState(false);
  const finish = (value: boolean) => resolveRoundTripPermissionExport(request.id, value);

  return createPortal(
    <div className="fixed inset-0 z-[13000] flex items-end justify-center bg-black/50 p-0 backdrop-blur-[1px] sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg overflow-hidden rounded-t-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-start gap-2.5">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-violet-600" />
            <div>
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">导出 Nowen 无损包</h2>
              <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                权限数据默认不导出。只有需要跨实例恢复团队成员时才应开启。
              </p>
            </div>
          </div>
          <button type="button" onClick={() => finish(false)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900" aria-label="按默认方式导出">
            <X size={18} />
          </button>
        </header>

        <div className="p-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900/50 dark:bg-violet-500/5">
            <input
              type="checkbox"
              checked={includePermissions}
              onChange={(event) => setIncludePermissions(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-violet-600"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-violet-900 dark:text-violet-200">
                <UsersRound size={15} /> 包含成员与权限
              </span>
              <span className="mt-1 block text-xs leading-5 text-violet-700/80 dark:text-violet-300/80">
                包中会加入成员用户名、显示名、邮箱、工作区角色及本次导出范围内的目录直接授权。不会包含密码、令牌、OAuth 或系统管理员身份。
              </span>
            </span>
          </label>
          <p className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            即使包含权限，目标实例导入时仍默认关闭恢复，并要求逐个确认来源账号到现有目标账号的映射。
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <Button variant="outline" onClick={() => finish(false)}>不含权限导出</Button>
          <Button onClick={() => finish(includePermissions)}>
            {includePermissions ? "包含权限并导出" : "继续导出"}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default function RoundTripPermissionExportCenter() {
  const [requests, setRequests] = useState<RoundTripPermissionExportRequest[]>([]);
  useEffect(() => subscribeRoundTripPermissionExports(setRequests), []);
  const active = requests[0];
  return active ? <ExportDialog key={active.id} request={active} /> : null;
}
