import { cn } from "@/lib/utils";
import { MotionPhotoOverlay } from "../MotionPhotoOverlay";
import { useAttachmentImageRenderSource } from "@/hooks/useAttachmentImageRenderSource";
import { downloadAttachment } from "@/lib/downloadFile";

interface Props {
  url: string;
  filename: string;
  imgMaxHeightClass?: string;
}

export function AttachmentPhotoPreview({ url, filename, imgMaxHeightClass }: Props) {
  const image = useAttachmentImageRenderSource(url);
  return <span className="relative block">
    {image.error ? <span className="flex flex-col items-center gap-2 py-10 text-sm text-tx-tertiary">照片暂时无法预览<button type="button" className="underline" onClick={() => { void downloadAttachment(url, filename); }}>下载原件</button></span>
      : <><img src={image.renderSrc} alt={filename} onLoad={image.onLoad} onError={image.onError}
          className={cn("w-full object-contain bg-zinc-950/5", imgMaxHeightClass ?? "max-h-[360px]")} />
        <MotionPhotoOverlay source={url} /></>}
  </span>;
}
