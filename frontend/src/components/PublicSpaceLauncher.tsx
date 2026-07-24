import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  ChevronRight,
  Globe2,
  Layers3,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LEGACY_TRANSFER_TRIGGER = 'button[aria-label="跨空间转移笔记"]';
const RAIL_MOUNT_ATTRIBUTE = "data-nowen-space-actions-mount";
const RAIL_ICON_SIZE = 18;

type RailMount = {
  id: string;
  element: HTMLElement;
  rail: HTMLElement;
  showLabel: boolean;
};

type OpenPanel = {
  anchor: DOMRect;
  rail: HTMLElement;
  sourceId: string;
  mobile: boolean;
};

type SpaceActionCopy = {
  label: string;
  title: string;
  description: string;
  transferTitle: string;
  transferDescription: string;
  publicTitle: string;
  publicDescription: string;
  close: string;
};

function resolveCopy(): SpaceActionCopy {
  const language = document.documentElement.lang || navigator.language || "zh-CN";
  if (!language.toLowerCase().startsWith("zh")) {
    return {
      label: "Spaces",
      title: "Space actions",
      description: "Move content or browse public knowledge bases",
      transferTitle: "Transfer across spaces",
      transferDescription: "Copy or safely move notes between personal and team spaces",
      publicTitle: "Public space",
      publicDescription: "Browse publicly published knowledge bases",
      close: "Close",
    };
  }
  return {
    label: "空间",
    title: "空间操作",
    description: "管理内容流转与公开知识库",
    transferTitle: "跨空间转移",
    transferDescription: "在个人空间和团队空间之间复制或安全移动笔记",
    publicTitle: "公共空间",
    publicDescription: "浏览公开发布的知识库",
    close: "关闭",
  };
}

function findRailNavigation(rail: HTMLElement): HTMLElement | null {
  return Array.from(rail.children).find((child) => {
    if (!(child instanceof HTMLElement)) return false;
    return child.classList.contains("flex-1") && child.classList.contains("overflow-y-auto");
  }) as HTMLElement | null;
}

function railMountsEqual(previous: RailMount[], next: RailMount[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => (
    item.element === next[index]?.element
    && item.rail === next[index]?.rail
    && item.showLabel === next[index]?.showLabel
  ));
}

/**
 * 全局空间入口桥。
 *
 * “跨空间转移”和“公共空间”都是低频的空间级能力，不再使用右下角悬浮按钮。
 * 本组件将一个与 NavRail 原生导航项同尺寸的“空间”入口挂载到工具组末尾，当前
 * 工具组最后一项是 AI 问答，因此视觉上稳定展示在 AI 问答下方。
 *
 * 桌面端点击后在导航栏右侧打开紧凑菜单；移动端点击后打开底部 Sheet，避免和
 * 侧栏、底部安全区及软键盘争抢位置。旧版 NoteTransferCenter 仍持有弹窗状态，
 * 这里隐藏其旧悬浮触发器并复用 click 行为，确保迁移过程不改变转移业务逻辑。
 */
interface PublicSpaceLauncherProps {
  visible?: boolean;
}

