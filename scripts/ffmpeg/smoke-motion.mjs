#!/usr/bin/env node
// 用法：node scripts/ffmpeg/smoke-motion.mjs <ffmpeg 可执行文件> [前置命令...]
//   例：node scripts/ffmpeg/smoke-motion.mjs out/ffmpeg-darwin-x64 arch -x86_64
// 用后端转码的原参数转换一张 HEVC 10bit、显示矩阵旋转 90 度、带 AAC 的实况照片样本（64×48），
// 再解析 MP4 结构，确认产物是 H.264 + AAC 且已转正为 48×64。精简版没有 ffprobe，所以自己读盒子。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/live-photo-hevc10-rot90.mov", import.meta.url));

// 必须与 backend/src/services/modern-media.ts 的 convertMotion 一致（scripts/tests/desktop-ffmpeg.test.mjs 校验）。
export function motionArgs(input, output) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe",
    "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-t", "15", "-threads", "2",
    "-vf", "scale=trunc(min(1920\\,iw)/2)*2:-2,format=yuv420p", "-c:v", "libx264",
    "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-fs", "52428800", output,
  ];
}

// 返回各轨道的处理类型（vide/soun）、样本格式（avc1/mp4a）与 tkhd 显示宽高。
export function inspectMp4(bytes) {
  const children = (start, end) => {
    const list = [];
    while (start + 8 <= end) {
      let size = bytes.readUInt32BE(start);
      let header = 8;
      if (size === 1) { size = Number(bytes.readBigUInt64BE(start + 8)); header = 16; }
      else if (size === 0) size = end - start;
      if (size < header || start + size > end) break;
      list.push({ type: bytes.toString("latin1", start + 4, start + 8), body: start + header, end: start + size });
      start += size;
    }
    return list;
  };
  const child = (box, type) => box && children(box.body, box.end).find((item) => item.type === type);
  const top = children(0, bytes.length);
  if (top[0]?.type !== "ftyp") throw new Error("不是 MP4：缺少 ftyp");
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw new Error("MP4 缺少 moov");
  return children(moov.body, moov.end).filter((box) => box.type === "trak").map((trak) => {
    const tkhd = child(trak, "tkhd");
    const offset = tkhd && (bytes[tkhd.body] === 1 ? 88 : 76);
    const stsd = child(child(child(child(trak, "mdia"), "minf"), "stbl"), "stsd");
    const hdlr = child(child(trak, "mdia"), "hdlr");
    return {
      handler: hdlr && bytes.toString("latin1", hdlr.body + 8, hdlr.body + 12),
      format: stsd && bytes.toString("latin1", stsd.body + 12, stsd.body + 16),
      width: tkhd && bytes.readUInt32BE(tkhd.body + offset) / 65536,
      height: tkhd && bytes.readUInt32BE(tkhd.body + offset + 4) / 65536,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [ffmpeg, ...wrapper] = process.argv.slice(2);
  if (!ffmpeg) throw new Error("用法：smoke-motion.mjs <ffmpeg 可执行文件> [前置命令...]");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ffmpeg-smoke-"));
  try {
    const input = path.join(dir, "source.mov");
    const output = path.join(dir, "motion.mp4");
    fs.copyFileSync(fixture, input);
    const [command, ...prefix] = wrapper.length ? [...wrapper, path.resolve(ffmpeg)] : [path.resolve(ffmpeg)];
    const result = spawnSync(command, [...prefix, ...motionArgs(input, output)], { encoding: "utf8", timeout: 120_000, windowsHide: true });
    if (result.status !== 0) throw new Error(`转码失败（${result.status ?? result.error?.message}）：${result.stderr}`);
    const tracks = inspectMp4(fs.readFileSync(output));
    const video = tracks.find((track) => track.handler === "vide");
    const audio = tracks.find((track) => track.handler === "soun");
    if (video?.format !== "avc1" || video.width !== 48 || video.height !== 64 || audio?.format !== "mp4a") {
      throw new Error(`转码产物不符合预期：${JSON.stringify(tracks)}`);
    }
    console.log(`[ffmpeg-smoke] ${path.basename(ffmpeg)}: Live Photo → H.264 ${video.width}×${video.height} + AAC`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
