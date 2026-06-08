import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { getString, remove } from '../services/PreferenceStore';
import { isOnline } from '../services/NetworkMonitor';
import { getInjectScript, parseBridgeMessage, buildDispatchScript } from '../bridge/JsBridge';
import { PREF_KEY_SERVER_URL } from '../utils/Constants';

@Entry
@Component
struct WebViewPage {
  @State serverUrl: string = '';
  @State isLoading: boolean = true;
  @State loadProgress: number = 0;
  @State pageTitle: string = 'Nowen Note';
  @State canGoBack: boolean = false;
  @State showMenu: boolean = false;
  @State hasError: boolean = false;
  @State errorMsg: string = '';

  private controller: webview.WebviewController = new webview.WebviewController();
  private bridgeInjected: boolean = false;
  private lastBackPress: number = 0;

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, string>;
    if (params !== null && params !== undefined) {
      const url: string = params['serverUrl'];
      if (url !== undefined && url !== null && url.length > 0) {
        this.serverUrl = url;
        return;
      }
    }
    getString(PREF_KEY_SERVER_URL, '').then((url: string) => {
      if (url.length > 0) {
        this.serverUrl = url;
      } else {
        const opts: router.RouterOptions = { url: 'pages/ServerConfigPage' };
        router.replaceUrl(opts);
      }
    });
  }

  private injectBridge(): void {
    if (this.bridgeInjected) return;
    try {
      const script: string = getInjectScript();
      this.controller.runJavaScript(script);
      this.bridgeInjected = true;
    } catch (e) {
      console.error('[WebViewPage] bridge inject failed');
    }
  }

  private handleBridgeEvent(event: string, data: Record<string, Object>): void {
    if (event === 'clearServerConfig') {
      this.handleClearConfig();
    } else if (event === 'getNetworkType') {
      const netType: string = isOnline() ? 'wifi' : 'none';
      try {
        const js1: string = "window.__harmonyBridge__&&window.__harmonyBridge__._dispatch(\"__netResp\",{\"" + "type" + "\":\"" + netType + "\"});true;";
        this.controller.runJavaScript(js1);
      } catch { /* ignore */ }
    } else if (event === 'pickFile') {
      try {
        const js2: string = "window.__harmonyBridge__&&window.__harmonyBridge__._dispatch(\"__fileResp\",{\"" + "error" + "\":\"" + "not implemented" + "\"});true;";
        this.controller.runJavaScript(js2);
      } catch { /* ignore */ }
    }
  }

  private async handleClearConfig(): Promise<void> {
    await remove(PREF_KEY_SERVER_URL);
    const opts: router.RouterOptions = { url: 'pages/ServerConfigPage' };
    router.replaceUrl(opts);
  }

  private handleRefresh(): void {
    this.hasError = false;
    this.errorMsg = '';
    this.bridgeInjected = false;
    try {
      this.controller.refresh();
    } catch { /* ignore */ }
    this.showMenu = false;
  }

  onBackPress(): void {
    if (this.showMenu) {
      this.showMenu = false;
      return;
    }
    if (this.canGoBack) {
      try {
        this.controller.backward();
      } catch { /* ignore */ }
      return;
    }
    const now: number = Date.now();
    if (now - this.lastBackPress < 2000) {
      router.back();
    } else {
      this.lastBackPress = now;
    }
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        // Top toolbar
        Row() {
          if (this.canGoBack) {
            Row() { Text('<').fontSize(18).fontColor('#374151').fontWeight(FontWeight.Bold) }
            .width(36).height(36).justifyContent(FlexAlign.Center).borderRadius(8)
            .onClick(() => { try { this.controller.backward(); } catch { /* */ } })
          }
          Text(this.pageTitle)
            .fontSize(15).fontWeight(FontWeight.Medium).fontColor('#111827')
            .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 4, right: 4 })
          Row() { Text('\u21bb').fontSize(18).fontColor('#6B7280') }
            .width(36).height(36).justifyContent(FlexAlign.Center).borderRadius(8)
            .onClick(() => { this.handleRefresh(); })
          Row() { Text('\u22ee').fontSize(18).fontColor('#6B7280') }
            .width(36).height(36).justifyContent(FlexAlign.Center).borderRadius(8)
            .onClick(() => { this.showMenu = !this.showMenu; })
        }
        .width('100%').height(48).padding({ left: 8, right: 8 }).backgroundColor('#FFFFFF')
        .border({ width: { bottom: 1 }, color: '#F3F4F6' })

        if (this.isLoading && !this.hasError) {
          Progress({ value: this.loadProgress, total: 100, type: ProgressType.Linear })
            .width('100%').height(2).color('#3B82F6')
        }

        if (this.serverUrl.length > 0 && !this.hasError) {
          Web({ src: this.serverUrl, controller: this.controller })
            .domStorageAccess(true).databaseAccess(true).javaScriptAccess(true)
            .mixedMode(MixedMode.All).imageAccess(true).cacheMode(CacheMode.Default)
            .width('100%').layoutWeight(1)
            .onPageBegin((_event: OnPageBeginEvent) => {
              this.isLoading = true;
              this.hasError = false;
            })
            .onPageEnd((event: OnPageEndEvent) => {
              this.isLoading = false;
              this.injectBridge();
              this.canGoBack = this.controller.accessBackward();
            })
            .onProgressChange((event: OnProgressChangeEvent) => {
              this.loadProgress = event.newProgress;
            })
            .onTitleReceive((event: OnTitleReceiveEvent) => {
              if (event.title.length > 0) {
                this.pageTitle = event.title;
              }
            })
            .onConsole((event: OnConsoleEvent) => {
              const msg = parseBridgeMessage(event.message.getMessage());
              if (msg) {
                this.handleBridgeEvent(msg.event, msg.data);
                return false;
              }
              return true;
            })
            .onErrorReceive((event: OnErrorReceiveEvent) => {
              console.error('[WebViewPage] error:', event.error.getErrorInfo());
            })
            .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
              console.error('[WebViewPage] http error:', event.request.getRequestUrl(), event.response.getResponseCode());
            })
        }

        if (this.hasError) {
          Column() {
            Text('\u26a0\ufe0f').fontSize(48).margin({ bottom: 16 })
            Text('加载失败').fontSize(18).fontWeight(FontWeight.Medium).fontColor('#111827')
            Text(this.errorMsg).fontSize(14).fontColor('#6B7280').margin({ top: 8 }).textAlign(TextAlign.Center)
            Button('重新加载').fontSize(14).height(40).backgroundColor('#3B82F6').fontColor('#FFFFFF')
              .borderRadius(8).margin({ top: 24 }).onClick(() => { this.handleRefresh(); })
            Button('重新配置服务器').fontSize(14).height(40).backgroundColor('#F3F4F6').fontColor('#374151')
              .borderRadius(8).margin({ top: 12 }).onClick(() => { this.handleClearConfig(); })
          }
          .layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
        }

        if (this.serverUrl.length === 0) {
          Column() {
            LoadingProgress().width(48).height(48).color('#3B82F6')
            Text('正在加载...').fontSize(14).fontColor('#6B7280').margin({ top: 16 })
          }
          .layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
        }
      }
      .width('100%').height('100%').backgroundColor('#FFFFFF')

      if (this.showMenu) {
        Column() {
          Row().width('100%').layoutWeight(1).onClick(() => { this.showMenu = false; })
          Column() {
            Row() { Text('\u21bb  刷新页面').fontSize(15).fontColor('#374151').layoutWeight(1) }
              .width('100%').height(48).padding({ left: 16, right: 16 })
              .onClick(() => { this.handleRefresh(); })
            Divider().color('#F3F4F6')
            Row() { Text('\u2699  重新配置服务器').fontSize(15).fontColor('#374151').layoutWeight(1) }
              .width('100%').height(48).padding({ left: 16, right: 16 })
              .onClick(() => { this.showMenu = false; this.handleClearConfig(); })
            Divider().color('#F3F4F6')
            Text('当前服务器：' + this.serverUrl).fontSize(12).fontColor('#9CA3AF').width('100%')
              .padding({ left: 16, right: 16, top: 8, bottom: 8 })
          }
          .width('100%').backgroundColor('#FFFFFF')
          .borderRadius({ topLeft: 16, topRight: 16 }).padding({ top: 8, bottom: 24 })
          .shadow({ radius: 16, color: 'rgba(0,0,0,0.1)', offsetY: -4 })
        }
        .width('100%').height('100%')
      }
    }
    .width('100%').height('100%')
  }
}
