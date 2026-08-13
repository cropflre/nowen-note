function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

export function describeRuntimeMessageError(error: unknown): string {
  const message = messageOf(error);
  if (/extension context invalidated/i.test(message)) {
    return "剪藏插件刚刚更新或重新加载。请关闭并重新打开剪藏弹窗后再试。";
  }
  if (/could not establish connection|receiving end does not exist|message port closed|no receiving end/i.test(message)) {
    return "剪藏插件后台通信中断。请关闭并重新打开剪藏弹窗；若仍失败，请在扩展管理页重新加载插件。";
  }
  return message || "插件通信失败，请重新打开剪藏弹窗后重试。";
}
