if (typeof Promise !== "undefined" && typeof Promise.allSettled !== "function") {
  Promise.allSettled = function allSettled<T>(
    values: Iterable<T | PromiseLike<T>>,
  ): Promise<PromiseSettledResult<Awaited<T>>[]> {
    return Promise.all(
      Array.from(values, (value) =>
        Promise.resolve(value).then(
          (result) => ({ status: "fulfilled", value: result }) as PromiseFulfilledResult<Awaited<T>>,
          (reason) => ({ status: "rejected", reason }) as PromiseRejectedResult,
        ),
      ),
    );
  };
}

if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
