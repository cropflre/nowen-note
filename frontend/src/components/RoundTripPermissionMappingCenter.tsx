import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import RoundTripPermissionMappingPanel from "@/components/RoundTripPermissionMappingPanel";
import {
  resolveRoundTripPermissionReview,
  subscribeRoundTripPermissionReviews,
  suggestedPermissionMappings,
  type RoundTripPermissionReviewRequest,
} from "@/lib/roundTripPermissionReview";

function MappingDialog({ request }: { request: RoundTripPermissionReviewRequest }) {
  const [enabled, setEnabled] = useState(false);
  const [mappings, setMappings] = useState<Record<string, string>>(
    () => suggestedPermissionMappings(request.inspection),
  );

  const finish = (applyPermissions: boolean) => {
    resolveRoundTripPermissionReview(request.id, {
      applyPermissions,
      permissionMappings: applyPermissions ? mappings : {},
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-[13000] flex items-end justify-center bg-black/50 p-0 backdrop-blur-[1px] sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-start gap-2.5">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-violet-600" />
            <div>
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">成员与权限恢复确认</h2>
              <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                内容导入可以独立完成。权限恢复默认关闭，只有明确映射的目标账号会获得权限。
              </p>
            </div>
          </div>
          <button type="button" onClick={() => finish(false)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900" aria-label="跳过权限恢复">
            <X size={18} />
          </button>
        </header>

        <div className="overflow-y-auto p-4">
          <RoundTripPermissionMappingPanel
            inspection={request.inspection}
            enabled={enabled}
            onEnabledChange={setEnabled}
            mappings={mappings}
            onMappingsChange={setMappings}
          />
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <Button variant="outline" onClick={() => finish(false)}>仅导入内容</Button>
          <Button onClick={() => finish(enabled)} disabled={!enabled}>
            确认映射并恢复权限
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default function RoundTripPermissionMappingCenter() {
  const [requests, setRequests] = useState<RoundTripPermissionReviewRequest[]>([]);
  useEffect(() => subscribeRoundTripPermissionReviews(setRequests), []);
  const active = requests[0];
  return active ? <MappingDialog key={active.id} request={active} /> : null;
}
