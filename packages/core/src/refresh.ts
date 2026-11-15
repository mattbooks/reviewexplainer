/**
 * Re-diff after the head moves: keep the guide for hunks that still exist,
 * collect new hunks in "Remaining changes", and re-place line anchors by
 * fingerprint. Anything that cannot be placed is marked outdated, never moved
 * to a wrong line.
 */
import {
  anchoredText,
  ensureRemainingStep,
  fileEntries,
  fingerprintLines,
  knownLines,
  makeLinesAnchor,
  parsePatch,
  relocateRange,
  type Anchor,
  type PatchModel,
  type ReviewFile,
  type Side,
  type Step,
  type Subject,
  viewKeyExists,
} from "@reviewexplainer/format";

export interface RefreshReport {
  keptHunks: number;
  newHunks: string[];
  droppedSteps: string[];
  relocated: string[];
  outdated: string[];
}

export type FileLinesGetter = (path: string, side: Side) => Promise<string[] | undefined>;

async function reanchor(
  anchor: Anchor,
  model: PatchModel,
  review: Pick<ReviewFile, "blobs">,
  headSha: string,
  fileLines?: FileLinesGetter,
): Promise<{ anchor: Anchor; outdated: boolean; moved: boolean }> {
  switch (anchor.kind) {
    case "review":
      return { anchor, outdated: false, moved: false };
    case "file":
      return { anchor, outdated: !model.byPath.has(anchor.path), moved: false };
    case "hunk": {
      const ok = model.hunkById.get(anchor.hunk)?.file.path === anchor.path;
      return { anchor, outdated: !ok, moved: false };
    }
    case "lines": {
      const length = anchor.end - anchor.start + 1;
      const same = anchoredText(model, anchor.path, anchor.side, anchor.start, anchor.end, review);
      if (same && fingerprintLines(same) === anchor.fingerprint) {
        const placed = makeLinesAnchor(
          model,
          { path: anchor.path, side: anchor.side, start: anchor.start, end: anchor.end, commit: headSha },
          review,
        );
        return { anchor: placed, outdated: false, moved: false };
      }
      const file = model.byPath.get(anchor.path);
      if (!file) return { anchor, outdated: true, moved: false };
      const full = await fileLines?.(anchor.path, anchor.side);
      const known = knownLines(file, anchor.side);
      const lineAt = (n: number) => known.get(n) ?? full?.[n - 1];
      const max = Math.max(full?.length ?? 0, ...known.keys());
      const at = relocateRange(anchor.fingerprint, length, anchor.start, lineAt, max);
      if (at === undefined) return { anchor, outdated: true, moved: false };
      try {
        const placed = makeLinesAnchor(
          model,
          { path: anchor.path, side: anchor.side, start: at, end: at + length - 1, commit: headSha },
          review,
        );
        return { anchor: placed, outdated: false, moved: true };
      } catch {
        // The text still exists but is no longer part of the diff.
        return { anchor, outdated: true, moved: false };
      }
    }
  }
}

export async function refreshReview(
  old: ReviewFile,
  opts: { patch: string; subject: Subject; fileLines?: FileLinesGetter; roles?: Record<string, ReviewFile["files"][number]["role"]> },
): Promise<{ review: ReviewFile; report: RefreshReport }> {
  const model = parsePatch(opts.patch);
  const oldRoles = new Map(old.files.map((f) => [f.path, f.role]));
  const files = fileEntries(model).map((f) => {
    const role = oldRoles.get(f.path) ?? opts.roles?.[f.path];
    return role ? { ...f, role } : f;
  });
  const oldIds = new Set(old.files.flatMap((f) => f.hunks.map((h) => h.id)));
  const newIds = files.flatMap((f) => f.hunks.map((h) => h.id)).filter((id) => !oldIds.has(id));
  const report: RefreshReport = { keptHunks: 0, newHunks: newIds, droppedSteps: [], relocated: [], outdated: [] };

  const steps: Step[] = [];
  for (const step of old.guide.steps) {
    const items = step.items.flatMap((item) => {
      const file = model.byPath.get(item.path);
      if (!file) return [];
      const ids = new Set(file.hunks.map((h) => h.id));
      const hunks = item.hunks === "all" ? "all" : item.hunks.filter((id) => ids.has(id));
      const slices = (item.slices ?? []).filter((s) => {
        const h = file.hunks.find((x) => x.id === s.hunk);
        return h && s.rows[1] < h.rows.length;
      });
      if (hunks === "all") {
        // "all" would silently absorb new hunks; pin it to the hunks that existed before.
        const kept = file.hunks.filter((h) => oldIds.has(h.id)).map((h) => h.id);
        if (kept.length === 0 && file.hunks.length > 0 && slices.length === 0) return [];
        report.keptHunks += kept.length;
        return [{ ...item, hunks: kept.length === file.hunks.length ? ("all" as const) : kept, ...(slices.length ? { slices } : {}) }];
      }
      report.keptHunks += hunks.length;
      if (hunks.length === 0 && slices.length === 0 && file.hunks.length > 0) return [];
      const next = { ...item, hunks };
      if (slices.length) next.slices = slices;
      else delete next.slices;
      return [next];
    });
    if (items.length === 0 && step.items.length > 0) {
      report.droppedSteps.push(step.id);
      continue;
    }
    steps.push({ ...step, items });
  }
  const kept = new Set(steps.map((s) => s.id));
  for (const s of steps) if (s.dependsOn) s.dependsOn = s.dependsOn.filter((d) => kept.has(d));

  const base: ReviewFile = {
    ...old,
    subject: opts.subject,
    patch: opts.patch,
    files,
    guide: { ...old.guide, steps },
    blobs: undefined,
  };
  if (!old.blobs) delete base.blobs;

  const threads = [];
  for (const t of old.threads) {
    const r = await reanchor(t.anchor, model, base, opts.subject.head.sha, opts.fileLines);
    if (r.moved) report.relocated.push(t.id);
    if (r.outdated && t.status !== "outdated") report.outdated.push(t.id);
    const status = r.outdated ? "outdated" : t.status === "outdated" ? "open" : t.status;
    threads.push({ ...t, anchor: r.anchor, status } as typeof t);
  }
  const annotations = [];
  for (const a of old.annotations) {
    const r = await reanchor(a.anchor, model, base, opts.subject.head.sha, opts.fileLines);
    if (r.moved) report.relocated.push(a.id);
    if (r.outdated && !a.outdated) report.outdated.push(a.id);
    const next = { ...a, anchor: r.anchor };
    if (r.outdated) next.outdated = true;
    else delete next.outdated;
    annotations.push(next);
  }

  const viewed = Object.fromEntries(Object.entries(old.state.viewed).filter(([key]) => viewKeyExists(model, key)));
  const review = ensureRemainingStep(
    {
      ...base,
      threads,
      annotations,
      state: { ...old.state, viewed, newSinceRefresh: newIds },
    },
    model,
  );
  return { review, report };
}
