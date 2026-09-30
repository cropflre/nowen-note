import type { SpeechSettings } from "./userSpeechSettings";

export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
export class SpeechTranscriptionError extends Error {
  constructor(message: string, public status: 400 | 413 | 502 | 504) { super(message); }
}

export function speechEndpoint(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid speech service URL");
  return `${apiUrl.replace(/\/+$/, "")}/audio/transcriptions`;
}

export async function transcribeSpeech(settings: SpeechSettings, bytes: Uint8Array, filename: string, mimeType: string, language?: string | null, signal?: AbortSignal): Promise<{ text: string; language: string | null; model: string }> {
  if (!settings.apiUrl || !settings.model) throw new SpeechTranscriptionError("请先配置语音转写服务", 400);
  if (bytes.byteLength > MAX_TRANSCRIPTION_BYTES) throw new SpeechTranscriptionError("音频超过转写限制（25 MB）", 413);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  form.append("model", settings.model);
  form.append("response_format", "json");
  const selectedLanguage = language === "auto" ? null : language || settings.language;
  if (selectedLanguage) form.append("language", selectedLanguage);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(speechEndpoint(settings.apiUrl), {
      method: "POST", body: form,
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
      signal: controller.signal,
    });
    // 服务商响应可能包含请求头或密钥，不向客户端透传错误正文。
    if (!response.ok) throw new SpeechTranscriptionError(`语音转写服务请求失败（HTTP ${response.status}），请检查地址、模型及凭据`, 502);
    const result = await response.json() as { text?: unknown; language?: unknown };
    if (typeof result.text !== "string") throw new SpeechTranscriptionError("语音服务未返回有效转写结果", 502);
    return { text: result.text, language: typeof result.language === "string" ? result.language : selectedLanguage, model: settings.model };
  } catch (error) {
    if (error instanceof SpeechTranscriptionError) throw error;
    if (controller.signal.aborted) throw new SpeechTranscriptionError("语音转写超时或已取消，请重试", 504);
    throw new SpeechTranscriptionError("无法连接语音转写服务，请检查服务地址", 502);
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

export function speechConnectionProbe(): Uint8Array {
  // 用极短的静音 WAV 检验实际转写端点，避免模型列表可用却不支持语音。
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(3200, 40);
  return bytes;
}
