"use strict";

const { TextDecoder } = require("node:util");

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF16_SNIFF_BYTES = 4096;

function startsWith(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function decodeStrict(buffer, encoding) {
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

function stripLeadingBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * UTF-16 without BOM is common in files produced by Windows tools. Since those
 * bytes can still be technically valid UTF-8 (because NUL is valid), sniff the
 * alternating NUL-byte pattern before attempting strict UTF-8 decoding.
 */
function detectUtf16WithoutBom(buffer) {
  const sampleLength = Math.min(buffer.length - (buffer.length % 2), UTF16_SNIFF_BYTES);
  if (sampleLength < 4) return null;

  let evenZeroes = 0;
  let oddZeroes = 0;
  const pairs = sampleLength / 2;
  for (let i = 0; i < sampleLength; i += 2) {
    if (buffer[i] === 0) evenZeroes += 1;
    if (buffer[i + 1] === 0) oddZeroes += 1;
  }

  const evenRatio = evenZeroes / pairs;
  const oddRatio = oddZeroes / pairs;
  if (oddRatio >= 0.3 && evenRatio <= 0.05) return "utf-16le";
  if (evenRatio >= 0.3 && oddRatio <= 0.05) return "utf-16be";
  return null;
}

function scanGb18030(buffer) {
  let sequences = 0;
  let fourByteSequences = 0;
  let invalidHighBytes = 0;

  for (let i = 0; i < buffer.length;) {
    const first = buffer[i];
    if (first <= 0x7f) {
      i += 1;
      continue;
    }
    if (first === 0x80) {
      sequences += 1;
      i += 1;
      continue;
    }
    if (first < 0x81 || first > 0xfe || i + 1 >= buffer.length) {
      invalidHighBytes += 1;
      i += 1;
      continue;
    }

    const second = buffer[i + 1];
    if (
      second >= 0x30 && second <= 0x39 &&
      i + 3 < buffer.length &&
      buffer[i + 2] >= 0x81 && buffer[i + 2] <= 0xfe &&
      buffer[i + 3] >= 0x30 && buffer[i + 3] <= 0x39
    ) {
      sequences += 1;
      fourByteSequences += 1;
      i += 4;
      continue;
    }

    if (second >= 0x40 && second <= 0xfe && second !== 0x7f) {
      sequences += 1;
      i += 2;
      continue;
    }

    invalidHighBytes += 1;
    i += 1;
  }

  return { sequences, fourByteSequences, invalidHighBytes };
}

function countCjk(text) {
  let count = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
    ) {
      count += 1;
    }
  }
  return count;
}

function decodeLegacyWindowsText(buffer) {
  let gb18030 = null;
  try {
    gb18030 = decodeStrict(buffer, "gb18030");
  } catch {
    // Not a valid GB18030 byte stream. Fall through to Windows-1252.
  }

  if (gb18030 !== null) {
    const scan = scanGb18030(buffer);
    const cjkCount = countCjk(gb18030);
    if (
      scan.invalidHighBytes === 0 &&
      (scan.fourByteSequences > 0 || scan.sequences >= 2 || cjkCount >= 2)
    ) {
      return { content: stripLeadingBom(gb18030), encoding: "gb18030" };
    }
  }

  return {
    content: stripLeadingBom(new TextDecoder("windows-1252").decode(buffer)),
    encoding: "windows-1252",
  };
}

/**
 * Decode a Markdown/text file without corrupting common Windows encodings.
 *
 * Priority:
 *   1. Explicit UTF BOMs
 *   2. UTF-16 alternating-NUL sniffing
 *   3. Strict UTF-8
 *   4. GB18030 (covers GBK/CP936)
 *   5. Windows-1252 fallback
 */
function decodeTextBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length === 0) {
    return { content: "", encoding: "utf-8", hadBom: false };
  }

  if (startsWith(buffer, UTF8_BOM)) {
    return {
      content: stripLeadingBom(decodeStrict(buffer.subarray(UTF8_BOM.length), "utf-8")),
      encoding: "utf-8",
      hadBom: true,
    };
  }
  if (startsWith(buffer, UTF16LE_BOM)) {
    return {
      content: stripLeadingBom(decodeStrict(buffer.subarray(UTF16LE_BOM.length), "utf-16le")),
      encoding: "utf-16le",
      hadBom: true,
    };
  }
  if (startsWith(buffer, UTF16BE_BOM)) {
    return {
      content: stripLeadingBom(decodeStrict(buffer.subarray(UTF16BE_BOM.length), "utf-16be")),
      encoding: "utf-16be",
      hadBom: true,
    };
  }

  const utf16Encoding = detectUtf16WithoutBom(buffer);
  if (utf16Encoding) {
    try {
      return {
        content: stripLeadingBom(decodeStrict(buffer, utf16Encoding)),
        encoding: utf16Encoding,
        hadBom: false,
      };
    } catch {
      // Continue with UTF-8 and legacy Windows encodings.
    }
  }

  try {
    return {
      content: stripLeadingBom(decodeStrict(buffer, "utf-8")),
      encoding: "utf-8",
      hadBom: false,
    };
  } catch {
    // Invalid UTF-8 is common for Windows ANSI/GBK markdown files.
  }

  return { ...decodeLegacyWindowsText(buffer), hadBom: false };
}

module.exports = {
  decodeTextBuffer,
  detectUtf16WithoutBom,
  scanGb18030,
};
