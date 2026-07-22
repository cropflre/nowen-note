import React from "react";
import DesktopUpdateCenterCore from "@/components/DesktopUpdateCenterCore";
import DesktopUpdateAssetFallback from "@/components/DesktopUpdateAssetFallback";

export default function DesktopUpdateCenter() {
  return (
    <>
      <DesktopUpdateCenterCore />
      <DesktopUpdateAssetFallback />
    </>
  );
}
