import { common } from '@kit.AbilityKit';
import { HarmonyFiles } from './NativeFiles';

const MIME: Record<string, string> = {
  'html': 'text/html', 'js': 'application/javascript', 'css': 'text/css', 'json': 'application/json',
  'svg': 'image/svg+xml', 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
  'gif': 'image/gif', 'ico': 'image/x-icon', 'woff': 'font/woff', 'woff2': 'font/woff2', 'ttf': 'font/ttf',
  'wasm': 'application/wasm', 'pdf': 'application/pdf', 'mp4': 'video/mp4', 'mp3': 'audio/mpeg',
};

export class WebAssets {
  private context: common.UIAbilityContext;
  private files: HarmonyFiles;
  constructor(context: common.UIAbilityContext, files: HarmonyFiles) { this.context = context; this.files = files; }

  response(url: string): WebResourceResponse {
    // The stable HTTPS origin preserves WebCrypto/IndexedDB and Android's CORS
    // origin. JavaScriptProxy independently enforces its native URL permission.
    const response = new WebResourceResponse();
    response.setResponseEncoding('utf-8');
    response.setReasonMessage('OK');
    response.setResponseCode(200);
    response.setResponseHeader([{ headerKey: 'Cache-Control', headerValue: 'no-cache' }]);
    try {
      if (!url.startsWith('https://localhost/')) throw new Error('Invalid asset origin');
      const path = decodeURIComponent(url.substring('https://localhost/'.length).split('?')[0].split('#')[0]);
      if (path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0 || path.split('/').includes('..')) throw new Error('Invalid asset path');
      if (path.startsWith('_nowen_file_/')) {
        const nativePath = this.files.path(path.substring('_nowen_file_/'.length));
        response.setResponseData(this.files.read(nativePath).buffer as ArrayBuffer);
        response.setResponseMimeType(MIME[nativePath.split('.').pop() || ''] || 'application/octet-stream');
      } else {
        if (path.startsWith('api/')) throw new Error('No local HTTP API');
        const asset = !path || !path.split('/').pop()?.includes('.') ? 'index.html' : path;
        const bytes = this.context.resourceManager.getRawFileContentSync('web/' + asset);
        response.setResponseMimeType(MIME[asset.split('.').pop() || ''] || 'application/octet-stream');
        response.setResponseData(bytes.buffer as ArrayBuffer);
      }
    } catch {
      response.setResponseCode(404); response.setReasonMessage('Not Found');
      response.setResponseMimeType('text/plain'); response.setResponseData('Not found');
    }
    return response;
  }
}
