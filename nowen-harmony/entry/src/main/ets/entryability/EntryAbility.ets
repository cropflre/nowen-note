/**
 * EntryAbility - 应用入口 Ability
 *
 * 职责：
 *   1. 初始化 PreferenceStore
 *   2. 设置窗口属性（状态栏、全屏布局）
 *   3. 设置启动页背景
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { initPreferenceStore } from '../services/PreferenceStore';

export default class EntryAbility extends UIAbility {
  private preferencesReady: Promise<void> = Promise.resolve();

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 初始化偏好存储
    this.preferencesReady = initPreferenceStore(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.preferencesReady.then(() => {
      windowStage.loadContent('pages/Index', (err) => {
        if (err.code) {
          console.error('[EntryAbility] loadContent failed:', err.code);
        }
      });
    });

    windowStage.getMainWindow((err, win: window.Window) => {
      if (err.code) {
        console.error('[EntryAbility] getMainWindow failed:', err.code);
        return;
      }

      // 设置布局延伸到安全区（状态栏/导航栏下方也渲染内容）
      win.setWindowLayoutFullScreen(true);

      // 设置状态栏和导航栏外观
      win.setWindowSystemBarProperties({
        statusBarContentColor: '#111827',
        navigationBarContentColor: '#111827',
        statusBarColor: '#00000000', // 透明状态栏
        navigationBarColor: '#FFFFFF',
      });
    });
  }

  onWindowStageDestroy(): void {
    // 清理
  }

  onForeground(): void {
    // 进入前台
  }

  onBackground(): void {
    // 进入后台
  }
}
