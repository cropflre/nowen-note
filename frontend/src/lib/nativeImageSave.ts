import { Capacitor, registerPlugin } from "@capacitor/core";

export interface NativeSavedFileResult {
  success: boolean;
  uri: string;
  displayPath?: string;
  canceled?: boolean;
}

interface NativeExportFilePayload {
  base64Data: string;
  fileName: string;
  mimeType: string;
}

/** Capacitor bridge for Android MediaStore, SAF and share-sheet operations. */
interface MediaStoreSavePlugin {
  saveImage(options: NativeExportFilePayload & { relativePath?: string }): Promise<NativeSavedFileResult>;
  saveFile(options: NativeExportFilePayload): Promise<NativeSavedFileResult>;
  shareFiles(options: { files: NativeExportFilePayload[]; title?: string }): Promise<{ success: boolean; count: number }>;
  openUri(options: { uri: string; mimeType?: string }): Promise<{ success: boolean }>;
}

const MediaStoreSave = registerPlugin<MediaStoreSavePlugin>("MediaStoreSave");

/** Returns true only inside the Android Capacitor shell. */
export function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob as base64"));
    reader.readAsDataURL(blob);
  });
}

export async function saveImageToGalleryDetailed(options: {
  blob: Blob;
  fileName: string;
  mimeType: string;
}): Promise<NativeSavedFileResult> {
  const result = await MediaStoreSave.saveImage({
    base64Data: await blobToBase64(options.blob),
    fileName: options.fileName,
    mimeType: options.mimeType,
    relativePath: "Pictures/Nowen Note",
  });
  if (!result?.success || !result.uri) throw new Error("Android 相册保存失败：系统没有返回有效文件地址");
  return result;
}

/** Backward-compatible boolean API used by image insertion/export code. */
export async function saveImageToGallery(options: {
  blob: Blob;
  fileName: string;
  mimeType: string;
}): Promise<boolean> {
  const result = await saveImageToGalleryDetailed(options);
  return result.success;
}

/** Opens Android's ACTION_CREATE_DOCUMENT picker and writes the blob to the chosen location. */
export async function saveBlobToSystemFile(options: {
  blob: Blob;
  fileName: string;
  mimeType: string;
}): Promise<NativeSavedFileResult> {
  const result = await MediaStoreSave.saveFile({
    base64Data: await blobToBase64(options.blob),
    fileName: options.fileName,
    mimeType: options.mimeType,
  });
  if (result?.canceled) return result;
  if (!result?.success || !result.uri) throw new Error("保存到系统文件失败：未获得目标文件地址");
  return result;
}

/** Shares one or more generated files through the native Android chooser. */
export async function shareNativeFiles(files: Array<{
  blob: Blob;
  fileName: string;
  mimeType: string;
}>): Promise<void> {
  if (!files.length) throw new Error("没有可分享的导出文件");
  const payload: NativeExportFilePayload[] = [];
  for (const file of files) {
    payload.push({
      base64Data: await blobToBase64(file.blob),
      fileName: file.fileName,
      mimeType: file.mimeType,
    });
  }
  const result = await MediaStoreSave.shareFiles({ files: payload, title: "Nowen Note 导出" });
  if (!result?.success) throw new Error("无法打开 Android 系统分享面板");
}

export async function openNativeExportUri(uri: string, mimeType = "image/*"): Promise<void> {
  if (!uri) throw new Error("导出结果没有可打开的地址");
  const result = await MediaStoreSave.openUri({ uri, mimeType });
  if (!result?.success) throw new Error("系统中没有可以打开该文件的应用");
}
