import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard } from "@capacitor/keyboard";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

/** 判断是否运行在原生平台（Android / iOS） */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
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

    // 确保状态栏不覆盖 WebView 内容（状态栏占据独立空间，不盖住返回按钮）
    // 延迟执行确保原生层已就绪
    const ensureNoOverlay = () => {
      StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    };
    ensureNoOverlay();
    // 延迟再执行一次，防止初始化时序问题
    const timer = setTimeout(ensureNoOverlay, 500);

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

    // 键盘弹出时，缩小 body 高度使编辑区可滚动
    const showHandler = Keyboard.addListener("keyboardWillShow", (info) => {
      const height = info.keyboardHeight;
      document.documentElement.style.setProperty("--keyboard-height", `${height}px`);
      document.body.style.height = `calc(100vh - ${height}px)`;
      document.body.style.overflow = "hidden";

      // 让光标所在元素滚动到可视区域
      requestAnimationFrame(() => {
        const activeEl = document.activeElement;
        if (activeEl && "scrollIntoView" in activeEl) {
          (activeEl as HTMLElement).scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      });
    });

    const hideHandler = Keyboard.addListener("keyboardWillHide", () => {
      document.documentElement.style.removeProperty("--keyboard-height");
      document.body.style.height = "";
      document.body.style.overflow = "";
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
