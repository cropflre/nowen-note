export function isSvgImageSource(src: string, mimeType?: string | null): boolean {
  const normalized = src.trim().toLowerCase();
  return (
    normalized.startsWith("data:image/svg+xml") ||
    normalized.split(/[?#]/, 1)[0].endsWith(".svg") ||
    (mimeType?.toLowerCase().includes("svg") ?? false)
  );
}

export function editedImageBlobToFile(blob: Blob, filename?: string): File {
  const mimeType = blob.type || "image/png";
  const ext = mimeType.includes("webp")
    ? "webp"
    : mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? "jpg"
      : "png";
  const base = (filename || `edited-image-${Date.now()}`).trim() || `edited-image-${Date.now()}`;
  const stem = base.replace(/\.[a-z0-9]{2,5}$/i, "");
  return new File([blob], `${stem}.${ext}`, { type: mimeType });
}
