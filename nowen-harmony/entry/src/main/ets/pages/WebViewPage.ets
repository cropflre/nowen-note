import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { window } from '@kit.ArkUI';
import { picker } from '@kit.CoreFileKit';
import { connection } from '@kit.NetworkKit';
import { NativeHost } from '../bridge/NativeHost';
import { WebAssets } from '../bridge/WebAssets';
import { getString } from '../services/PreferenceStore';
import { PREF_KEY_SERVER_URL } from '../utils/Constants';
import { getNetworkType } from '../services/NetworkMonitor';

@Entry
@Component
struct WebViewPage {
  @State hasError: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private host: NativeHost = new NativeHost(getContext(this) as common.UIAbilityContext, this.controller);
  private assets: WebAssets = new WebAssets(getContext(this) as common.UIAbilityContext, this.host.files);
  private net: connection.NetConnection = connection.createNetConnection();
  private mainWindow?: window.Window;
  private ready: boolean = false;

  aboutToAppear(): void {
    window.getLastWindow(getContext(this)).then((win: window.Window) => {
      this.mainWindow = win;
      win.on('keyboardHeightChange', (height: number) => {
        if (this.ready) this.host.emit('Keyboard', height > 0 ? 'keyboardWillShow' : 'keyboardWillHide',
          { keyboardHeight: px2vp(height) });
      });
      win.on('avoidAreaChange', () => this.updateInsets());
    });
    this.net.on('netAvailable', () => this.updateNetwork());
    this.net.on('netLost', () => this.updateNetwork());
    this.net.register(() => {});
  }

  aboutToDisappear(): void {
    this.mainWindow?.off('keyboardHeightChange');
    this.mainWindow?.off('avoidAreaChange');
    this.net.unregister(() => {});
  }

  private updateNetwork(): void {
    if (!this.ready) return;
    const type = getNetworkType();
    this.host.emit('Network', 'networkStatusChange', { connected: type !== 'none', connectionType: type });
  }

  private updateInsets(): void {
    if (!this.ready || !this.mainWindow) return;
    const area = this.mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
    const top = px2vp(area.topRect.height);
    const bottom = px2vp(area.bottomRect.height);
    this.controller.runJavaScript("document.documentElement.style.setProperty('--safe-area-top','" + top
      + "px');document.documentElement.style.setProperty('--safe-area-bottom','" + bottom + "px');true;");
  }

  private async selectFiles(event: OnShowFileSelectorEvent): Promise<void> {
    try {
      const selector = new picker.DocumentViewPicker(getContext(this));
      const files = await selector.select({ maxSelectNumber: event.fileSelector.getMode() === 1 ? 20 : 1 });
      event.result.handleFileList(files);
    } catch { event.result.handleFileList([]); }
  }

  onBackPress(): boolean {
    if (this.ready) this.controller.runJavaScript('window.__harmonyBridge__?.back();true;');
    return true;
  }

  build() {
    Stack() {
      Web({ src: 'https://localhost/', controller: this.controller })
        .javaScriptAccess(true).domStorageAccess(true).databaseAccess(true).fileAccess(true)
        .mixedMode(MixedMode.All).imageAccess(true).width('100%').height('100%')
        .keyboardAvoidMode(WebKeyboardAvoidMode.OVERLAYS_CONTENT)
        .javaScriptProxy({ object: this.host, name: 'NowenNative', methodList: ['postMessage'],
          controller: this.controller,
          permission: '{"javascriptProxyPermission":{"urlPermissionList":[{"scheme":"https","host":"localhost","port":"","path":""}]}}' })
        .onInterceptRequest((event: OnInterceptRequestEvent) => {
          if (event.request.getRequestUrl().startsWith('https://localhost/')) {
            return this.assets.response(event.request.getRequestUrl());
          }
          return null;
        })
        .onLoadIntercept((event: OnLoadInterceptEvent) => {
          return event.data.isMainFrame() && !event.data.getRequestUrl().startsWith('https://localhost/');
        })
        .onShowFileSelector((event: OnShowFileSelectorEvent) => { this.selectFiles(event); return true; })
        .onPageBegin(() => { this.ready = false; })
        .onPageEnd(() => {
          this.ready = true; this.updateInsets(); this.updateNetwork();
          getString(PREF_KEY_SERVER_URL, '').then((url: string) => {
            // Preserve the legacy endpoint without clearing old Web storage or
            // copying credentials between origins.
            if (url) this.controller.runJavaScript('window.__harmonyBridge__?.seedServer(' + JSON.stringify(url) + ');true;');
          });
        })
        .onErrorReceive((event: OnErrorReceiveEvent) => {
          if (event.request.isMainFrame()) this.hasError = true;
        })
      if (this.hasError) {
        Column({ space: 16 }) {
          Text('应用加载失败').fontSize(20)
          Button('重新加载').onClick(() => { this.hasError = false; this.controller.loadUrl('https://localhost/'); })
        }.width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor('#FFFFFF')
      }
    }.width('100%').height('100%')
  }
}
