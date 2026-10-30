import NoteIconBridge from "./NoteIconBridge";
import EmbedPasswordBridge from "./EmbedPasswordBridge";
import MediaExperienceBridge from "./MediaExperienceBridge";
import CameraCaptureBridge from "./CameraCaptureBridge";
import VoiceRecorderSheet from "./VoiceRecorderSheet";
import EditorImageTransformBridge from "./EditorImageTransformBridge";
import ImageClipboardBridge from "./ImageClipboardBridge";
import MarkdownMobileViewControlsBridge from "./MarkdownMobileViewControlsBridge";
import DesktopUpdateCenter from "./DesktopUpdateCenter";
import DockerUpdateCenter from "./DockerUpdateCenter";
import TwoFactorLoginChallengeCenter from "./TwoFactorLoginChallengeCenter";
import AndroidShareImportCenter from "./AndroidShareImportCenter";
import DeferredGlobalFeatureCentersMount from "./DeferredGlobalFeatureCentersMount";
import SiyuanRichTextCalloutBridge from "./SiyuanRichTextCalloutBridge";
import InlineCommentBridge from "./InlineCommentBridge";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

/**
 * Global event and media bridges are loaded as a separate startup chunk.
 * They stay mounted for the app lifetime, but no longer inflate the login entry bundle.
 * The image-transform bootstrap is a dependency of EditorImageTransformBridge; main.tsx
 * also awaits it before evaluating App or public note schemas.
 */
export default function GlobalBridges() {
  return (
    <>
      <NoteIconBridge />
      <EmbedPasswordBridge />
      <CameraCaptureBridge />
      <VoiceRecorderSheet />
      <MediaExperienceBridge />
      <EditorImageTransformBridge />
      <ImageClipboardBridge />
      <MarkdownMobileViewControlsBridge />
      <DesktopUpdateCenter />
      <DockerUpdateCenter />
      <TwoFactorLoginChallengeCenter />
      <AndroidShareImportCenter />
      <DeferredGlobalFeatureCentersMount />
      <SiyuanRichTextCalloutBridge />
      {!isMobileLocalMode() && <InlineCommentBridge />}
    </>
  );
}
