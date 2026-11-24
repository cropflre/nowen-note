import React from "react";
import DesktopUpdateCenterCore from "@/components/DesktopUpdateCenterCore";
import DesktopUpdateAssetFallback from "@/components/DesktopUpdateAssetFallback";
import { DesktopHotUpdateBanner } from "@/components/DesktopHotUpdate";

export default function DesktopUpdateCenter() {
  return (
    <>
      <DesktopUpdateCenterCore />
      <DesktopUpdateAssetFallback />
      <DesktopHotUpdateBanner />
    </>
  );
}
