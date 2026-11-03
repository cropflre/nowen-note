/**
 * 通用分段控件（玻璃胶囊 + 滑动 thumb）。
 *
 * 从 ViewSwitch 抽出来的 —— 主题切换器要**完全同款**，复制一遍必然漂移。
 * 样式全在 .viewswitch / .vs-* 里，宽度靠 `--vs-count` 撑，选项数任意。
 *
 * 性能：thumb 只动 transform（不触发重排）；选项本身**不叠 backdrop-filter**
 * （性能铁律，见 styles.css 顶部）。
 */
export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel: string;
  testId?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );

  return (
    <div
      className="viewswitch glass"
      role="tablist"
      aria-label={ariaLabel}
      data-mode={value}
      data-testid={testId}
      style={{ "--vs-count": options.length } as React.CSSProperties}
    >
      <span
        className="vs-thumb"
        aria-hidden="true"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          className="vs-option"
          aria-selected={option.id === value}
          data-mode={option.id}
          onClick={() => onChange(option.id)}
        >
          <span className="vs-icon" aria-hidden="true">
            {option.icon}
          </span>
          <span className="vs-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
