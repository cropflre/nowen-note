import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { window } from '@kit.ArkUI';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { HarmonyDatabase, DatabaseOptions } from './NativeDatabase';
import { HarmonyFiles, FileOptions } from './NativeFiles';
import { getNetworkType } from '../services/NetworkMonitor';
import { NativeResult, NativeFailure, NativeEvent } from './NativeTypes';

interface NativeRequest {
  id: string;
  plugin: string;
  method: string;
  options: Object;
}
interface HttpOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: Object;
  responseType?: string;
  connectTimeout?: number;
  readTimeout?: number;
}
interface SecretOptions { key: string; value?: Object; }
interface StyleOptions { style?: string; color?: string; }

export class NativeHost {
  readonly files: HarmonyFiles;
  private database: HarmonyDatabase;
  private queue: Promise<void> = Promise.resolve();

  private context: common.UIAbilityContext;
  private controller: webview.WebviewController;
  constructor(context: common.UIAbilityContext, controller: webview.WebviewController) {
    this.context = context;
    this.controller = controller;
    this.database = new HarmonyDatabase(context);
    this.files = new HarmonyFiles(context);
  }

  postMessage(raw: string): void {
    let request: NativeRequest;
    try { request = JSON.parse(raw) as NativeRequest; } catch { return; }
    if (!/^\d{1,12}$/.test(request.id)) return;
    // Keep SQLite ordering, while a slow HTTP request must never block an
    // independent local edit or attachment write.
    const work = async (): Promise<void> => {
      try {
        const result = await this.call(request);
        this.reply(request.id, result);
      } catch (error) {
        const code = (error as BusinessError).code;
        const missing = (error as Error).message === 'OS-PLUG-FILE-0008';
        if (!missing) console.error('[HarmonyHost]', request.plugin, request.method, String(code || 'NATIVE_OPERATION_FAILED'));
        this.reply(request.id, {}, {
          message: missing ? 'File does not exist' : '原生操作失败，请重试',
          code: missing ? 'OS-PLUG-FILE-0008' : String(code || 'NATIVE_OPERATION_FAILED'),
        });
      }
    };
    if (request.plugin === 'CapacitorSQLite') {
      this.queue = this.queue.then(work, work).catch(() => { console.error('[HarmonyHost] database response unavailable'); });
    } else {
      work().catch(() => { console.error('[HarmonyHost] native response unavailable'); });
    }
  }

  private reply(id: string, value: NativeResult, error?: NativeFailure): void {
    this.controller.runJavaScript('window.__harmonyBridge__?.resolve(' + JSON.stringify(id) + ','
      + JSON.stringify(value) + ',' + (error ? JSON.stringify(error) : 'null') + ');true;');
  }

  emit(plugin: string, event: string, value: NativeEvent): void {
    this.controller.runJavaScript('window.__harmonyBridge__?.emit(' + JSON.stringify(plugin) + ','
      + JSON.stringify(event) + ',' + JSON.stringify(value) + ');true;');
  }

  private async secret(method: string, options: SecretOptions): Promise<NativeResult> {
    if (!/^[a-f0-9]{64}$/.test(options.key)) throw new Error('Invalid secret alias');
    const alias = new util.TextEncoder().encodeInto('nowen.' + options.key);
    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.ALIAS, alias);
    if (method === 'set') {
      attributes.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(JSON.stringify(options.value)));
      attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
      attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
      await asset.add(attributes); return {};
    }
    try {
      if (method === 'remove') { await asset.remove(attributes); return { removed: true }; }
      if (method === 'get') {
        attributes.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
        const result = await asset.query(attributes);
        if (result.length === 0) return { value: null };
        const secret = result[0].get(asset.Tag.SECRET) as Uint8Array;
        return { value: JSON.parse(util.TextDecoder.create('utf-8').decodeToString(secret)) as Object };
      }
    } catch (error) {
      if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) {
        return method === 'get' ? { value: null } : { removed: false };
      }
      throw error as Error;
    }
    throw new Error('Unsupported secret operation');
  }

  private async fetch(options: HttpOptions): Promise<NativeResult> {
    if (!/^https?:\/\/[^\s]+$/i.test(options.url)) throw new Error('Invalid HTTP URL');
    const client = http.createHttp();
    try {
      const headers: Record<string, string> = options.headers || {};
      const result = await client.request(options.url, {
        method: (options.method || 'GET') as http.RequestMethod,
        header: headers,
        extraData: typeof options.data === 'object' ? JSON.stringify(options.data) : options.data,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: Math.min(options.connectTimeout || 30000, 120000),
        readTimeout: Math.min(options.readTimeout || 120000, 600000),
      });
      const bytes = new Uint8Array(result.result as ArrayBuffer);
      let data: Object = options.responseType === 'arraybuffer'
        ? new util.Base64Helper().encodeToStringSync(bytes)
        : util.TextDecoder.create('utf-8').decodeToString(bytes);
      if (options.responseType === 'json') {
        const text = data as string;
        // An empty 204 or an HTML error response is still a completed HTTP
        // request. Do not turn it into a transport failure and replay a write.
        try { data = JSON.parse(text.trim() ? text : 'null') as Object; } catch { data = text; }
      }
      return { status: result.responseCode, headers: result.header, data, url: options.url };
    } finally { client.destroy(); }
  }

  private async call(request: NativeRequest): Promise<NativeResult> {
    if (request.plugin === 'CapacitorSQLite') return this.database.call(request.method, request.options as DatabaseOptions);
    if (request.plugin === 'Filesystem') return this.files.call(request.method, request.options as FileOptions);
    if (request.plugin === 'SecureStorage') return this.secret(request.method, request.options as SecretOptions);
    if (request.plugin === 'CapacitorHttp') return this.fetch(request.options as HttpOptions);
    if (request.plugin === 'Network' && request.method === 'getStatus') {
      const type = getNetworkType(); return { connected: type !== 'none', connectionType: type };
    }
    if (request.plugin === 'App') {
      if (request.method === 'exitApp') { await this.context.terminateSelf(); return {}; }
      if (request.method === 'getState') return { isActive: true };
      if (request.method === 'getInfo') return { id: 'com.nowen.note', name: 'Nowen Note', version: '1.0.0', build: '1000000' };
    }
    if (request.plugin === 'StatusBar') {
      const win = await window.getLastWindow(this.context);
      const style = request.options as StyleOptions;
      if (request.method === 'setStyle') {
        await win.setWindowSystemBarProperties({ statusBarContentColor: style.style === 'DARK' ? '#FFFFFF' : '#111827' });
      } else if (request.method === 'setBackgroundColor') {
        await win.setWindowSystemBarProperties({ statusBarColor: style.color || '#FFFFFF' });
      }
      return {};
    }
    if (request.plugin === 'Keyboard' && request.method === 'hide') {
      await this.controller.runJavaScript('document.activeElement?.blur();true;'); return {};
    }
    if (request.plugin === 'Browser' && request.method === 'open') {
      const options = request.options as HttpOptions;
      if (!/^https?:\/\//i.test(options.url)) throw new Error('Invalid external URL');
      await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: options.url }); return {};
    }
    throw new Error('Unsupported native capability');
  }
}
