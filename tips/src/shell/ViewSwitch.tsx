/**
 * 视图切换（分段控件）—— 笔记流顶部搜索框下方。
 *
 * 视觉与底部导航同源：一个会滑动的玻璃胶囊。具体实现见 Segmented（主题切换器共用同一套）。
 */
import type { NotesViewMode } from "../lib/noteViewPrefs";
import { Segmented, type SegmentedOption } from "./Segmented";

const OPTIONS: SegmentedOption<NotesViewMode>[] = [
  { id: "flat", label: "仅看笔记", icon: "☰" },
  { id: "folders", label: "文件夹排布", icon: "🗂" },
];

export function ViewSwitch({
  value,
  onChange,
}: {
  value: NotesViewMode;
  onChange: (next: NotesViewMode) => void;
}) {
  return (
    <Segmented
      value={value}
      options={OPTIONS}
      onChange={onChange}
      ariaLabel="笔记排布方式"
      testId="view-switch"
    />
  );
}
