import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { useAttachmentVideoRenderSource } from "@/hooks/useAttachmentVideoRenderSource";
import { formatVoiceDuration } from "@/lib/voiceRecorder";
import VoiceTranscription from "./VoiceTranscription";
import VoiceMemoAudio from "./VoiceMemoAudio";

export default function VoiceMemoBlock({ node, editor, deleteNode }: NodeViewProps) {
  const { t } = useTranslation();
  const attrs = node.attrs;
  const downloadSource = useAttachmentVideoRenderSource(attrs.src);
  const button = "rounded-md border border-app-border px-3 py-1.5 text-xs hover:bg-app-hover disabled:opacity-50";
  return <NodeViewWrapper contentEditable={false} className="my-4 rounded-xl border border-app-border bg-app-surface p-4" data-voice-memo="true">
    <div className="flex items-center justify-between gap-3 text-sm"><span className="truncate">🎙 {attrs.filename || t("voice.title")}</span>{attrs.durationMs > 0 && <span className="font-mono text-tx-secondary">{formatVoiceDuration(attrs.durationMs)}</span>}</div>
    <VoiceMemoAudio src={attrs.src} />
    <div className="flex flex-wrap gap-2">
      <a className={button} href={downloadSource.renderSrc} download={attrs.filename}>{t("voice.download")}</a>
      {editor.isEditable && <button type="button" className={button} onClick={deleteNode}>{t("voice.remove")}</button>}
    </div>
    {editor.isEditable && <VoiceTranscription key={attrs.src} src={attrs.src} onInsert={(text) => { if (editor.isEditable && !editor.isDestroyed) editor.chain().focus().insertContent({ type: "paragraph", content: [{ type: "text", text }] }).run(); }} />}
  </NodeViewWrapper>;
}
