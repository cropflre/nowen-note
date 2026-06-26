import React, { useEffect, useRef, useState } from "react";
import QRCodeLib from "qrcode";

/**
 * 轻量二维码组件
 *
 * 使用 qrcode 库在 canvas 上本地生成，不依赖第三方在线服务。
 * 适用于 2FA otpauth URI 等场景。
 */
export default function QRCode({
  value,
  size = 200,
  className = "",
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!canvasRef.current || !value) return;
    setError(false);
    QRCodeLib.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: {
        dark: "#18181b",   // zinc-900
        light: "#ffffff",
      },
      errorCorrectionLevel: "M",
    }).catch((err: unknown) => {
      console.error("QR code generation failed:", err);
      setError(true);
    });
  }, [value, size]);

  if (error) {
    return (
      <div
        className={`flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 ${className}`}
        style={{ width: size, height: size }}
      >
        <span className="text-xs text-zinc-500 dark:text-zinc-400 text-center px-4">
          二维码生成失败，请使用密钥手动绑定
        </span>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className={`rounded-xl ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
