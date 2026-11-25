export default function WebUiDisabledPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-6 text-center text-zinc-600">
      <main className="max-w-lg rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900 mb-3">网页端已被管理员关闭</h1>
        <p className="text-sm leading-7">
          当前服务器仅提供 API 服务。请使用 Nowen Note 桌面客户端连接该服务器。
        </p>
      </main>
    </div>
  );
}
