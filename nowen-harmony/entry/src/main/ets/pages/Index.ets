import { router } from '@kit.ArkUI';
import { getString } from '../services/PreferenceStore';
import { PREF_KEY_SERVER_URL } from '../utils/Constants';

@Entry
@Component
struct Index {
  @State msg: string = 'Nowen Note';

  aboutToAppear(): void {
    this.go();
  }

  private async go(): Promise<void> {
    const url: string = await getString(PREF_KEY_SERVER_URL, '');
    if (url.length > 0) {
      const opts: router.RouterOptions = { url: 'pages/WebViewPage', params: { serverUrl: url } };
      router.replaceUrl(opts);
    } else {
      const opts: router.RouterOptions = { url: 'pages/ServerConfigPage' };
      router.replaceUrl(opts);
    }
  }

  build() {
    Column() {
      Text('Nowen Note').fontSize(20).fontColor('#374151')
    }
    .width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor('#F5F3EE')
  }
}