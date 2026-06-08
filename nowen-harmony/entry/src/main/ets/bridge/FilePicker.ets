/**
 * FilePickerBridge - 文件选择桥接
 *
 * 封装鸿蒙原生文件/图片选择器，
 * 供 JsBridge 的 pickFile 事件调用。
 *
 * TODO: 阶段 3 完善完整实现
 */
import { picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

export interface PickedFile {
  name: string;
  uri: string;
  size: number;
  mimeType: string;
}

/**
 * 选择图片
 * @returns 选中的图片 URI（content:// 协议）
 */
export async function pickImage(): Promise<PickedFile | null> {
  try {
    const photoPicker = new photoAccessHelper.PhotoViewPicker();
    const result = await photoPicker.select({
      MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
      maxSelectNumber: 1,
    });

    if (result && result.photoUris && result.photoUris.length > 0) {
      const uri = result.photoUris[0];
      return {
        name: uri.split('/').pop() || 'image.jpg',
        uri: uri,
        size: 0, // 需要额外读取
        mimeType: 'image/*',
      };
    }
  } catch (err) {
    console.error('[FilePickerBridge] pickImage failed:', err);
  }
  return null;
}

/**
 * 选择任意文件
 */
export async function pickFile(): Promise<PickedFile | null> {
  try {
    const documentPicker = new picker.DocumentViewPicker();
    const result = await documentPicker.select({
      maxSelectNumber: 1,
    });

    if (result && result.length > 0) {
      const uri = result[0];
      return {
        name: uri.split('/').pop() || 'file',
        uri: uri,
        size: 0,
        mimeType: 'application/octet-stream',
      };
    }
  } catch (err) {
    console.error('[FilePickerBridge] pickFile failed:', err);
  }
  return null;
}
