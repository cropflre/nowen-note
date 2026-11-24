/**
 * 文件管理中心（ViewMode=files）
 * 页面本体是 fileExplorer/FileExplorer：同一页内提供「文件｜图床｜存储与工具」三个视图。
 * 原「图床、存储与更多工具」独立界面的能力已并入这三个视图。
 */
import React from "react";
import { Loader2 } from "lucide-react";

const FileExplorer = React.lazy(() => import("./fileExplorer/FileExplorer"));
export default function FileManager() {
  return <React.Suspense fallback={<div className="p-6 text-tx-secondary"><Loader2 className="animate-spin" /></div>}><FileExplorer /></React.Suspense>;
}
