import { chooseVoiceRecordingMime, voiceRecordingExtension } from "./voiceRecordingMime";

export type VoiceRecorderState = "idle" | "requesting-permission" | "recording" | "paused" | "processing" | "uploading" | "saved" | "error";
export interface RecordedVoice {
  blob: Blob;
  mimeType: string;
  extension: string;
  durationMs: number;
  size: number;
}

export class VoiceRecorderSession {
  state: VoiceRecorderState = "idle";
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private elapsed = 0;
  private startedAt = 0;
  private cancelled = false;
  private completion?: Promise<RecordedVoice>;
  private stopEventReceived = false;

  constructor(private onState: (state: VoiceRecorderState) => void = () => {}, private onInterrupted: (voice: RecordedVoice) => void = () => {}) {}

  private setState(state: VoiceRecorderState) {
    this.state = state;
    this.onState(state);
  }

  get durationMs() {
    return this.elapsed + (this.state === "recording" ? performance.now() - this.startedAt : 0);
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("voice.insecure");
    this.setState("requesting-permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      // 权限弹窗期间取消后，也必须释放迟到的麦克风流。
      if (this.cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const mimeType = chooseVoiceRecordingMime(MediaRecorder);
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
      this.recorder.onstop = () => {
        this.stopEventReceived = true;
        if (!this.cancelled && (this.state === "recording" || this.state === "paused")) void this.stop().then(this.onInterrupted).catch(() => this.setState("error"));
      };
      this.recorder.onerror = () => { void this.stop().then(this.onInterrupted).catch(() => this.setState("error")); };
      stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
        if (!this.cancelled && (this.state === "recording" || this.state === "paused")) void this.stop().then(this.onInterrupted).catch(() => this.setState("error"));
      }));
      this.recorder.start(1000);
      this.startedAt = performance.now();
      this.setState("recording");
    } catch (error) {
      this.release();
      this.setState("error");
      throw error;
    }
  }

  pause(): void {
    if (this.state !== "recording") return;
    this.recorder?.pause();
    this.elapsed = this.durationMs;
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.recorder?.resume();
    this.startedAt = performance.now();
    this.setState("recording");
  }

  stop(): Promise<RecordedVoice> {
    if (this.completion) return this.completion;
    if (!this.recorder) return Promise.reject(new Error("voice.empty"));
    this.elapsed = this.durationMs;
    this.setState("processing");
    this.completion = new Promise((resolve, reject) => {
      const finish = () => {
        this.release();
        const mimeType = this.recorder!.mimeType || this.chunks.find((chunk) => chunk.type)?.type || "";
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        if (!blob.size) { this.setState("error"); reject(new Error("voice.empty")); return; }
        try {
          resolve({ blob, mimeType, extension: voiceRecordingExtension(mimeType), durationMs: Math.round(this.elapsed), size: blob.size });
        } catch (error) { this.setState("error"); reject(error); }
      };
      this.recorder!.onstop = finish;
      // 浏览器自行停止时，仍保留已经收到的 chunks。
      if (this.stopEventReceived) finish();
      else if (this.recorder!.state !== "inactive") this.recorder!.stop();
    });
    return this.completion;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.recorder && this.recorder.state !== "inactive") await this.stop().catch(() => undefined);
    this.release();
    this.chunks = [];
    this.setState("idle");
  }

  private release(): void { this.stream?.getTracks().forEach((track) => track.stop()); }
}

export function recordedVoiceFile(voice: RecordedVoice, createdAt = Date.now()): File {
  return new File([voice.blob], `voice-${createdAt}.${voice.extension}`, { type: voice.mimeType });
}

export function formatVoiceDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
