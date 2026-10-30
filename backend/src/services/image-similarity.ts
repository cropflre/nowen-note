/** Derived, request-local visual features. Originals, metadata and sync state are untouched. */
export const SIMILAR_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
];
export const SIMILAR_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export async function imageFeatures(bytes: Buffer) {
  // Load only when explicitly requested; missing native decoder must not prevent startup.
  const { default: sharp } = await import("sharp");
  const pixels = await sharp(bytes, {
    animated: false,
    limitInputPixels: 40_000_000,
  })
    .timeout({ seconds: 3 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(9, 8, { fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  const gray = (index: number) =>
    pixels[index * 3] * 0.299 +
    pixels[index * 3 + 1] * 0.587 +
    pixels[index * 3 + 2] * 0.114;
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits.push(gray(y * 9 + x) > gray(y * 9 + x + 1));
  const color = [0, 1, 2].map((channel) => {
    let sum = 0;
    for (let index = channel; index < pixels.length; index += 3)
      sum += pixels[index];
    return sum / 72;
  });
  return { bits, color };
}
export function imageDistance(
  left: Awaited<ReturnType<typeof imageFeatures>>,
  right: Awaited<ReturnType<typeof imageFeatures>>,
) {
  const distance = left.bits.reduce(
    (count, bit, index) => count + Number(bit !== right.bits[index]),
    0,
  );
  const colorDistance =
    left.color.reduce(
      (sum, channel, index) => sum + Math.abs(channel - right.color[index]),
      0,
    ) / 3;
  // Color guards against every flat image sharing the same difference hash.
  return distance <= 10 && colorDistance <= 35 ? distance : null;
}
