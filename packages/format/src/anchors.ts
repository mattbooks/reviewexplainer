/**
 * Anchors tie notes and threads to code. Line anchors carry a fingerprint of
 * the anchored text so they can be re-placed after the head moves.
 */
import { sha1Hex } from "./sha1.ts";
import { knownLines, type ParsedFile, type ParsedHunk, type PatchModel } from "./patch.ts";
import type { Anchor, LinesAnchor, ReviewFile, Side } from "./schema.ts";

export function fingerprintLines(lines: readonly string[]): string {
  return sha1Hex(lines.map((l) => l.trimEnd()).join("\n")).slice(0, 12);
}

/** The hunk whose range on `side` contains `line`, if any. */
export function hunkForLine(file: ParsedFile, side: Side, line: number): ParsedHunk | undefined {
  return file.hunks.find((h) =>
    h.rows.some((r) => (side === "old" ? r.oldLine : r.newLine) === line),
  );
}

export type AnchorResolution =
  | { ok: true; hunk?: ParsedHunk; file?: ParsedFile }
  | { ok: false; reason: string };

function blobLines(review: Pick<ReviewFile, "blobs"> | undefined, path: string, side: Side) {
  const blob = review?.blobs?.[path];
  const text = side === "old" ? blob?.old : blob?.new;
  return text === undefined ? undefined : text.split("\n");
}

/** Text of lines [start, end] on a side, from the patch or (if present) full blobs. */
export function anchoredText(
  model: PatchModel,
  path: string,
  side: Side,
  start: number,
  end: number,
  review?: Pick<ReviewFile, "blobs">,
): string[] | undefined {
  const file = model.byPath.get(path);
  if (!file) return undefined;
  const full = blobLines(review, path, side);
  const known = knownLines(file, side);
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = known.get(n) ?? full?.[n - 1];
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

export function resolveAnchor(
  model: PatchModel,
  anchor: Anchor,
  review?: Pick<ReviewFile, "blobs">,
): AnchorResolution {
  switch (anchor.kind) {
    case "review":
      return { ok: true };
    case "file": {
      const file = model.byPath.get(anchor.path);
      return file ? { ok: true, file } : { ok: false, reason: `Unknown file ${anchor.path}` };
    }
    case "hunk": {
      const entry = model.hunkById.get(anchor.hunk);
      if (!entry || entry.file.path !== anchor.path) {
        return { ok: false, reason: `Unknown hunk ${anchor.hunk} in ${anchor.path}` };
      }
      return { ok: true, file: entry.file, hunk: entry.hunk };
    }
    case "lines": {
      const file = model.byPath.get(anchor.path);
      if (!file) return { ok: false, reason: `Unknown file ${anchor.path}` };
      if (anchor.end < anchor.start) return { ok: false, reason: "Anchor end is before start" };
      const text = anchoredText(model, anchor.path, anchor.side, anchor.start, anchor.end, review);
      if (!text) {
        return {
          ok: false,
          reason: `Lines ${anchor.start}-${anchor.end} (${anchor.side}) of ${anchor.path} are not part of the diff`,
        };
      }
      const hunk = hunkForLine(file, anchor.side, anchor.end) ?? hunkForLine(file, anchor.side, anchor.start);
      return { ok: true, file, hunk };
    }
  }
}

/** Build a line anchor for a range, validating that the lines are in the diff. */
export function makeLinesAnchor(
  model: PatchModel,
  opts: { path: string; side: Side; start: number; end?: number; commit: string },
  review?: Pick<ReviewFile, "blobs">,
): LinesAnchor {
  const end = opts.end ?? opts.start;
  const text = anchoredText(model, opts.path, opts.side, opts.start, end, review);
  if (!text) {
    const file = model.byPath.get(opts.path);
    const ranges = file?.hunks
      .map((h) => (opts.side === "old" ? `${h.oldStart}-${h.oldStart + h.oldCount - 1}` : `${h.newStart}-${h.newStart + h.newCount - 1}`))
      .join(", ");
    throw new Error(
      `Lines ${opts.start}-${end} (${opts.side}) of ${opts.path} are not in the diff.` +
        (ranges ? ` Hunks on that side cover: ${ranges}.` : ""),
    );
  }
  const file = model.byPath.get(opts.path)!;
  const hunk = hunkForLine(file, opts.side, end) ?? hunkForLine(file, opts.side, opts.start);
  const anchor: LinesAnchor = {
    kind: "lines",
    path: opts.path,
    side: opts.side,
    start: opts.start,
    end,
    commit: opts.commit,
    fingerprint: fingerprintLines(text),
  };
  if (hunk) anchor.hunk = hunk.id;
  return anchor;
}

/**
 * Find where a fingerprinted range sits in a new version of a file. Searches
 * outward from the old position so the nearest match wins. `lineAt` returns
 * undefined for unknown lines (e.g. outside the diff when only a patch is known).
 */
export function relocateRange(
  fingerprint: string,
  length: number,
  oldStart: number,
  lineAt: (n: number) => string | undefined,
  maxLine: number,
): number | undefined {
  const matches = (start: number) => {
    const lines: string[] = [];
    for (let n = start; n < start + length; n++) {
      const t = lineAt(n);
      if (t === undefined) return false;
      lines.push(t);
    }
    return fingerprintLines(lines) === fingerprint;
  };
  const last = maxLine - length + 1;
  for (let d = 0; d <= Math.max(oldStart, last); d++) {
    const down = oldStart + d;
    const up = oldStart - d;
    if (down >= 1 && down <= last && matches(down)) return down;
    if (d > 0 && up >= 1 && up <= last && matches(up)) return up;
  }
  return undefined;
}

export function anchorPath(anchor: Anchor): string | undefined {
  return anchor.kind === "review" ? undefined : anchor.path;
}

/** Map our side to @pierre/diffs' AnnotationSide. */
export function toPierreSide(side: Side): "deletions" | "additions" {
  return side === "old" ? "deletions" : "additions";
}

export function fromPierreSide(side: "deletions" | "additions"): Side {
  return side === "deletions" ? "old" : "new";
}
