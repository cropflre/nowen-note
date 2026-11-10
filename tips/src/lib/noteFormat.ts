/**
 * 列表行的文案格式化 —— 扁平视图与文件夹视图共用。
 *
 * 抽出来的原因很简单：两个视图的行长得要一样，
 * 各自抄一份 `relativeTime` 迟早会出现「同一个时间在两个视图里显示不同」。
 */
export { relativeTime } from "./time";

export function excerpt(text: string, max = 70): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
