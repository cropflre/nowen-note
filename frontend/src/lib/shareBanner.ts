export interface ShareBannerConfig {
  enabled: boolean;
  image: string;
}

export function shareBannerCrop(imageWidth: number, imageHeight: number, horizontal: number, vertical: number) {
  const width = Math.min(imageWidth, imageHeight * 4);
  const height = width / 4;
  return {
    x: (imageWidth - width) * horizontal / 100,
    y: (imageHeight - height) * vertical / 100,
    width,
    height,
  };
}

export function cropShareBannerImage(image: HTMLImageElement, horizontal: number, vertical: number): string {
  const crop = shareBannerCrop(image.naturalWidth, image.naturalHeight, horizontal, vertical);
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 400;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理横幅图片");
  // JPEG 不保留透明度，使用与裁切预览一致的白底。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1600, 400);
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, 1600, 400);
  return canvas.toDataURL("image/jpeg", 0.82);
}
