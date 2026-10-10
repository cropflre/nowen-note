/**
 * 右上角固定的「服务端连接」指示器 —— 延迟 + 可用性。
 *
 * 放在**固定定位**层而不是塞进 TopBar：TopBar 每个页面各写一份，
 * 塞进去就得改十几处，而且滚动时会跟着走。固定层一处渲染、全局可见。
 *
 * 状态色：绿（正常）/ 黄（慢，≥800ms）/ 红（连不上）/ 灰点（检测中）
 * 点一下可手动重测。
 */
import { isBadgeEnabled, useConnStatus } from "../lib/connStatus";
import { useI18n } from "../lib/i18n";

export function ConnectionBadge() {
  const { t } = useI18n();
  const { state, latency } = useConnStatus();
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

  // 用 span 而不是 button：它刻意不接收点击（见 styles.css 里的说明），
  // 做成按钮只会诱导用户去点一个点不动的东西。
  return (
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
  );
}
