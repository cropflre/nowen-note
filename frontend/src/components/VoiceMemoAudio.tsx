import { useAttachmentVideoRenderSource } from "@/hooks/useAttachmentVideoRenderSource";
import { toInlineAttachmentUrl } from "@/lib/mediaUploadService";

export default function VoiceMemoAudio({ src }: { src: string }) {
  // 音频复用现有媒体地址解析，继承签名、离线缓存和 Android 局域网播放能力。
  const source = useAttachmentVideoRenderSource(toInlineAttachmentUrl(src));
  return <audio key={source.renderKey} src={source.renderSrc || undefined} controls preload="metadata" className="my-3 w-full" />;
}
