/**
 * MobileFloatingToolbar —— 移动端吸附键盘的浮动工具栏
 * -----------------------------------------------------------------------------
 * 背景 / 动机：
 *   原来顶部工具栏在手机键盘弹起时根本够不着 —— 用户输入的位置被键盘顶起，
 *   视线焦点远离屏幕顶部，想加粗 / 转列表 / 切标题必须先收键盘再往回滚。
 *   印象笔记等主流笔记 App 的方案是：工具栏吸附在键盘正上方，跟着键盘浮动。
 *
 * 本组件实现该方案：
 *   - 仅在 **原生 App (Capacitor isNativePlatform) + 键盘弹起** 时渲染
 *   - `position: fixed; bottom: var(--keyboard-height, 0px)`，键盘在哪它就在哪
 *   - 按钮数组由调用方注入（Tiptap / MarkdownEditor 各自映射命令），
 *     本组件只管渲染 + 交互
 *
 * 关键交互细节：
 *   - onMouseDown / onTouchStart 阻止默认行为：避免点按钮时编辑器失焦，
 *     失焦会让软键盘立刻收起，用户按完按钮后键盘又要重新弹起一次（抖）。
 *   - 仅在 editor focus 时才显示（通过 `visible` 判断），避免切回笔记列表
 *     或聚焦到标题输入框时误显示。
 *   - 不承担"保持编辑器可视区不被自己挡住"的责任 —— 编辑器滚动容器已经
 *     通过 `paddingBottom: var(--keyboard-height, 0)` 吃掉键盘高度，
 *     该浮动工具栏叠加在键盘上方，本身高度不大（~44px），光标继续可见。
 *
 * Web / Electron 下：useKeyboardVisible 直接返回 visible=false，组件自动不渲染。
 */

import React, { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";

/**
 * 工具栏高度（固定值），单位 px。
 * 与下方 `h-11`（2.75rem ≈ 44px）+ 上下 border 总计约 44-45px 对应。
 * 通过 CSS 变量 `--mobile-toolbar-h` 暴露给编辑器滚动容器，
 * 避免最后一行文字被工具栏遮挡。
 */
const TOOLBAR_HEIGHT_PX = 44;

export interface MobileToolbarItem {
  /** 唯一 key */
  key: string;
  /** 图标或标签节点 */
  icon: React.ReactNode;
  /** title / aria-label */
  title: string;
  /** 是否按下态高亮 */
  isActive?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 点击命令 */
  onClick: () => void;
}

interface MobileFloatingToolbarProps {
  items: MobileToolbarItem[];
  /**
   * 当且仅当调用方判断"应当显示"时为 true：
   *   - 编辑器本身可编辑
   *   - 未被全屏弹窗盖住
   *   - （通常）编辑器视图处于聚焦状态
   *
   * 默认为 true；键盘弹起状态由本组件内部判断。
   */
  visible?: boolean;
}

/**
 * 为什么阻止 mousedown 默认行为：
 *   mousedown 才是移焦点事件的源头（mobile 上点击按钮时会先 mousedown 再 click）。
 *   阻止默认就能让编辑器保持聚焦、光标不跳、软键盘不收起 —— 这是所有吸附键盘类
 *   工具栏的共同关键。touchstart 同理。
 */
function preventDefocus(e: React.MouseEvent | React.TouchEvent) {
  e.preventDefault();
}

export default function MobileFloatingToolbar({
  items,
  visible = true,
}: MobileFloatingToolbarProps) {
  const { visible: keyboardVisible } = useKeyboardVisible();
  const shouldShow = keyboardVisible && visible;

  /**
   * 组件实际显示时，把工具栏高度写到 `--mobile-toolbar-h`，
   * 编辑器滚动容器会用 `paddingBottom: calc(var(--keyboard-height) + var(--mobile-toolbar-h))`
   * 把这 44px 也吃掉，保证最后一行文字不被浮动工具栏遮挡。
   * 隐藏 / 卸载时立刻清零，避免桌面端 / 其他场景残留 padding。
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    if (shouldShow) {
      html.style.setProperty("--mobile-toolbar-h", `${TOOLBAR_HEIGHT_PX}px`);
    } else {
      html.style.setProperty("--mobile-toolbar-h", "0px");
    }
    return () => {
      // 卸载时兜底清零
      html.style.setProperty("--mobile-toolbar-h", "0px");
    };
  }, [shouldShow]);

  // 未弹起键盘 / 外部判定不该显示 → 什么都不渲染
  if (!shouldShow) return null;

  return (
    <div
      // fixed 定位到键盘正上方
      // bottom 用 CSS 变量：键盘高度变化（例如表情键盘切换）时跟随
      // left/right:0 + max-width 居中，避免横屏时过宽
      className={cn(
        "fixed left-0 right-0 z-40",
        "border-t border-app-border bg-app-elevated/95 backdrop-blur-md",
        "shadow-[0_-2px_8px_rgba(0,0,0,0.08)] dark:shadow-[0_-2px_8px_rgba(0,0,0,0.3)]",
      )}
      style={{ bottom: "var(--keyboard-height, 0px)" }}
      // 吞掉触摸滚动，避免误把工具栏当编辑器滚动
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center gap-0.5 px-2 h-11 overflow-x-auto hide-scrollbar"
        // 工具栏内容区也阻止 mousedown 默认，防止点到按钮间隙时编辑器失焦
        onMouseDown={preventDefocus}
        onTouchStart={preventDefocus}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            title={item.title}
            aria-label={item.title}
            // 关键：mousedown/touchstart 阻止默认，click 里才真正执行命令
            onMouseDown={preventDefocus}
            onTouchStart={preventDefocus}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!item.disabled) item.onClick();
            }}
            className={cn(
              // 44x40 触控友好尺寸（> 44dp 最小可点）
              "shrink-0 min-w-[40px] h-10 flex items-center justify-center rounded-md",
              "transition-colors active:scale-[0.96]",
              item.isActive
                ? "bg-accent-primary/20 text-accent-primary"
                : "text-tx-secondary active:bg-app-hover",
              item.disabled && "opacity-30",
            )}
          >
            {item.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
