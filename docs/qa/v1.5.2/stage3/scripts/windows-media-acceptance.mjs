import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const [packageArg, outputArg] = process.argv.slice(2);
const packageRoot = path.resolve(packageArg), output = path.resolve(outputArg);
const require = createRequire(path.join(packageRoot, 'resources/backend/package.json'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-qa152-packaged-media-'));
const ffmpeg = require('ffmpeg-static');
assert.ok(ffmpeg.startsWith(packageRoot + path.sep)); assert.ok(fs.existsSync(ffmpeg));
const report = { node: process.version, abi: process.versions.modules, packageRoot, ffmpeg,
  ffmpegVersion: execFileSync(ffmpeg, ['-version'], { windowsHide: true, encoding: 'utf8' }).split('\n')[0] };
try {
  const sharp = require('sharp');
  const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#2186a5' } }).jpeg().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 64);
  const movie = path.join(directory, 'original.mov'), converted = path.join(directory, 'converted.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx265', '-x265-params', 'pools=1:log-level=error', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', movie], { windowsHide: true });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', movie, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', converted], { windowsHide: true });
  const bytes = fs.readFileSync(converted);
  assert.ok(bytes.includes(Buffer.from('avc1'))); assert.ok(bytes.includes(Buffer.from('mp4a')));
  for (const entry of ['runner-child.mjs', 'sandbox-child.mjs']) assert.ok(fs.existsSync(path.join(packageRoot, 'resources/backend/dist', entry)));
  report.result = 'PASS'; report.sharpJpegBytes = image.length;
  report.transcoded = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), codecs: 'H.264/AAC' };
  report.boundary = 'Actual files copied by desktop builder, run under packaged Electron; media dependencies and transcode. Unsigned unpacked directory; NSIS install/update not accepted.';
} finally {
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: report.result, output }));
