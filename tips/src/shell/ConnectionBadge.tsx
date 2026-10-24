/**
 * 右上角固定的「服务端连接」指示器 —— 延迟 + 可用性。
 *
 * 放在**固定定位**层而不是塞进 TopBar：TopBar 每个页面各写一份，
 * 塞进去就得改十几处，而且滚动时会跟着走。固定层一处渲染、全局可见。
 *
 * 状态色：绿（正常）/ 黄（慢，≥800ms）/ 红（连不上）/ 灰点（检测中）
 * 点一下可手动重测。
 */
import { isBadgeEnabled, probeConnection, useConnStatus } from "../lib/connStatus";
import { requestRefresh, useRefreshing } from "../lib/refreshBus";
import { useI18n } from "../lib/i18n";

export function ConnectionBadge() {
  const { t } = useI18n();
  const { state, latency } = useConnStatus();
  const refreshing = useRefreshing();
  if (!isBadgeEnabled()) return null;

  const text =
    state === "ok" || state === "slow"
      ? `${latency} ms`
      : state === "fail"
        ? t("conn.offline")
        : state === "checking"
          ? "…"
          : t("conn.idle");

  const label =
    state === "ok" || state === "slow"
      ? t("conn.ok", { ms: latency ?? 0 })
      : state === "fail"
        ? t("conn.fail")
        : t("conn.checking");

  const refreshLabel = refreshing ? t("conn.refreshing") : t("conn.refresh");

  return (
    <div className="conn-cluster">
      {/* 状态胶囊刻意不接收点击；重测走右边那颗刷新键（它才是可点的） */}
      <span
        className="conn-badge glass"
        data-state={state}
        aria-label={label}
        title={label}
        data-testid="conn-badge"
      >
        <span className="conn-dot" aria-hidden="true" />
        <span className="conn-text" data-testid="conn-latency">
          {text}
        </span>
      </span>

      <button
        type="button"
        className="conn-refresh glass"
        data-busy={refreshing}
        onClick={() => void Promise.all([probeConnection(), requestRefresh()])}
        aria-label={refreshLabel}
        title={refreshLabel}
        data-testid="conn-refresh"
      >
        <span className="conn-refresh-icon" aria-hidden="true">
          ↻
        </span>
      </button>
    </div>
  );
}
