export const VOICE_MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];

export function chooseVoiceRecordingMime(recorder: Pick<typeof MediaRecorder, "isTypeSupported">): string | undefined {
  return VOICE_MIME_CANDIDATES.find((mime) => recorder.isTypeSupported(mime));
}

export function voiceRecordingExtension(mime: string): string {
  switch (mime.split(";")[0].toLowerCase()) {
    case "audio/mp4": return "m4a";
    case "audio/ogg": return "ogg";
    case "audio/wav": return "wav";
    case "audio/mpeg": return "mp3";
    case "audio/webm": return "webm";
    default: throw new Error("Unsupported recording format");
  }
}
