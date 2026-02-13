import { useState, useEffect, useCallback, useRef } from "react";

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  targetId: string | null;
  targetType: string | null;
}

const MENU_WIDTH = 192;
const MENU_HEIGHT = 240;

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    targetId: null,
    targetType: null,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = useCallback(
    (e: React.MouseEvent, targetId: string, targetType?: string) => {
      e.preventDefault();
      e.stopPropagation();

      let x = e.clientX;
      let y = e.clientY;

      // 边缘碰撞检测
      if (window.innerWidth - x < MENU_WIDTH) x -= MENU_WIDTH;
      if (window.innerHeight - y < MENU_HEIGHT) y -= MENU_HEIGHT;
      if (x < 0) x = 4;
      if (y < 0) y = 4;

      setMenu({ isOpen: true, x, y, targetId, targetType: targetType || null });
    },
    []
  );

  const closeMenu = useCallback(() => {
    setMenu((prev) =>
      prev.isOpen ? { ...prev, isOpen: false, targetId: null, targetType: null } : prev
    );
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // 点击菜单外部时关闭
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      closeMenu();
    };
    const handleScroll = () => closeMenu();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("scroll", handleScroll, { capture: true });
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);

    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("scroll", handleScroll, { capture: true });
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
    };
  }, [closeMenu]);

  return { menu, menuRef, openMenu, closeMenu };
}
