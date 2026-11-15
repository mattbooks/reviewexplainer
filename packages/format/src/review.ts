import { fileEntries, parsePatch, type PatchModel } from "./patch.ts";
import { FORMAT_VERSION, type Annotation, type ReviewFile, type Step, type StepItem, type Subject, type Thread } from "./schema.ts";

export const SCHEMA_URL = "https://raw.githubusercontent.com/mattbooks/reviewexplainer/main/schema/review.schema.json";
export const REMAINING_STEP_ID = "remaining";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${raw.replace(/-/g, "").slice(0, 12)}`;
}

export function createReview(opts: {
  subject: Subject;
  patch: string;
  tool: string;
  version: string;
  roles?: Record<string, ReviewFile["files"][number]["role"]>;
}): ReviewFile {
  const model = parsePatch(opts.patch);
  const files = fileEntries(model).map((f) => {
    const role = opts.roles?.[f.path];
    return role ? { ...f, role } : f;
  });
  return {
    $schema: SCHEMA_URL,
    version: FORMAT_VERSION,
    generators: [{ tool: opts.tool, version: opts.version, at: nowIso() }],
    subject: opts.subject,
    patch: opts.patch,
    files,
    guide: { overview: "", generatedBy: "manual", steps: [] },
    annotations: [],
    threads: [],
    state: { viewed: {} },
  };
}

export interface RowGap {
  path: string;
  hunk: string;
  rows: [number, number];
}

export interface CoverageReport {
  /** Whole hunks nobody covers. */
  uncoveredHunks: { path: string; hunk: string }[];
  /** Parts of sliced hunks nobody covers. */
  uncoveredRows: RowGap[];
  /** Files with no hunks (binary, pure rename) that no step lists. */
  uncoveredFiles: string[];
  /** Hunks covered more than once, or covered whole and as slices, or with overlapping slices. */
  duplicated: { path: string; hunk: string; steps: string[] }[];
  /** Step items that point at files or hunks the patch does not have. */
  unknown: { step: string; path: string; hunk?: string }[];
  /** Slices whose row range is invalid for their hunk. */
  badSlices: { step: string; path: string; hunk: string; rows: [number, number] }[];
}

export function coverage(review: Pick<ReviewFile, "guide">, model: PatchModel): CoverageReport {
  const report: CoverageReport = {
    uncoveredHunks: [],
    uncoveredRows: [],
    uncoveredFiles: [],
    duplicated: [],
    unknown: [],
    badSlices: [],
  };
  const whole = new Map<string, string[]>();
  const slices = new Map<string, { step: string; rows: [number, number] }[]>();
  const filesListed = new Set<string>();

  for (const step of review.guide.steps) {
    for (const item of step.items) {
      const file = model.byPath.get(item.path);
      if (!file) {
        report.unknown.push({ step: step.id, path: item.path });
        continue;
      }
      filesListed.add(item.path);
      const ids = item.hunks === "all" ? file.hunks.map((h) => h.id) : item.hunks;
      for (const id of ids) {
        if (!file.hunks.some((h) => h.id === id)) {
          report.unknown.push({ step: step.id, path: item.path, hunk: id });
          continue;
        }
        whole.set(id, [...(whole.get(id) ?? []), step.id]);
      }
      for (const s of item.slices ?? []) {
        const h = file.hunks.find((x) => x.id === s.hunk);
        if (!h) {
          report.unknown.push({ step: step.id, path: item.path, hunk: s.hunk });
          continue;
        }
        if (s.rows[0] > s.rows[1] || s.rows[1] >= h.rows.length) {
          report.badSlices.push({ step: step.id, path: item.path, hunk: s.hunk, rows: s.rows });
          continue;
        }
        slices.set(s.hunk, [...(slices.get(s.hunk) ?? []), { step: step.id, rows: s.rows }]);
      }
    }
  }

  for (const file of model.files) {
    if (file.hunks.length === 0 && !filesListed.has(file.path)) report.uncoveredFiles.push(file.path);
    for (const h of file.hunks) {
      const w = whole.get(h.id) ?? [];
      const sl = slices.get(h.id) ?? [];
      if (w.length + (sl.length ? 1 : 0) > 1 || (w.length === 0 && hasOverlap(sl.map((s) => s.rows)))) {
        report.duplicated.push({
          path: file.path,
          hunk: h.id,
          steps: [...new Set([...w, ...sl.map((s) => s.step)])],
        });
        continue;
      }
      if (w.length === 1) continue;
      if (sl.length === 0) {
        report.uncoveredHunks.push({ path: file.path, hunk: h.id });
        continue;
      }
      for (const gap of rowGaps(sl.map((s) => s.rows), h.rows.length)) {
        report.uncoveredRows.push({ path: file.path, hunk: h.id, rows: gap });
      }
    }
  }
  return report;
}

function hasOverlap(ranges: [number, number][]): boolean {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]![0] <= sorted[i - 1]![1]) return true;
  return false;
}

function rowGaps(ranges: [number, number][], total: number): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let next = 0;
  for (const [a, b] of sorted) {
    if (a > next) gaps.push([next, a - 1]);
    next = Math.max(next, b + 1);
  }
  if (next < total) gaps.push([next, total - 1]);
  return gaps;
}

export function coverageProblems(report: CoverageReport): string[] {
  const out: string[] = [];
  for (const u of report.unknown) {
    out.push(`Step "${u.step}" refers to ${u.hunk ? `hunk ${u.hunk} in ` : ""}${u.path}, which is not in the patch`);
  }
  for (const b of report.badSlices) {
    out.push(`Step "${b.step}" slices rows ${b.rows[0]}-${b.rows[1]} of hunk ${b.hunk} in ${b.path}, outside the hunk`);
  }
  for (const d of report.duplicated) {
    out.push(`Hunk ${d.hunk} in ${d.path} is covered more than once (steps: ${d.steps.join(", ")})`);
  }
  for (const u of report.uncoveredHunks) out.push(`Hunk ${u.hunk} in ${u.path} is not in any step`);
  for (const u of report.uncoveredRows) {
    out.push(`Rows ${u.rows[0]}-${u.rows[1]} of hunk ${u.hunk} in ${u.path} are not in any step`);
  }
  for (const f of report.uncoveredFiles) out.push(`File ${f} is not in any step`);
  return out;
}

/**
 * Put every uncovered hunk, row range and file into a final "Remaining changes"
 * step so the guide can never hide part of the change. Removes the step when
 * nothing is left over.
 */
export function ensureRemainingStep(review: ReviewFile, model: PatchModel = parsePatch(review.patch)): ReviewFile {
  const steps = review.guide.steps.filter((s) => s.id !== REMAINING_STEP_ID);
  const report = coverage({ guide: { ...review.guide, steps } }, model);
  const items = new Map<string, StepItem>();
  const itemFor = (path: string) => {
    let item = items.get(path);
    if (!item) {
      item = { path, hunks: [] };
      items.set(path, item);
    }
    return item;
  };
  for (const u of report.uncoveredHunks) (itemFor(u.path).hunks as string[]).push(u.hunk);
  for (const u of report.uncoveredRows) {
    const item = itemFor(u.path);
    item.slices = [...(item.slices ?? []), { hunk: u.hunk, rows: u.rows }];
  }
  for (const f of report.uncoveredFiles) itemFor(f);
  if (items.size > 0) {
    const order = new Map(model.files.map((f, i) => [f.path, i]));
    const sorted = [...items.values()].sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
    steps.push({
      id: REMAINING_STEP_ID,
      title: "Remaining changes",
      kind: "remaining",
      narrative: "Changes no earlier step covered. They are listed here so nothing in the diff is hidden.",
      items: sorted,
    });
  }
  return { ...review, guide: { ...review.guide, steps } };
}

/** Map of hunk id to the ids of the steps that show it (whole or sliced). */
export function stepsByHunk(steps: Step[], model: PatchModel): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const step of steps) {
    for (const item of step.items) {
      const file = model.byPath.get(item.path);
      if (!file) continue;
      const ids = item.hunks === "all" ? file.hunks.map((h) => h.id) : item.hunks;
      for (const id of [...ids, ...(item.slices ?? []).map((s) => s.hunk)]) {
        const list = map.get(id) ?? [];
        if (!list.includes(step.id)) list.push(step.id);
        map.set(id, list);
      }
    }
  }
  return map;
}

/** Insert or merge a thread by id. Comments merge by id; later fields win. */
export function upsertThread(threads: Thread[], incoming: Thread): Thread[] {
  const index = threads.findIndex((t) => t.id === incoming.id);
  if (index === -1) return [...threads, incoming];
  const existing = threads[index]!;
  const byId = new Map(existing.comments.map((c) => [c.id, c]));
  for (const c of incoming.comments) byId.set(c.id, { ...byId.get(c.id), ...c });
  const merged: Thread = { ...existing, ...incoming, comments: [...byId.values()] };
  return threads.map((t, i) => (i === index ? merged : t));
}

export function upsertAnnotation(annotations: Annotation[], incoming: Annotation): Annotation[] {
  const index = annotations.findIndex((a) => a.id === incoming.id);
  if (index === -1) return [...annotations, incoming];
  return annotations.map((a, i) => (i === index ? { ...a, ...incoming } : a));
}

export function recordGenerator(review: ReviewFile, tool: string, version: string, model?: string): ReviewFile {
  const entry = model ? { tool, version, at: nowIso(), model } : { tool, version, at: nowIso() };
  return { ...review, generators: [...review.generators, entry] };
}
