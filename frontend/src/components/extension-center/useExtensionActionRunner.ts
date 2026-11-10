import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pushAppPathState } from "@/lib/appPathNavigation";
import type { ExtensionListing } from "@/lib/extensionCatalog";
import type { CardAction } from "./ExtensionCard";
import type { DrawerAction } from "./ExtensionDetailDrawer";
import {
  disableExtension, grantPendingPermissions, installFromRegistry, installPackageFile, reviewAndEnable,
  runExtensionAction, uninstallExtension, updateExtension,
} from "./extensionActions";
import { useBuiltinNavigation } from "./extensionCenterUi";

/** One mutation at a time per page; the catalog refreshes itself from the server after each mutation. */
export function useExtensionActionRunner(openDetails: (listing: ExtensionListing) => void) {
  const { t } = useTranslation();
  const navigate = useBuiltinNavigation();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busy = useRef(false);

  const guarded = useCallback(async (key: string, operation: () => Promise<boolean>) => {
    if (busy.current) return false;
    busy.current = true; setBusyKey(key);
    try { return await runExtensionAction(operation, t); }
    finally { busy.current = false; setBusyKey(null); }
  }, [t]);

  const run = useCallback((listing: ExtensionListing, action: CardAction | DrawerAction) => {
    switch (action) {
      case "details": openDetails(listing); return;
      case "open": if (listing.navigation) navigate(listing.navigation); return;
      case "open-app": {
        const page = listing.installed?.contributes?.appPages?.[0];
        if (page) pushAppPathState(`/apps/${listing.id}/${page.id}`);
        return;
      }
      case "install": void guarded(listing.key, () => installFromRegistry(listing, t)); return;
      case "review-enable": void guarded(listing.key, () => reviewAndEnable(listing, t)); return;
      case "disable": void guarded(listing.key, () => disableExtension(listing, t)); return;
      case "update": void guarded(listing.key, () => updateExtension(listing, t)); return;
      case "grant": void guarded(listing.key, () => grantPendingPermissions(listing, t)); return;
      case "uninstall-plain": void guarded(listing.key, () => uninstallExtension(listing, "plain", t)); return;
      case "uninstall-retain": void guarded(listing.key, () => uninstallExtension(listing, "retain", t)); return;
      case "uninstall-delete": void guarded(listing.key, () => uninstallExtension(listing, "delete", t)); return;
    }
  }, [guarded, navigate, openDetails, t]);

  const installPackage = useCallback((file: File) => guarded("package", () => installPackageFile(file, t)), [guarded, t]);
  return { busyKey, run, installPackage };
}
