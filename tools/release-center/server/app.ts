import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { Engine } from "./engine.ts";
import { AppError, redact } from "./errors.ts";
import type { Cloud } from "./cloud.ts";
import { Channels } from "./channels.ts";

async function body(req: IncomingMessage): Promise<any> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new AppError(415, "需要 JSON 请求");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_000) throw new AppError(413, "请求过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "JSON 格式错误");
  }
}

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;
export function createApp(
  engine: Engine,
  options: { dist: string; dev?: Middleware; channels?: Channels; cloud?: Cloud },
) {
  const channels = options.channels || new Channels(engine.store, engine.planner.github);
  const session = randomBytes(32).toString("hex");
  let cached:
    | { expires: number; promise: ReturnType<typeof engine.planner.overview> }
    | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const address = server.address();
      const host = `127.0.0.1:${typeof address === "object" && address ? address.port : 4318}`;
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new AppError(403, "仅允许本机同源访问；请使用 127.0.0.1");
      const url = new URL(req.url || "/", `http://${host}`);
      const path = url.pathname;
      if (path === "/api/session" && req.method === "GET") {
        res.setHeader(
          "Set-Cookie",
          `rc_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
        );
        json({ phase: "2b/3", formalPublishing: engine.publication.view().publishEnabled, formalDistribution: false });
        return;
      }
      if (path.startsWith("/api/")) {
        const cookie =
          (req.headers.cookie || "")
            .split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith("rc_session="))
            ?.slice(11) || "";
        if (
          cookie.length !== session.length ||
          !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))
        )
          throw new AppError(401, "请刷新页面以建立本机会话");
        if (req.method !== "GET" && req.headers["x-release-center"] !== "1")
          throw new AppError(403, "缺少同源操作标识");
        if (path.startsWith("/api/cloud") && options.cloud) {
          const cloud = options.cloud;
          if (path === "/api/cloud" && req.method === "GET") { await cloud.refresh(); json(cloud.view()); return; }
          if (path === "/api/cloud/plans" && req.method === "POST") { json(await cloud.plan(await body(req)), 201); return; }
          if (path === "/api/cloud/build" && req.method === "POST") { json(await cloud.build(await body(req)), 202); return; }
          if (path === "/api/cloud/publish" && req.method === "POST") { json(await cloud.publish(await body(req)), 202); return; }
          const remote = path.match(/^\/api\/cloud\/([a-f0-9-]{36})\/(cancel|logs)$/);
          if (remote && req.method === "POST") {
            const value = cloud.get(remote[1]);
            if (!value.runId) throw new AppError(409, "远端结果待核实；请先在 GitHub 查看，禁止重新派发");
            if (remote[2] === "cancel") {
              await cloud.github.cancel(value.runId);
              engine.store.audit(value.id, "cloud.cancel", "已请求远端取消；已完成的渠道操作不会自动撤销");
              json({ requested: true });
            } else {
              const input = await body(req);
              if (!value.jobs.some(job => job.id === input.jobId)) throw new AppError(400, "Job 不属于本次任务");
              json({ log: redact(await cloud.github.jobLog(input.jobId), [cloud.github.token]) });
            }
            return;
          }
        }
        if (path === "/api/publication" && req.method === "GET") {
          json(engine.publication.view());
          return;
        }
        if (path === "/api/publication/import" && req.method === "POST") {
          json(await engine.publication.importRun(await body(req)), 202);
          void engine.tick();
          return;
        }
        const publication = path.match(/^\/api\/publication\/([a-f0-9-]{36})\/(draft|approve|publish)$/);
        if (publication && req.method === "POST") {
          const input = await body(req);
          if (publication[2] === "approve") json(await engine.publication.approve(publication[1], input));
          else {
            json(await engine.publication.submit(publication[1], publication[2] as "draft" | "publish", input), 202);
            void engine.tick();
          }
          return;
        }
        if (path === "/api/channels" && req.method === "GET") {
          json(channels.view(url.searchParams.get("version")));
          return;
        }
        if (path === "/api/channels/refresh" && req.method === "POST") {
          json(await channels.refresh(await body(req)));
          return;
        }
        if (path === "/api/distribution/plans" && req.method === "POST") {
          json(await channels.createPlan(await body(req)), 201);
          return;
        }
        if (path === "/api/distribution/receipts" && req.method === "POST") {
          json(channels.record(await body(req)), 201);
          return;
        }
        if (path === "/api/overview" && req.method === "GET") {
          if (!cached || cached.expires < Date.now())
            cached = {
              expires: Date.now() + 60_000,
              promise: engine.planner.overview(),
            };
          json({ ...(await cached.promise), tasks: engine.store.tasks() });
          return;
        }
        if (path === "/api/plans" && req.method === "POST") {
          const plan = await engine.planner.create(await body(req));
          engine.store.savePlan(plan);
          json(plan, 201);
          return;
        }
        if (path === "/api/tasks" && req.method === "POST") {
          const task = engine.submit(await body(req));
          json(task, 202);
          void engine.tick();
          return;
        }
        if (path === "/api/tasks" && req.method === "GET") {
          json(engine.store.tasks());
          return;
        }
        if (path === "/api/audit" && req.method === "GET") {
          json(
            engine.store.audits(url.searchParams.get("taskId") || undefined),
          );
          return;
        }
        const cancel = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/cancel$/);
        const verification = path.match(
          /^\/api\/tasks\/([a-f0-9-]{36})\/verify$/,
        );
        if (verification && req.method === "POST") {
          const task = engine.submitVerification(
            verification[1],
            await body(req),
          );
          json(task, 202);
          void engine.tick();
          return;
        }
        const acceptance = path.match(
          /^\/api\/tasks\/([a-f0-9-]{36})\/accept$/,
        );
        if (acceptance && req.method === "POST") {
          json(engine.accept(acceptance[1], await body(req)));
          return;
        }
        if (cancel && req.method === "POST") {
          await body(req);
          json(engine.cancel(cancel[1]));
          void engine.tick();
          return;
        }
        const log = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/logs\/(\d+)$/);
        if (log && req.method === "POST") {
          await body(req);
          await engine.captureLog(log[1], Number(log[2]));
          json({ captured: true });
          return;
        }
        if (path === "/api/events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          let last = -1;
          const send = () => {
            if (res.writableLength > 2_000_000) {
              res.end();
              return;
            }
            const seq = Number(
              engine.store.db
                .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM audit")
                .get()!.seq,
            );
            if (seq !== last) {
              res.write(
                `id: ${seq}\ndata: ${JSON.stringify({ tasks: engine.store.tasks(), audit: engine.store.since(last) })}\n\n`,
              );
              last = seq;
            } else res.write(": heartbeat\n\n");
          };
          send();
          const timer = setInterval(send, 2000);
          req.on("close", () => clearInterval(timer));
          return;
        }
        throw new AppError(404, "不提供该接口；正式发布不可用");
      }
      if (req.method !== "GET") throw new AppError(405, "不支持该方法");
      if (options.dev) {
        options.dev(req, res, () => {
          res.writeHead(404);
          res.end();
        });
        return;
      }
      const filename =
        path === "/"
          ? "index.html"
          : decodeURIComponent(path).replace(/^\//, "");
      const target = resolve(options.dist, filename);
      if (
        !target.startsWith(resolve(options.dist) + "/") ||
        ![".html", ".js", ".css", ".svg", ".ico", ".woff2"].includes(
          extname(target),
        )
      )
        throw new AppError(404, "文件不存在");
      let data: Buffer;
      try {
        data = await readFile(target);
      } catch {
        throw new AppError(404, "请先运行 npm run build");
      }
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, {
        "Content-Type": `${mime[extname(target)]}; charset=utf-8`,
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      res.end(data);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      if (error instanceof AppError && error.retryAfter)
        res.setHeader("Retry-After", error.retryAfter);
      json(
        {
          error: redact(error instanceof Error ? error.message : "服务错误", [
            engine.planner.github.token,
            engine.publication.writer.token,
          ]),
        },
        status >= 400 && status < 600 ? status : 500,
      );
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
