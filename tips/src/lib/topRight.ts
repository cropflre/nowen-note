/**
 * 「右上角是否已被当前视图占用」——连接状态胶囊 + 刷新键只在主页各视图、
 * 且不遮住任何控件时才显示。
 *
 * 背景（2026-10-14 用户反馈）：胶囊是固定定位在右上角的，而
 *   · 说说编辑态在顶栏右侧放了「×」
 *   · 阅读 / 编辑笔记页在顶栏右侧放了「编辑 / 取消 / 保存」
 * 位置正好重合。之前的权宜之计是让胶囊 pointer-events:none（看得见、点得到下面的按钮），
 * 但视觉上仍然压着。现在的做法：那些状态由页面自己标记「占用」，
 * App 据此整组隐藏（状态 + 刷新键）。
 */
import { useEffect, useState } from "react";

let occupied = false;
const listeners = new Set<() => void>();

export function setTopRightOccupied(on: boolean): void {
  if (occupied === on) return;
  occupied = on;
  for (const fn of listeners) fn();
}

export function useTopRightOccupied(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return occupied;
}

/** 页面里一行接入：`useTopRightOccupiedWhile(composing)` */
export function useTopRightOccupiedWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    setTopRightOccupied(true);
    return () => setTopRightOccupied(false);
  }, [active]);
}
