import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorderSession, recordedVoiceFile } from "../voiceRecorder";
import { chooseVoiceRecordingMime, voiceRecordingExtension } from "../voiceRecordingMime";

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = vi.fn((mime: string) => mime === "audio/webm;codecs=opus");
  state = "inactive";
  mimeType: string;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor(_stream: unknown, options?: { mimeType: string }) { this.mimeType = options?.mimeType || "audio/webm"; Recorder.instances.push(this); }
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }); }
}

describe("voice recording", () => {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    Recorder.instances = [];
    getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", Recorder);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("negotiates supported formats and uses the actual MIME for the extension", () => {
    expect(chooseVoiceRecordingMime(Recorder as unknown as typeof MediaRecorder)).toBe("audio/webm;codecs=opus");
    expect(voiceRecordingExtension("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(chooseVoiceRecordingMime({ isTypeSupported: () => false })).toBeUndefined();
  });
  it("records, pauses, resumes, waits for final data and releases microphone tracks", async () => {
    const states: string[] = [];
    const session = new VoiceRecorderSession((state) => states.push(state));
    await session.start(); session.pause(); session.resume();
    const voice = await session.stop();
    expect(states).toEqual(["requesting-permission", "recording", "paused", "recording", "processing"]);
    expect(voice.blob.size).toBe(5);
    expect(voice.mimeType).toBe("audio/webm;codecs=opus");
    expect(track.stop).toHaveBeenCalled();
    const file = recordedVoiceFile(voice, 123);
    expect(file.name).toBe("voice-123.webm"); expect(file.type).toBe(voice.mimeType); expect(file.size).toBe(5);
    expect(await session.stop()).toBe(voice);
  });
  it("keeps paused time out of the duration", async () => {
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(100); const session = new VoiceRecorderSession(); await session.start();
    clock.mockReturnValue(1100); session.pause();
    clock.mockReturnValue(10000); expect(session.durationMs).toBe(1000); session.resume();
    clock.mockReturnValue(10500); expect((await session.stop()).durationMs).toBe(1500); clock.mockRestore();
  });
  it("reports denied permission without leaving an active stream", async () => {
    getUserMedia.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const session = new VoiceRecorderSession();
    await expect(session.start()).rejects.toMatchObject({ name: "NotAllowedError" }); expect(session.state).toBe("error");
  });
  it("cancels while the permission prompt is pending and releases the late stream", async () => {
    let grant!: (value: unknown) => void;
    getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
    const session = new VoiceRecorderSession(); const start = session.start(); await session.cancel();
    grant({ getTracks: () => [track] }); await start;
    expect(track.stop).toHaveBeenCalledTimes(1); expect(session.state).toBe("idle");
  });
  it("releases tracks on cancellation and preserves chunks when a track ends", async () => {
    const interrupted = vi.fn(); const session = new VoiceRecorderSession(() => {}, interrupted);
    await session.start(); track.addEventListener.mock.calls[0][1]();
    await Promise.resolve(); await Promise.resolve();
    expect(interrupted).toHaveBeenCalledWith(expect.objectContaining({ size: 5 }));
    const second = new VoiceRecorderSession(); await second.start(); await second.cancel(); expect(second.state).toBe("idle");
  });
  it("detects an unavailable recording environment", async () => {
    vi.stubGlobal("navigator", {}); await expect(new VoiceRecorderSession().start()).rejects.toThrow("voice.insecure");
  });
  it("waits for final data after the browser marks an errored recorder inactive", async () => {
    const interrupted = vi.fn(); const session = new VoiceRecorderSession(() => {}, interrupted); await session.start();
    const recorder = Recorder.instances[0];
    recorder.state = "inactive"; recorder.onerror?.();
    recorder.ondataavailable?.({ data: new Blob(["final audio"]) }); recorder.onstop?.();
    await Promise.resolve(); await Promise.resolve();
    expect(interrupted).toHaveBeenCalledWith(expect.objectContaining({ size: 11 })); expect(track.stop).toHaveBeenCalled();
  });
});
