import { router } from '@kit.ArkUI';
import { getString, setString, remove } from '../services/PreferenceStore';
import { checkServerHealth, type HealthCheckResult } from '../services/HealthChecker';
import { normalizeServerUrl } from '../utils/UrlValidator';
import { PREF_KEY_SERVER_URL, PREF_KEY_LAST_SERVER_URL } from '../utils/Constants';

@Entry
@Component
struct ServerConfigPage {
  @State serverInput: string = '';
  @State protocolIndex: number = 0;
  @State isLoading: boolean = false;
  @State errorMsg: string = '';
  @State statusMsg: string = '';

  private protocolOptions: string[] = ['http', 'https'];

  aboutToAppear(): void {
    // Load last input for convenience
    this.loadLastUrl();
  }

  private async loadLastUrl(): Promise<void> {
    const last: string = await getString(PREF_KEY_LAST_SERVER_URL, '');
    if (last.length > 0) {
      if (last.startsWith('https://')) {
        this.protocolIndex = 1;
        this.serverInput = last.substring('https://'.length);
      } else {
        this.protocolIndex = 0;
        this.serverInput = last.replace(/^https?:\/\//, '');
      }
    }
  }

  private getFullUrl(): string {
    const raw: string = this.serverInput.trim();
    if (raw.length === 0) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return normalizeServerUrl(raw);
    }
    return normalizeServerUrl(this.protocolOptions[this.protocolIndex] + '://' + raw);
  }

  private async handleConnect(): Promise<void> {
    this.errorMsg = '';
    this.statusMsg = '';
    const serverUrl: string = this.getFullUrl();
    if (serverUrl.length === 0) {
      this.errorMsg = 'Please enter server address';
      return;
    }
    this.isLoading = true;
    this.statusMsg = 'Connecting...';
    const result: HealthCheckResult = await checkServerHealth(serverUrl, 8000);
    if (result.ok) {
      this.statusMsg = 'Connected!';
      await setString(PREF_KEY_SERVER_URL, serverUrl);
      await setString(PREF_KEY_LAST_SERVER_URL, serverUrl);
      setTimeout(() => {
        const opts: router.RouterOptions = { url: 'pages/WebViewPage', params: { serverUrl: serverUrl } };
        router.pushUrl(opts);
      }, 600);
    } else {
      this.errorMsg = result.error || 'Connection failed';
      this.statusMsg = '';
    }
    this.isLoading = false;
  }

  build() {
    Column() {
      Row().height(48)

      Column() {
        Text('\ud83d\udcdd').fontSize(56).margin({ bottom: 16 })
        Text('Nowen Note').fontSize(26).fontWeight(FontWeight.Bold).fontColor('#111827')
        Text('Connect to your server').fontSize(14).fontColor('#6B7280').margin({ top: 8 })
      }
      .margin({ top: 36, bottom: 44 })

      Column() {
        Row() {
          ForEach(this.protocolOptions, (proto: string, index: number) => {
            Text(proto)
              .fontSize(14)
              .fontColor(this.protocolIndex === index ? '#FFFFFF' : '#6B7280')
              .backgroundColor(this.protocolIndex === index ? '#3B82F6' : '#F3F4F6')
              .padding({ left: 12, right: 12, top: 6, bottom: 6 })
              .borderRadius(6)
              .onClick(() => { this.protocolIndex = index; })
          })
          Text('://').fontSize(15).fontColor('#9CA3AF').margin({ left: 6, right: 6 })
          TextInput({ placeholder: '192.168.1.100:3001', text: this.serverInput })
            .layoutWeight(1).height(44).fontSize(15).backgroundColor('#FFFFFF')
            .onChange((value: string) => { this.serverInput = value; this.errorMsg = ''; })
            .onSubmit(() => { this.handleConnect(); })
        }
        .width('100%').padding(12).borderRadius(12).backgroundColor('#F9FAFB')
        .border({ width: 1, color: this.errorMsg.length > 0 ? '#EF4444' : '#E5E7EB' })

        if (this.errorMsg.length > 0) {
          Text(this.errorMsg).fontSize(13).fontColor('#EF4444').margin({ top: 8 }).width('100%')
        }
        if (this.statusMsg.length > 0) {
          Text(this.statusMsg).fontSize(13).fontColor('#22C55E').margin({ top: 8 }).width('100%')
        }

        Button(this.isLoading ? 'Connecting...' : 'Connect')
          .width('100%').height(48).fontSize(16).fontWeight(FontWeight.Medium)
          .backgroundColor(this.isLoading ? '#93C5FD' : '#3B82F6').borderRadius(12)
          .margin({ top: 24 })
          .enabled(!this.isLoading && this.serverInput.trim().length > 0)
          .onClick(() => { this.handleConnect(); })

        Text('Enter your nowen-note server address\nExample: http://192.168.1.100:3001')
          .fontSize(12).fontColor('#9CA3AF').margin({ top: 16 }).textAlign(TextAlign.Center).width('100%')
      }
      .width('85%').alignItems(HorizontalAlign.Center)

      Blank()

      Text('Nowen Note for HarmonyOS')
        .fontSize(12).fontColor('#D1D5DB').margin({ bottom: 48 })
    }
    .width('100%').height('100%').backgroundColor('#FFFFFF')
  }
}