import React, { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { collaborationScope, OPEN_AI_COLLABORATION } from "@/lib/aiCollaboration";

const Dialog = lazy(() => import("./aiCollaboration/AICollaborationDialog"));
export default function AICollaborationCenter() {
  const [scope, setScope] = useState<string | null>(null);
  useEffect(() => {
    const open = () => setScope(collaborationScope());
    const changed = () => setScope(current => current === collaborationScope() ? current : null);
    window.addEventListener(OPEN_AI_COLLABORATION, open);
    const events = ["nowen:workspace-changed", "nowen:token-changed", "nowen:server-url-changed", "storage"];
    events.forEach(event => window.addEventListener(event, changed));
    return () => { window.removeEventListener(OPEN_AI_COLLABORATION, open); events.forEach(event => window.removeEventListener(event, changed)); };
  }, []);
  return scope ? createPortal(<Suspense fallback={null}><Dialog key={scope} scope={scope} onClose={() => setScope(null)} /></Suspense>, document.body) : null;
}
