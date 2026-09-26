const test = require('node:test');
const assert = require('node:assert/strict');
const { isPdfBufferValid, isPdfRenderReady } = require('../pdfExportGuard');

const ready = {
  width: 900,
  height: 1100,
  titleWidth: 500,
  titleHeight: 36,
  hasContentContainer: true,
};

test('rejects an empty or missing printable DOM before writing a PDF', () => {
  assert.equal(isPdfRenderReady(ready), true);
  assert.equal(isPdfRenderReady(null), false);
  assert.equal(isPdfRenderReady({ ...ready, height: 0 }), false);
  assert.equal(isPdfRenderReady({ ...ready, titleWidth: 0 }), false);
  assert.equal(isPdfRenderReady({ ...ready, hasContentContainer: false }), false);
});

test('rejects empty, truncated, and non-PDF buffers before writing a file', () => {
  assert.equal(isPdfBufferValid(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(300)])), true);
  assert.equal(isPdfBufferValid(Buffer.alloc(0)), false);
  assert.equal(isPdfBufferValid(Buffer.from('%PDF-')), false);
  assert.equal(isPdfBufferValid(Buffer.alloc(300)), false);
});
