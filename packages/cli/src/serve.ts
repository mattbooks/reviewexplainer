/**
 * `greview serve`: serves the built viewer and a read/write API for one review
 * file on localhost. Edits arrive as JSON Patch limited to /threads and
 * /state, are validated, and are written atomically.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readReview, serializeReview, writeReview } from "@reviewexplainer/core";
import { applyJsonPatch, parsePointer, sha1Hex, validateReview, type JsonPatchOp, type ReviewFile } from "@reviewexplainer/format";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

const EDITABLE_ROOTS = new Set(["threads", "state"]);

export function defaultViewerDir(): string {
  return process.env.GREVIEW_VIEWER_DIR ?? fileURLToPath(new URL("../../viewer/dist/", import.meta.url));
}

export function etagFor(text: string): string {
  return `"${sha1Hex(text).slice(0, 16)}"`;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8", headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Where reviews come from: one file, or the inbox of everything `greview watch` tracks. */
export interface ReviewSource {
  mode: "local" | "inbox";
  /** The review file for a key (inbox), or the single file. */
  resolve(key: string | null): string | undefined;
  /** Inbox entries for GET /api/reviews. */
  list?(): unknown[];
}

export function singleFile(file: string): ReviewSource {
  return { mode: "local", resolve: () => file };
}

export interface ServeOptions {
  /** Serve one file (same as `source: singleFile(file)`). */
  file?: string;
  source?: ReviewSource;
  port: number;
  host?: string;
  viewerDir?: string;
  reviewer?: string;
}

export function createReviewServer(opts: ServeOptions): Server {
  const source = opts.source ?? (opts.file ? singleFile(opts.file) : undefined);
  if (!source) throw new Error("createReviewServer needs a file or a source");
  const viewerDir = resolve(opts.viewerDir ?? defaultViewerDir());
  const hasViewer = existsSync(join(viewerDir, "index.html"));

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Reject cross-site requests: only same-origin pages may call the API.
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (url.pathname.startsWith("/api/") && origin && host && new URL(origin).host !== host) {
        return send(res, 403, JSON.stringify({ error: "cross-origin request rejected" }));
      }

      if (url.pathname === "/api/info" && req.method === "GET") {
        return send(
          res,
          200,
          JSON.stringify({ mode: source.mode, file: source.mode === "local" ? source.resolve(null) : null, reviewer: opts.reviewer ?? null }),
        );
      }

      if (url.pathname === "/api/reviews" && req.method === "GET") {
        if (!source.list) return send(res, 404, JSON.stringify({ error: "Not an inbox" }));
        return send(res, 200, JSON.stringify(source.list()));
      }

      if (url.pathname === "/api/review") {
        const file = source.resolve(url.searchParams.get("key"));
        if (!file || !existsSync(file)) return send(res, 404, JSON.stringify({ error: "No such review" }));

        if (req.method === "GET") {
          const text = serializeReview(readReview(file));
          const tag = etagFor(text);
          if (req.headers["if-none-match"] === tag) {
            res.writeHead(304, { ETag: tag, "Cache-Control": "no-store" });
            return res.end();
          }
          return send(res, 200, text, undefined, { ETag: tag });
        }

        if (req.method === "PATCH") {
          let ops: JsonPatchOp[];
          try {
            ops = JSON.parse(await readBody(req)) as JsonPatchOp[];
            if (!Array.isArray(ops)) throw new Error("Body must be a JSON Patch array");
            for (const op of ops) {
              const root = parsePointer(op.path)[0];
              if (!root || !EDITABLE_ROOTS.has(root)) throw new Error(`Only /threads and /state can be edited, not ${op.path}`);
            }
          } catch (e) {
            return send(res, 400, JSON.stringify({ error: (e as Error).message }));
          }
          // Read, apply and write with no await in between, so writes from
          // `greview watch` or an agent cannot interleave.
          const current = readReview(file);
          const currentTag = etagFor(serializeReview(current));
          const ifMatch = req.headers["if-match"];
          if (ifMatch && ifMatch !== currentTag) {
            return send(res, 409, JSON.stringify({ error: "The review file changed on disk; reload to get the latest version." }), undefined, {
              ETag: currentTag,
            });
          }
          let next: ReviewFile;
          try {
            next = applyJsonPatch(current, ops);
          } catch (e) {
            return send(res, 409, JSON.stringify({ error: (e as Error).message }));
          }
          const result = validateReview(next);
          if (!result.ok) return send(res, 422, JSON.stringify({ error: "Invalid review after edit", details: result.errors }));
          writeReview(file, next);
          const text = serializeReview(next);
          return send(res, 200, text, undefined, { ETag: etagFor(text) });
        }
      }

      if (url.pathname.startsWith("/api/")) return send(res, 404, JSON.stringify({ error: "Not found" }));
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");

      if (!hasViewer) {
        return send(
          res,
          503,
          `The viewer is not built. Run \`npm run build\` in the repository root, then restart greview serve.\nViewer directory: ${viewerDir}\n`,
          "text/plain; charset=utf-8",
        );
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
      let path = resolve(viewerDir, rel || "index.html");
      if (path !== viewerDir && !path.startsWith(viewerDir + sep)) return send(res, 403, "Forbidden", "text/plain");
      if (!existsSync(path) || statSync(path).isDirectory()) path = join(viewerDir, "index.html");
      const type = MIME[extname(path)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": path.endsWith("index.html") ? "no-store" : "public, max-age=3600" });
      if (req.method === "HEAD") return res.end();
      res.end(readFileSync(path));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: (e as Error).message }));
    }
  });
}

export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolvePort(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
