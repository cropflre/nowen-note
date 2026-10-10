function isPdfRenderReady(state) {
  return !!state
    && Number.isFinite(state.width) && state.width > 0
    && Number.isFinite(state.height) && state.height > 0
    && Number.isFinite(state.titleWidth) && state.titleWidth > 0
    && Number.isFinite(state.titleHeight) && state.titleHeight > 0
    && state.hasContentContainer === true;
}

function isPdfBufferValid(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 256
    && buffer.subarray(0, 5).toString() === '%PDF-';
}

module.exports = { isPdfBufferValid, isPdfRenderReady };
