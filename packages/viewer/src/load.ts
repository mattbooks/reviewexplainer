import { schemaErrors, validateReview, type ReviewFile } from "@reviewexplainer/format";
import { memoryBackend, serverBackend, type Backend } from "./store.ts";

export interface Loaded {
  review: ReviewFile;
  backend: Backend;
  name: string;
  reviewer: string | null;
  warnings: string[];
}

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

export async function fromServer(): Promise<Loaded | null> {
  let res: Response;
  try {
    res = await fetch("api/review", { headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  const { review, warnings } = parseReview(await res.text());
  let reviewer: string | null = null;
  let name = "review";
  try {
    const info = (await (await fetch("api/info")).json()) as { reviewer?: string | null; file?: string };
    reviewer = info.reviewer ?? null;
    name = info.file?.split(/[\\/]/).pop() ?? name;
  } catch {
    // info is optional
  }
  return { review, backend: serverBackend(res.headers.get("ETag")), name, reviewer, warnings };
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
