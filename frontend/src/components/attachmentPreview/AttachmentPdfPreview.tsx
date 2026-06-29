// AttachmentPdfPreview.tsx —— PDF 附件预览
//
// 实现选择：直接用 <iframe> 走浏览器内置 PDF Viewer。
// 原因：
//   1. Chrome / Edge / Safari / Firefox 全部内置完整 PDF Viewer（翻页/缩放/搜索/打印），
//      自己用 pdfjs 实现一遍要写 200+ 行还做不到这个完成度；
//   2. 零额外体积——pdfjs 库只在 importService 抽文本时需要，预览不必再拉一份；
//   3. 后端 attachments 路由支持 ?inline=1 跳过 Content-Disposition: attachment，
//      iframe 加载时浏览器才会内联渲染而不是触发下载。
//
// 不做的事：
//   - 不做自定义工具栏：浏览器原生工具栏已经够用；
//   - 不做密码 PDF / 表单填写：这是阅读型预览，编辑场景去专业工具。
import React from "react";
import { cn } from "@/lib/utils";

interface Props {
  url: string;
  filename: string;
  /** 容器高度类，与其他子组件 API 保持一致 */
  heightClass?: string;
}

/** 给 url 加 inline=1，告诉后端走 inline 渲染而不是 attachment 下载 */
function toInlineUrl(url: string): string {
  if (!url) return url;
  // 已经带了 inline 参数就别重复加
  if (/[?&]inline=1\b/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "inline=1";
}

export default function AttachmentPdfPreview({ url, filename, heightClass }: Props) {
  const src = toInlineUrl(url);

  return (
    <iframe
      // title 给屏幕阅读器读出来——React 对 iframe 强制要求
      title={filename || "PDF 预览"}
      src={src}
      // SEC-ELECTRON-01-D3: sandbox 限制 PDF 内脚本执行
      sandbox="allow-scripts"
      className={cn(
        "w-full bg-zinc-950/5 border-0",
        // 没传 heightClass 时给个默认——和 docx/文本预览的体感一致
        heightClass ?? "min-h-[60vh]",
      )}
    />
  );
}
