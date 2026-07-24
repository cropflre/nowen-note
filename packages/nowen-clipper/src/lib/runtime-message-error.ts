function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

export function describeRuntimeMessageError(error: unknown): string {
  const message = messageOf(error);
  if (/extension context invalidated/i.test(message)) {
    return "剪藏插件刚刚更新或重新加载。请关闭弹窗、刷新当前网页后再试。";
  }
  if (/could not establish connection|receiving end does not exist|message port closed|no receiving end/i.test(message)) {
    return "剪藏插件后台未正常启动。请在扩展管理页重新加载 Nowen Note Web Clipper，刷新当前网页后重试。";
  }
  return message || "插件通信失败，请重新打开剪藏弹窗后重试。";
}
