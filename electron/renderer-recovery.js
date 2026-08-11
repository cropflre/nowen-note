"use strict";

const NON_RECOVERABLE_REASONS = new Set([
  "launch-failed",
  "integrity-failure",
]);

function isRendererExitRecoverable(details = {}) {
  const reason = typeof details.reason === "string" ? details.reason : "";
  return !NON_RECOVERABLE_REASONS.has(reason);
}

function createRendererRecoveryGate(options = {}) {
  const maxAttempts = options.maxAttempts ?? 2;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("windowMs must be a positive number");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  let attempts = [];

  return {
    consume(details = {}) {
      if (!isRendererExitRecoverable(details)) {
        return { recover: false, reason: "non-recoverable", attempt: 0 };
      }

      const timestamp = Number(now());
      attempts = attempts.filter((attemptAt) => timestamp - attemptAt < windowMs);
      if (attempts.length >= maxAttempts) {
        return {
          recover: false,
          reason: "rate-limited",
          attempt: attempts.length,
        };
      }

      attempts.push(timestamp);
      return {
        recover: true,
        reason: "allowed",
        attempt: attempts.length,
      };
    },
    reset() {
      attempts = [];
    },
  };
}

module.exports = {
  createRendererRecoveryGate,
  isRendererExitRecoverable,
};
