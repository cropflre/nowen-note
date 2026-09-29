import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";

// 解码器执行同步 CPU 运算，放到工作线程；内联脚本同时兼容 tsx、tsc 和单文件打包。
const DECODER_SCRIPT = `
const { parentPort, workerData } = require("worker_threads");
(async () => {
  const libheif = await require(workerData.decoderPath);
  const images = new libheif.HeifDecoder().decode(new Uint8Array(workerData.input));
  try {
    const image = images.find((item) => item.is_primary()) || images[0];
    if (!image) throw new Error("HEIF 文件没有可解码的图片");
    const width = image.get_width();
    const height = image.get_height();
    if (width <= 0 || height <= 0 || width * height > 64000000) {
      throw new Error("HEIF 图片尺寸超过解码上限");
    }
    const data = new Uint8ClampedArray(width * height * 4);
    await new Promise((resolve, reject) => image.display({ data, width, height }, (result) => {
      if (!result) reject(new Error("HEIF 解码失败"));
      else resolve(result);
    }));
    parentPort.postMessage({ data, width, height }, [data.buffer]);
  } finally {
    for (const image of images) image.free();
  }
})().catch((error) => { throw error; });
`;

interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function decodeHeif(input: Buffer): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(DECODER_SCRIPT, {
      eval: true,
      workerData: { input, decoderPath: require.resolve("libheif-js/wasm-bundle") },
      execArgv: [],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("HEIF 解码超时"));
    }, 60_000);
    worker.once("message", (result: DecodedImage) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HEIF 解码线程退出: ${code}`));
    });
  });
}

// 合并同一附件的并发请求，并串行解码，避免多张大照片同时占满内存。
const pending = new Map<string, Promise<Buffer>>();
let queue: Promise<void> = Promise.resolve();

/** 原件保持不变，兼容副本复用缩略图缓存目录和删除生命周期。 */
export async function getOrCreateHeifPreview(
  attachmentsDir: string,
  attachmentId: string,
  readSource: () => Promise<Buffer | null>,
): Promise<Buffer> {
  const cachePath = path.join(attachmentsDir, ".thumbs", `${attachmentId}_preview.webp`);
  try {
    return fs.readFileSync(cachePath);
  } catch {
    // 缓存未生成或读取失败时重新生成。
  }
  const existing = pending.get(cachePath);
  if (existing) return existing;
  const job = queue.then(async () => {
    const input = await readSource();
    if (!input) throw new Error("HEIF 原文件不存在");
    const sharp = (await import("sharp")).default;
    const image = await decodeHeif(input);
    const buffer = await sharp(Buffer.from(image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    }).webp({ quality: 90 }).toBuffer();
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, buffer);
    } catch (error) {
      console.warn("[heif-preview] 写缓存失败:", error);
    }
    return buffer;
  });
  queue = job.then(() => {}, () => {});
  pending.set(cachePath, job);
  try {
    return await job;
  } finally {
    pending.delete(cachePath);
  }
}
