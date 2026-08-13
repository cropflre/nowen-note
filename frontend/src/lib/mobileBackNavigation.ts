export type MobileBackOverlayLayer = "image-viewer" | "modal" | "sheet";

type MobileBackHandler = () => boolean | void;

interface MobileBackEntry {
  layer: MobileBackOverlayLayer;
  order: number;
  handler: MobileBackHandler;
}

const LAYER_PRIORITY: Record<MobileBackOverlayLayer, number> = {
  "image-viewer": 300,
  modal: 200,
  sheet: 200,
};

const handlers = new Map<symbol, MobileBackEntry>();
let registrationOrder = 0;

/**
 * 登记一个原生返回键可关闭的浮层。同一层级后打开的先关闭。
 * 返回 false 表示当前登记已经失效，允许继续尝试下一层；其他返回值均消费本次返回。
 */
export function registerMobileBackHandler(
  layer: MobileBackOverlayLayer,
  handler: MobileBackHandler,
): () => void {
  const id = Symbol(layer);
  handlers.set(id, { layer, order: ++registrationOrder, handler });
  return () => {
    handlers.delete(id);
  };
}

/** 每次原生返回最多执行一个关闭动作。 */
export function consumeMobileBack(): boolean {
  const entries = Array.from(handlers.values()).sort((left, right) => {
    const priority = LAYER_PRIORITY[right.layer] - LAYER_PRIORITY[left.layer];
    return priority || right.order - left.order;
  });

  for (const entry of entries) {
    try {
      if (entry.handler() !== false) return true;
    } catch (error) {
      console.error(`[mobile-back] ${entry.layer} handler failed`, error);
      // 高优先级浮层关闭失败时仍消费返回，避免意外穿透到文档列表或退出 App。
      return true;
    }
  }
  return false;
}
