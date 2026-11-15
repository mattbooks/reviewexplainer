import Value from "typebox/value";
import { resolveAnchor } from "./anchors.ts";
import { parsePatch, type PatchModel } from "./patch.ts";
import { coverage, coverageProblems } from "./review.ts";
import { ReviewFile as ReviewFileSchema, type ReviewFile } from "./schema.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * state.viewed keys: a hunk id, a slice ("<hunk id>:<from>-<to>"), or "file:<path>"
 * for files without hunks.
 */
export function viewKeyExists(model: PatchModel, key: string): boolean {
  if (key.startsWith("file:")) return model.byPath.has(key.slice(5));
  return model.hunkById.has(key.split(":")[0]!);
}

/** Check only the JSON shape against the schema. */
export function schemaErrors(value: unknown, limit = 25): string[] {
  if (Value.Check(ReviewFileSchema, value)) return [];
  const out: string[] = [];
  for (const e of Value.Errors(ReviewFileSchema, value)) {
    out.push(`${e.instancePath || "/"}: ${e.message}`);
    if (out.length >= limit) break;
  }
  return out;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * Full validation: schema, files in sync with the patch, unique ids, step
 * dependencies, coverage (every hunk exactly once) and anchor resolution.
 */
export function validateReview(value: unknown): ValidationResult {
  const errors = schemaErrors(value);
  const warnings: string[] = [];
  if (errors.length) return { ok: false, errors, warnings };
  const review = value as ReviewFile;
  let model: PatchModel;
  try {
    model = parsePatch(review.patch);
  } catch (e) {
    return { ok: false, errors: [`Patch could not be parsed: ${(e as Error).message}`], warnings };
  }

  // files[] must mirror the patch.
  const patchIds = model.files.map((f) => `${f.path}:${f.hunks.map((h) => h.id).join(",")}`);
  const fileIds = review.files.map((f) => `${f.path}:${f.hunks.map((h) => h.id).join(",")}`);
  if (patchIds.join("|") !== fileIds.join("|")) {
    errors.push("files[] does not match the patch (paths or hunk ids differ); regenerate it from the patch");
  }

  for (const d of duplicates(review.guide.steps.map((s) => s.id))) errors.push(`Duplicate step id "${d}"`);
  for (const d of duplicates(review.threads.map((t) => t.id))) errors.push(`Duplicate thread id "${d}"`);
  for (const d of duplicates(review.annotations.map((a) => a.id))) errors.push(`Duplicate annotation id "${d}"`);
  for (const t of review.threads) {
    for (const d of duplicates(t.comments.map((c) => c.id))) errors.push(`Duplicate comment id "${d}" in thread ${t.id}`);
  }

  const earlier = new Set<string>();
  for (const step of review.guide.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!earlier.has(dep)) {
        errors.push(`Step "${step.id}" depends on "${dep}", which is not an earlier step`);
      }
    }
    earlier.add(step.id);
  }

  if (review.guide.steps.length > 0 || model.files.length === 0) {
    errors.push(...coverageProblems(coverage(review, model)));
  } else {
    warnings.push("The guide has no steps yet");
  }

  for (const t of review.threads) {
    if (t.status === "outdated") continue;
    const r = resolveAnchor(model, t.anchor, review);
    if (!r.ok) errors.push(`Thread ${t.id}: ${r.reason}`);
  }
  for (const a of review.annotations) {
    if (a.outdated) continue;
    const r = resolveAnchor(model, a.anchor, review);
    if (!r.ok) errors.push(`Annotation ${a.id}: ${r.reason}`);
  }

  for (const key of Object.keys(review.state.viewed)) {
    if (!viewKeyExists(model, key)) warnings.push(`state.viewed has unknown entry ${key}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function assertValid(value: unknown): asserts value is ReviewFile {
  const result = validateReview(value);
  if (!result.ok) {
    throw new Error(`Invalid review file:\n- ${result.errors.join("\n- ")}`);
  }
}
