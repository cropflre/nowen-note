const MAX_LOG_LINES = 500;
const MAX_LOG_BYTES = 64 * 1024;

const SECRET_PATTERN = /(authorization|cookie|jwt|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi;

export function redactPluginLog(message: unknown): string {
  return String(message).replace(SECRET_PATTERN, "$1=[REDACTED]").slice(0, 4096);
}

export class ExecutionLogTail {
  private lines: string[] = [];
  private bytes = 0;

  add(level: string, message: unknown): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${redactPluginLog(message)}`;
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line, "utf8");
    while (this.lines.length > MAX_LOG_LINES || this.bytes > MAX_LOG_BYTES) {
      const removed = this.lines.shift();
      if (removed) this.bytes -= Buffer.byteLength(removed, "utf8");
    }
  }

  toArray(): string[] {
    return [...this.lines];
  }
}