export default function PublicSpaceLauncher({ visible = true }: PublicSpaceLauncherProps) {
  const [railMounts, setRailMounts] = useState<RailMount[]>([]);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const legacyTransferTriggerRef = useRef<HTMLButtonElement | null>(null);
  const copy = useMemo(resolveCopy, []);

  useEffect(() => {
    let frame = 0;

    const refresh = () => {
      frame = 0;

      const trigger = document.querySelector<HTMLButtonElement>(LEGACY_TRANSFER_TRIGGER);
      if (trigger) {
        legacyTransferTriggerRef.current = trigger;
        trigger.hidden = true;
        trigger.dataset.spaceActionsManaged = "true";
      }

      if (!visible) {
        document.querySelectorAll<HTMLElement>("[" + RAIL_MOUNT_ATTRIBUTE + "]").forEach((mount) => mount.remove());
        setRailMounts((previous) => previous.length === 0 ? previous : []);
        return;
      }

      const mounts: RailMount[] = [];
      document.querySelectorAll<HTMLElement>(".nav-rail").forEach((rail, index) => {
        const navigation = findRailNavigation(rail);
        if (!navigation) return;

        let mount = navigation.querySelector<HTMLElement>(`[${RAIL_MOUNT_ATTRIBUTE}]`);
        if (!mount) {
          mount = document.createElement("div");
          mount.setAttribute(RAIL_MOUNT_ATTRIBUTE, "true");
          mount.className = "contents";
          navigation.appendChild(mount);
        }

        mounts.push({
          id: `${rail.classList.contains("md:hidden") ? "mobile" : "desktop"}-${index}`,
          element: mount,
          rail,
          showLabel: rail.classList.contains("w-16"),
        });
      });

      setRailMounts((previous) => railMountsEqual(previous, mounts) ? previous : mounts);
    };

    const scheduleRefresh = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(refresh);
    };

    refresh();
    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      document.querySelectorAll<HTMLElement>(`[${RAIL_MOUNT_ATTRIBUTE}]`).forEach((mount) => mount.remove());

    };
  }, [visible]);

  useEffect(() => () => {
    const trigger = legacyTransferTriggerRef.current;
    if (trigger?.dataset.spaceActionsManaged === "true") {
      trigger.hidden = false;
      delete trigger.dataset.spaceActionsManaged;
    }
  }, []);

  useEffect(() => {
    if (!visible) setPanel(null);
  }, [visible]);

  useEffect(() => {
    if (!panel) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    const closeOnViewportChange = () => setPanel(null);

    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [panel]);

  const closeMobileRail = (rail: HTMLElement) => {
    if (!rail.classList.contains("md:hidden")) return;
    const closeButton = rail.querySelector<HTMLButtonElement>("button");
    closeButton?.click();
  };

  const openTransferCenter = () => {
    const activePanel = panel;
    setPanel(null);
    if (activePanel?.mobile) closeMobileRail(activePanel.rail);

    window.requestAnimationFrame(() => {
      const cached = legacyTransferTriggerRef.current;
      const trigger = cached?.isConnected
        ? cached
        : document.querySelector<HTMLButtonElement>(LEGACY_TRANSFER_TRIGGER);

      if (trigger) {
        legacyTransferTriggerRef.current = trigger;
        trigger.click();
        return;
      }

      window.dispatchEvent(new CustomEvent("nowen:open-note-transfer"));
    });
  };

  const openPublicSpace = () => {
    setPanel(null);
    window.location.assign("/public");
  };

  const renderRailButton = (mount: RailMount) => {
    const active = panel?.sourceId === mount.id;
    const itemClass = mount.showLabel
      ? "relative w-14 py-1.5 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors"
      : "relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors";

    return createPortal(
      <button
        type="button"
        onClick={(event) => {
          const anchor = event.currentTarget.getBoundingClientRect();
          setPanel((current) => current?.sourceId === mount.id
            ? null
            : {
                anchor,
                rail: mount.rail,
                sourceId: mount.id,
                mobile: window.matchMedia("(max-width: 767px)").matches,
              });
        }}
        className={cn(
          itemClass,
          active
            ? "bg-accent-primary/12 text-accent-primary"
            : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
        )}
        title={mount.showLabel ? undefined : copy.label}
        aria-label={copy.label}
        aria-haspopup="menu"
        aria-expanded={active}
      >
        {active && (
          <span
            className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-primary"
            aria-hidden
          />
        )}
        <Layers3 size={RAIL_ICON_SIZE} />
        {mount.showLabel && (
          <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
            {copy.label}
          </span>
        )}
      </button>,
      mount.element,
      mount.id,
    );
  };

  const panelContent = (
    <>
      <div className="flex items-start gap-3 border-b border-app-border/70 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
          <Layers3 size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-tx-primary">{copy.title}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-tx-tertiary">{copy.description}</div>
        </div>
        <button
          type="button"
          onClick={() => setPanel(null)}
          className="rounded-lg p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          aria-label={copy.close}
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-1.5">
        <button
          type="button"
          role="menuitem"
          onClick={openTransferCenter}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-app-hover active:bg-app-active"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
            <ArrowLeftRight size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-tx-primary">{copy.transferTitle}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-tx-tertiary">{copy.transferDescription}</span>
          </span>
          <ChevronRight size={15} className="shrink-0 text-tx-tertiary" />
        </button>

        <button
          type="button"
          role="menuitem"
          onClick={openPublicSpace}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-app-hover active:bg-app-active"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
            <Globe2 size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-tx-primary">{copy.publicTitle}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-tx-tertiary">{copy.publicDescription}</span>
          </span>
          <ChevronRight size={15} className="shrink-0 text-tx-tertiary" />
        </button>
      </div>
    </>
  );

  const renderPanel = () => {
    if (!panel || typeof document === "undefined") return null;

    if (panel.mobile) {
      return createPortal(
        <div
          className="fixed inset-0 z-[135] flex items-end bg-black/40 backdrop-blur-[2px]"
          data-swipe-blocker=""
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <div
            className="w-full overflow-hidden rounded-t-2xl border-t border-app-border bg-app-elevated shadow-2xl"
            style={{ paddingBottom: "max(var(--safe-area-bottom, 0px), 12px)" }}
            role="menu"
            aria-label={copy.title}
          >
            <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-tx-tertiary/25" aria-hidden />
            {panelContent}
          </div>
        </div>,
        document.body,
      );
    }

    const width = Math.min(320, Math.max(260, window.innerWidth - panel.anchor.right - 24));
    const left = Math.min(panel.anchor.right + 8, window.innerWidth - width - 12);
    const top = Math.min(
      Math.max(12, panel.anchor.top - 8),
      Math.max(12, window.innerHeight - 250),
    );

    return createPortal(
      <div
        className="fixed inset-0 z-[135]"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setPanel(null);
        }}
      >
        <div
          className="fixed overflow-hidden rounded-2xl border border-app-border bg-app-elevated/98 shadow-2xl backdrop-blur-xl"
          style={{ left, top, width }}
          role="menu"
          aria-label={copy.title}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {panelContent}
        </div>
      </div>,
      document.body,
    );
  };

  return (
    <>
      {railMounts.map(renderRailButton)}
      {renderPanel()}
    </>
  );
}
