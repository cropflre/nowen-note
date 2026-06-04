import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard } from "@capacitor/keyboard";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Task } from "@/types";

/** 判断是否运行在原生平台（Android / iOS） */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

// ---------------------------------------------------------------------------
// 模块加载时立刻把 `data-native` 标记写到 <html>，让 CSS 里 html[data-native="..."]
// 的安全区兜底（见 index.css）从 **首次渲染** 起就生效。如果等到 useStatusBarSync
// 的 useEffect 才设置，登录页 / SplashGate 等先渲染的组件会拿不到 --safe-area-top
// 的兜底值，导致顶栏贴住状态栏。
// ---------------------------------------------------------------------------
if (typeof document !== "undefined") {
  try {
    const platform = Capacitor.getPlatform(); // "android" | "ios" | "web"
    if (platform === "android" || platform === "ios") {
      document.documentElement.setAttribute("data-native", platform);
    }
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * P0: Android 返回键处理
 * 按层级依次关闭：编辑器 → 侧边栏 → 确认退出
 */
export function useBackButton({
  mobileView,
  mobileSidebarOpen,
  onBackToList,
  onCloseSidebar,
}: {
  mobileView: "list" | "editor";
  mobileSidebarOpen: boolean;
  onBackToList: () => void;
  onCloseSidebar: () => void;
}) {
  // 用于双击返回退出的时间戳
  const lastBackPress = useRef(0);

  useEffect(() => {
    if (!isNativePlatform()) return;

    const handler = CapApp.addListener("backButton", ({ canGoBack }) => {
      // 层级 1：侧边栏打开 → 关闭侧边栏
      if (mobileSidebarOpen) {
        onCloseSidebar();
        return;
      }

      // 层级 2：编辑器视图 → 返回笔记列表
      if (mobileView === "editor") {
        onBackToList();
        return;
      }

      // 层级 3：已经在列表视图 → 双击退出 App
      const now = Date.now();
      if (now - lastBackPress.current < 2000) {
        CapApp.exitApp();
      } else {
        lastBackPress.current = now;
        // 触觉反馈提示用户再按一次退出
        haptic.warning();
      }
    });

    return () => {
      handler.then((h) => h.remove());
    };
  }, [mobileView, mobileSidebarOpen, onBackToList, onCloseSidebar]);
}

/**
 * P1: Splash Screen 控制
 * 在应用完成初始化渲染后手动隐藏启动屏
 */
export function hideSplashScreen() {
  if (!isNativePlatform()) return;
  SplashScreen.hide({ fadeOutDuration: 300 });
}

/**
 * P2: 状态栏与主题同步
 * 监听 HTML class 变化，自动切换状态栏样式
 * 确保状态栏不覆盖 WebView 内容
 */
export function useStatusBarSync() {
  useEffect(() => {
    if (!isNativePlatform()) return;

    // 标注当前原生平台：CSS 里根据 html[data-native="android"] 切换 --safe-area-top
    // 策略（详见 index.css），避免 Android overlay:false 下 env() 恒为 0 的坑
    const platform = Capacitor.getPlatform(); // "android" | "ios" | "web"
    document.documentElement.setAttribute("data-native", platform);

    // 确保状态栏不覆盖 WebView 内容（状态栏占据独立空间，不盖住返回按钮）
    // 延迟执行确保原生层已就绪
    const ensureNoOverlay = () => {
      StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    };
    ensureNoOverlay();
    // 延迟再执行一次，防止初始化时序问题
    const timer = setTimeout(ensureNoOverlay, 500);

    // Android overlay:false 下 env(safe-area-inset-top) 永远是 0；
    // 但 Android 15+ (targetSdk>=35) 强制 Edge-to-Edge，setOverlaysWebView(false)
    // 在新系统上事实上不再生效——状态栏会持续 overlay 在 WebView 上。无论哪种
    // 情况，顶部都需要避让一段距离。
    //
    // 测量策略（按可信度从高到低尝试）：
    //   1) env(safe-area-inset-top)：浏览器规范的安全区，Capacitor 6+ Android 14+
    //      Edge-to-Edge 下能正确返回真实状态栏（含刘海避让）。最可信，优先使用。
    //   2) 兜底常量 28px：覆盖普通屏真实状态栏（Android 24dp ≈ 24-30px CSS）。
    //      故意不再用 `screen.height - visualViewport.height` 做差值估算——
    //      该差值在 Edge-to-Edge 下混合了状态栏 + 系统导航条 + 输入法等多种
    //      占用，硬分给顶部会导致顶部留白远大于真实状态栏（实测 70~80px），
    //      视觉上极不雅观。刘海屏由 (1) env() 提供真值即可，无需"猜"。
    //   - 只在 Android 上注入，iOS 走 env()
    let applyStatusBarHeight: (() => void) | null = null;
    if (platform === "android") {
      applyStatusBarHeight = () => {
        // 1) 先尝试读 env(safe-area-inset-top) —— 临时塞进一个隐藏元素再 getComputedStyle
        let topInset = 0;
        try {
          const probe = document.createElement("div");
          probe.style.cssText =
            "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;";
          document.body.appendChild(probe);
          const rect = probe.getBoundingClientRect();
          topInset = rect.height;
          document.body.removeChild(probe);
        } catch {
          /* ignore */
        }

        // 2) 兜底：env() 失效时使用 28px 常量。不再做差值估算，避免误差。
        //    刘海/挖孔屏 env() 通常正常返回 36-50px+，由 (1) 自动覆盖。
        const finalTop = topInset > 0 ? topInset : 28;

        document.documentElement.style.setProperty(
          "--android-status-bar-height",
          `${finalTop}px`,
        );
        // Android 15+ Edge-to-Edge 下底部导航/手势栏也是 overlay。
        // 兜底 24px（手势条 16dp + 少量呼吸），与 CSS 兜底保持一致。
        document.documentElement.style.setProperty(
          "--android-nav-bar-height",
          `24px`,
        );
      };
      applyStatusBarHeight();
      // 旋转屏或 splitscreen 变化后重新测量
      window.visualViewport?.addEventListener("resize", applyStatusBarHeight);
      window.addEventListener("orientationchange", applyStatusBarHeight);
    }

    const updateStatusBar = () => {
      const isDark = document.documentElement.classList.contains("dark");
      StatusBar.setStyle({
        style: isDark ? Style.Dark : Style.Light,
      }).catch(() => {});
      StatusBar.setBackgroundColor({
        color: isDark ? "#0d1117" : "#ffffff",
      }).catch(() => {});
    };

    // 初始化时立即执行一次
    updateStatusBar();

    // 监听 <html> 的 class 变化（next-themes 通过修改 class 切换主题）
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "class") {
          updateStatusBar();
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      if (applyStatusBarHeight) {
        window.visualViewport?.removeEventListener("resize", applyStatusBarHeight);
        window.removeEventListener("orientationchange", applyStatusBarHeight);
      }
    };
  }, []);
}

/**
 * P5: 键盘弹出布局适配
 * 监听软键盘显示/隐藏事件，动态调整可视区域高度
 * 确保编辑器光标始终可见，不被键盘遮挡
 */
export function useKeyboardLayout() {
  useEffect(() => {
    if (!isNativePlatform()) return;

    // 键盘弹出策略（重要 —— 别再回退到旧版做法）
    // ------------------------------------------------------------------
    // 之前的做法是：键盘弹起时把 `document.body.style.height` 压缩成
    // `innerHeight - keyboardHeight`，并对光标 `scrollIntoView({block:"center"})`。
    // 这会整体把 App 容器（含 `h-[100dvh]` 根 div）顶高变小，然后 scrollIntoView
    // 为把光标推到"中央"只能把整个页面向上滚 —— 用户看到的现象就是
    // **编辑器顶栏（返回/云/锁/三点）和格式化工具栏（H1/B/I/...）在打字时
    // 被顶出视口**。业务上编辑时最需要随手能点到的就是工具栏，体验灾难。
    //
    // 新策略：
    //   1) 不动 body/html 尺寸。只把 keyboardHeight 暴露为 CSS 变量
    //      `--keyboard-height`，由内部滚动容器（MarkdownEditor 的
    //      `.flex-1 .overflow-auto`）通过 `padding-bottom` 避让。
    //      这样顶栏/工具栏仍然稳稳 sticky 在最外层 flex 顶部，不会被挤走。
    //   2) scrollIntoView 从 `center` 改为 `nearest`：光标已经在视口里
    //      就什么都不做；只在被键盘盖住时才最小程度滚动，避免整页上移。
    //
    // 注：Android AndroidManifest 未显式声明 windowSoftInputMode，Capacitor 默认
    // 走 adjustResize；但无论是 resize 还是 pan 模式，我们都以 JS 侧的 CSS 变量
    // 为单一事实来源，不依赖原生布局调整。
    const showHandler = Keyboard.addListener("keyboardWillShow", (info) => {
      const height = info.keyboardHeight;
      document.documentElement.style.setProperty("--keyboard-height", `${height}px`);
      // 给 html 打标记，便于编辑器容器条件添加 padding-bottom
      document.documentElement.setAttribute("data-keyboard", "open");

      // 最小程度滚动：仅当光标被键盘遮挡才滚
      requestAnimationFrame(() => {
        const activeEl = document.activeElement;
        if (activeEl && "scrollIntoView" in activeEl) {
          (activeEl as HTMLElement).scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
        }
      });
    });

    const hideHandler = Keyboard.addListener("keyboardWillHide", () => {
      document.documentElement.style.setProperty("--keyboard-height", "0px");
      document.documentElement.removeAttribute("data-keyboard");
    });

    return () => {
      showHandler.then((h) => h.remove());
      hideHandler.then((h) => h.remove());
    };
  }, []);
}

/**
 * P7: 触觉反馈工具函数
 * 在关键交互时提供震动反馈，提升操作手感
 */
export const haptic = {
  /** 轻触反馈 - 用于普通点击操作（切换收藏、置顶等） */
  light: () => {
    if (!isNativePlatform()) return;
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  },

  /** 中等反馈 - 用于重要操作（删除、移动笔记等） */
  medium: () => {
    if (!isNativePlatform()) return;
    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
  },

  /** 重度反馈 - 用于危险操作确认（永久删除等） */
  heavy: () => {
    if (!isNativePlatform()) return;
    Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
  },

  /** 成功通知 - 用于操作成功（保存完成、同步成功等） */
  success: () => {
    if (!isNativePlatform()) return;
    Haptics.notification({ type: NotificationType.Success }).catch(() => {});
  },

  /** 警告通知 - 用于提醒操作（双击返回退出提示等） */
  warning: () => {
    if (!isNativePlatform()) return;
    Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
  },

  /** 错误通知 - 用于操作失败（保存失败、网络错误等） */
  error: () => {
    if (!isNativePlatform()) return;
    Haptics.notification({ type: NotificationType.Error }).catch(() => {});
  },

  /** 选择反馈 - 用于列表项选中、切换开关等 */
  selection: () => {
    if (!isNativePlatform()) return;
    Haptics.selectionStart().catch(() => {});
    Haptics.selectionEnd().catch(() => {});
  },
};

// ─── 待办事项本地通知调度 ──────────────────────────────────────────

function hashStringToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

async function checkAndRequestPermissions() {
  const status = await LocalNotifications.checkPermissions();
  if (status.display === "granted") return true;
  if (status.display === "prompt" || status.display === "prompt-with-rationale") {
    const requestStatus = await LocalNotifications.requestPermissions();
    return requestStatus.display === "granted";
  }
  return false;
}

export async function syncTaskNotification(task: Task) {
  if (!isNativePlatform()) return;
  try {
    const notificationId = hashStringToInt(task.id);
    try {
      await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
    } catch {}

    if (task.isCompleted || !task.remindAt) {
      return;
    }

    const [year, month, day] = task.remindAt.split("-").map(Number);
    const scheduleDate = new Date(year, month - 1, day, 9, 0, 0);

    if (scheduleDate.getTime() > Date.now()) {
      const granted = await checkAndRequestPermissions();
      if (!granted) return;

      await LocalNotifications.schedule({
        notifications: [
          {
            title: "任务提醒",
            body: task.title,
            id: notificationId,
            schedule: { at: scheduleDate },
            extra: { taskId: task.id }
          }
        ]
      });
    }
  } catch (err) {
    console.error("syncTaskNotification failed:", err);
  }
}

export async function syncAllTaskNotifications(tasks: Task[]) {
  if (!isNativePlatform()) return;
  try {
    const granted = await checkAndRequestPermissions();
    if (!granted) return;

    const pending = await LocalNotifications.getPending();
    const pendingIds = new Set(pending.notifications.map(n => n.id));

    const notificationsToSchedule: any[] = [];
    const idsToKeep = new Set<number>();

    for (const task of tasks) {
      const notificationId = hashStringToInt(task.id);
      
      if (task.isCompleted || !task.remindAt) {
        if (pendingIds.has(notificationId)) {
          await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
        }
        continue;
      }

      const [year, month, day] = task.remindAt.split("-").map(Number);
      const scheduleDate = new Date(year, month - 1, day, 9, 0, 0);

      if (scheduleDate.getTime() > Date.now()) {
        idsToKeep.add(notificationId);
        notificationsToSchedule.push({
          title: "任务提醒",
          body: task.title,
          id: notificationId,
          schedule: { at: scheduleDate },
          extra: { taskId: task.id }
        });
      } else {
        if (pendingIds.has(notificationId)) {
          await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
        }
      }
    }

    for (const p of pending.notifications) {
      if (!idsToKeep.has(p.id)) {
        await LocalNotifications.cancel({ notifications: [{ id: p.id }] });
      }
    }

    if (notificationsToSchedule.length > 0) {
      await LocalNotifications.schedule({ notifications: notificationsToSchedule });
    }
  } catch (err) {
    console.error("syncAllTaskNotifications failed:", err);
  }
}

// 注册通知点击跳转事件
if (typeof window !== "undefined" && isNativePlatform()) {
  try {
    LocalNotifications.addListener("localNotificationActionPerformed", () => {
      window.dispatchEvent(new CustomEvent("nowen:navigate-to-tasks"));
    });
  } catch (err) {
    console.error("Failed to register localNotificationActionPerformed listener:", err);
  }
}
