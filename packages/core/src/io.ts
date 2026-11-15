import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { validateReview, type ReviewFile } from "@reviewexplainer/format";

export function readReview(path: string): ReviewFile {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text) as ReviewFile;
}

export function serializeReview(review: ReviewFile): string {
  return `${JSON.stringify(review, null, 2)}\n`;
}

/**
 * Validate, then write atomically (temp file + rename). Pass `force` to write
 * an invalid file anyway, e.g. to inspect it.
 */
export function writeReview(path: string, review: ReviewFile, opts: { force?: boolean } = {}): string[] {
  const result = validateReview(review);
  if (!result.ok && !opts.force) {
    throw new Error(`Refusing to write an invalid review file:\n- ${result.errors.join("\n- ")}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const text = serializeReview(review);
  const data = path.endsWith(".gz") ? gzipSync(text) : text;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
  return result.warnings;
}
