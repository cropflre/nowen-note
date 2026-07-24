import PublicSpaceLauncher from "@/components/PublicSpaceLauncher";
import { useUserPreferences } from "@/hooks/useUserPreferences";

/** Keeps the Spaces launcher account-scoped and immediately reactive. */
export default function SpaceActionsPreferenceGate() {
  const { prefs } = useUserPreferences();
  return <PublicSpaceLauncher visible={prefs.showSpaceActions} />;
}
