import { schemaErrors, validateReview, type ReviewFile } from "@reviewexplainer/format";
import { memoryBackend, serverBackend, type Backend } from "./store.ts";

export interface Loaded {
  review: ReviewFile;
  backend: Backend;
  name: string;
  reviewer: string | null;
  warnings: string[];
  /** Opened from the inbox of `greview watch`. */
  inbox?: boolean;
}

export type ServerResult = { kind: "review"; loaded: Loaded } | { kind: "inbox"; reviewer: string | null } | null;

async function textOf(blob: Blob, name: string): Promise<string> {
  if (name.endsWith(".gz") && "DecompressionStream" in globalThis) {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return blob.text();
}

/** Parse and check a review. Shape errors are fatal; rule errors become warnings so the file can still be read. */
export function parseReview(text: string): { review: ReviewFile; warnings: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`This is not JSON: ${(e as Error).message}`);
  }
  const shape = schemaErrors(value, 8);
  if (shape.length) throw new Error(`This is not a review file:\n- ${shape.join("\n- ")}`);
  const result = validateReview(value);
  return { review: value as ReviewFile, warnings: [...result.errors, ...result.warnings] };
}

/** Ask `greview serve` / `greview inbox` what it serves. Null when there is no server. */
export async function fromServer(): Promise<ServerResult> {
  let info: { mode?: string; reviewer?: string | null; file?: string | null };
  try {
    const res = await fetch("api/info", { headers: { Accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    info = (await res.json()) as typeof info;
  } catch {
    return null;
  }
  const reviewer = info.reviewer ?? null;
  const inbox = info.mode === "inbox";
  const key = new URLSearchParams(location.search).get("key");
  if (inbox && !key) return { kind: "inbox", reviewer };
  const url = inbox ? `api/review?key=${encodeURIComponent(key!)}` : "api/review";
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) throw new Error(inbox ? `No review for ${key}. It may have been cleaned up after its PR closed.` : "The server has no review file.");
  if (!res.ok) throw new Error(`Could not load the review: ${res.status}`);
  const { review, warnings } = parseReview(await res.text());
  const name = inbox ? `${key!.replace(/[/#]/g, "-")}.review.json` : (info.file?.split(/[\\/]/).pop() ?? "review.json");
  return { kind: "review", loaded: { review, backend: serverBackend(res.headers.get("ETag"), url), name, reviewer, warnings, inbox } };
}

/**
 * A static deployment can ship a review next to the viewer as review.json
 * (e.g. a CI artifact or a shareable page). Anything else at that path, such
 * as an HTML fallback page, is ignored.
 */
export async function fromBundled(): Promise<Loaded | null> {
  let text: string;
  try {
    const res = await fetch("review.json", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }
  if (!text.trimStart().startsWith("{")) return null;
  const { review, warnings } = parseReview(text);
  return { review, backend: memoryBackend(), name: "review.json", reviewer: null, warnings };
}

export async function fromUrl(url: string): Promise<Loaded> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status} ${res.statusText}`);
  const name = new URL(url, location.href).pathname.split("/").pop() || "review.json";
  const { review, warnings } = parseReview(await textOf(await res.blob(), name));
  return { review, backend: memoryBackend(), name, reviewer: null, warnings };
}

export async function fromFile(file: File, handle?: unknown): Promise<Loaded> {
  const { review, warnings } = parseReview(await textOf(file, file.name));
  const writable = handle && typeof (handle as { createWritable?: unknown }).createWritable === "function" && !file.name.endsWith(".gz");
  return {
    review,
    backend: memoryBackend(writable ? (handle as Parameters<typeof memoryBackend>[0]) : undefined),
    name: file.name,
    reviewer: null,
    warnings,
  };
}
