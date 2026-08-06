import React from "react";

import AIProfileSwitcherBridge from "./AIProfileSwitcherBridge";
import EmbeddingIndexTaskCopyBridge from "./EmbeddingIndexTaskCopyBridge";
import MarkdownExperienceBridge from "./MarkdownExperienceBridge";
import MindMapAppearanceBridge from "./MindMapAppearanceBridge";
import TaskDataTransferBridgeV2 from "./TaskDataTransferBridgeV2";
import SystemFullDataTransferBridge from "./SystemFullDataTransferBridge";
import BackupWebDavBridge from "./BackupWebDavBridge";
import NoteImageExportCenter from "./NoteImageExportCenter";
import DocxImportCenter from "./DocxImportCenter";
import PublicSpaceLauncher from "./PublicSpaceLauncher";
import NoteTransferCenter from "./NoteTransferCenter";
import RoundTripImportBatchCenter from "./RoundTripImportBatchCenter";
import RoundTripPermissionMappingCenter from "./RoundTripPermissionMappingCenter";
import RoundTripPermissionExportCenter from "./RoundTripPermissionExportCenter";
import SiyuanImportProgressBridge from "./SiyuanImportProgressBridge";

/**
 * Low-frequency authenticated feature centers.
 *
 * These components mostly subscribe to explicit import/export/transfer events or reconcile editor
 * DOM after it mounts. Keeping them in one asynchronous boundary prevents AI profile management,
 * CodeMirror integration, JSZip, image export, migration, mind-map and backup UI dependencies from
 * joining the login chunk.
 */
export default function DeferredGlobalFeatureCenters() {
  return (
    <>
      <AIProfileSwitcherBridge />
      <EmbeddingIndexTaskCopyBridge />
      <MarkdownExperienceBridge />
      <MindMapAppearanceBridge />
      <TaskDataTransferBridgeV2 />
      <SystemFullDataTransferBridge />
      <BackupWebDavBridge />
      <NoteImageExportCenter />
      <DocxImportCenter />
      <PublicSpaceLauncher />
      <NoteTransferCenter />
      <RoundTripImportBatchCenter />
      <RoundTripPermissionMappingCenter />
      <RoundTripPermissionExportCenter />
      <SiyuanImportProgressBridge />
    </>
  );
}
