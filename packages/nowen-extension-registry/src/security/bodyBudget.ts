import type { Context, Next } from "hono";

export const REQUEST_BODY_LIMITS = Object.freeze({
  json: 256 * 1024,
  publish: 21 * 1024 * 1024,
});

function requestBudget(c: Context): number {
  return c.req.path === "/v2/publish" ? REQUEST_BODY_LIMITS.publish : REQUEST_BODY_LIMITS.json;
}

export function enforceRequestBodyBudget() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const body = c.req.raw.body;
    if (!body) return next();
    if (c.req.method === "GET" || c.req.method === "HEAD") return c.json({ error: "request body is not allowed" }, 400);
    const budget = requestBudget(c);
    const declaredRaw = c.req.header("content-length");
    let declared: number | null = null;
    if (declaredRaw !== undefined) {
      if (!/^\d+$/.test(declaredRaw)) return c.json({ error: "invalid Content-Length" }, 400);
      declared = Number(declaredRaw);
      if (!Number.isSafeInteger(declared)) return c.json({ error: "invalid Content-Length" }, 400);
      if (declared > budget) return c.json({ error: "request body exceeds limit" }, 413);
    }

    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > budget) {
          await reader.cancel("request body exceeds limit").catch(() => undefined);
          return c.json({ error: "request body exceeds limit" }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (declared !== null && declared !== received) return c.json({ error: "Content-Length does not match request body" }, 400);
    const limitedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const requestInit = { body: limitedBody, duplex: "half" } as RequestInit & { duplex: "half" };
    c.req.raw = new Request(c.req.raw, requestInit);
    return next();
  };
}
