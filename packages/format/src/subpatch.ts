/**
 * Builds the patch text for one step item: only the hunks (and hunk slices)
 * that the step covers. Any contiguous run of hunk rows is a valid hunk once
 * its header is recomputed, so slices go through the same path as whole hunks.
 */
import type { HunkSlice, StepItem } from "./schema.ts";
import { filePatchText, type ParsedFile, type ParsedHunk, type PatchModel } from "./patch.ts";

export interface PieceHunk {
  header: string;
  lines: string[];
  /** Sort key: first new-side line, then old-side line. */
  order: [number, number];
  /** Hunk id this piece came from. */
  hunkId: string;
  /** Row range of the source hunk this piece shows. */
  rows: [number, number];
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Recompute a hunk header and body for rows [from, to] of a hunk. */
export function sliceHunk(hunk: ParsedHunk, from: number, to: number): PieceHunk {
  const rows = hunk.rows;
  if (from < 0 || to >= rows.length || from > to) {
    throw new Error(`Slice [${from}, ${to}] is outside hunk ${hunk.id} (${rows.length} rows)`);
  }
  let oldFirst = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newFirst = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
  for (let i = 0; i < from; i++) {
    const r = rows[i]!;
    if (r.type !== "add") oldFirst++;
    if (r.type !== "del") newFirst++;
  }
  let oldCount = 0;
  let newCount = 0;
  const lines: string[] = [];
  for (let i = from; i <= to; i++) {
    const r = rows[i]!;
    if (r.type !== "add") oldCount++;
    if (r.type !== "del") newCount++;
    const prefix = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
    lines.push(prefix + r.text);
    if (r.noNewline) lines.push("\\ No newline at end of file");
  }
  const oldStart = oldCount === 0 ? oldFirst - 1 : oldFirst;
  const newStart = newCount === 0 ? newFirst - 1 : newFirst;
  const whole = from === 0 && to === rows.length - 1;
  const ctx = whole && hunk.context ? ` ${hunk.context}` : "";
  return {
    header: `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${ctx}`,
    lines: whole ? hunk.lines : lines,
    order: [newFirst, oldFirst],
    hunkId: hunk.id,
    rows: [from, to],
  };
}

export function itemPieces(file: ParsedFile, item: Pick<StepItem, "hunks" | "slices">): PieceHunk[] {
  const pieces: PieceHunk[] = [];
  const wanted = item.hunks === "all" ? new Set(file.hunks.map((h) => h.id)) : new Set(item.hunks);
  for (const h of file.hunks) {
    if (wanted.has(h.id)) pieces.push(sliceHunk(h, 0, h.rows.length - 1));
  }
  for (const s of item.slices ?? []) {
    const h = file.hunks.find((x) => x.id === s.hunk);
    if (!h) throw new Error(`Slice refers to unknown hunk ${s.hunk} in ${file.path}`);
    pieces.push(sliceHunk(h, s.rows[0], s.rows[1]));
  }
  pieces.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  return pieces;
}

/** Patch text for one step item. Returns the whole file section when it has no hunks. */
export function buildItemPatch(model: PatchModel, item: StepItem): string {
  const file = model.byPath.get(item.path);
  if (!file) throw new Error(`Step item refers to unknown file ${item.path}`);
  if (file.hunks.length === 0) return filePatchText(file, []);
  return filePatchText(file, itemPieces(file, item));
}

export function sliceRows(s: HunkSlice): number {
  return s.rows[1] - s.rows[0] + 1;
}
