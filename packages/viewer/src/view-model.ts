/**
 * Turns a review file into CodeView items: one item per (step, file), showing
 * only that step's hunks or slices, with step narration, threads and notes
 * placed as line annotations.
 */
import { parsePatchFiles, type CodeViewDiffItem, type DiffLineAnnotation, type FileDiffMetadata } from "@pierre/diffs";
import {
  buildItemPatch,
  itemPieces,
  parsePatch,
  toPierreSide,
  type Anchor,
  type PatchModel,
  type ReviewFile,
  type Side,
  type Source,
  type Step,
  type StepItem,
} from "@reviewexplainer/format";

export interface SpotMeta {
  narrativeStep?: string;
  threadIds: string[];
  noteIds: string[];
  composer?: boolean;
}

export type Item = CodeViewDiffItem<SpotMeta>;

export interface ItemInfo {
  id: string;
  stepId: string;
  stepIndex: number;
  path: string;
  /** Keys in state.viewed that this item covers: hunk ids, or hunkId:from-to for slices. */
  viewKeys: string[];
  fileDiff: FileDiffMetadata;
}

export interface Draft {
  itemId: string;
  path: string;
  side: Side;
  start: number;
  end: number;
}

export interface Filters {
  sources: Record<Source, boolean>;
  showResolved: boolean;
  showNotes: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  sources: { ai: true, github: true, local: true },
  showResolved: false,
  showNotes: true,
};

export interface Layout {
  model: PatchModel;
  infos: ItemInfo[];
  byId: Map<string, ItemInfo>;
  /** `${path}|${side}|${line}` to the item that shows that line. */
  lineOwner: Map<string, string>;
  /** hunk id to the first item showing (part of) it, plus the last line shown there. */
  hunkOwner: Map<string, { itemId: string; side: Side; line: number }>;
  firstItemOfFile: Map<string, string>;
  firstItemOfStep: Map<string, string>;
}

function pieceKey(hunkId: string, rows: [number, number], total: number): string {
  return rows[0] === 0 && rows[1] === total - 1 ? hunkId : `${hunkId}:${rows[0]}-${rows[1]}`;
}

function itemId(step: Step, item: StepItem, n: number): string {
  return `${step.id}::${item.path}${n > 0 ? `#${n}` : ""}`;
}

/** The expensive part: parse the patch and every item's sub-patch. Depends only on patch and guide. */
export function buildLayout(review: Pick<ReviewFile, "patch" | "guide">): Layout {
  const model = parsePatch(review.patch);
  const layout: Layout = {
    model,
    infos: [],
    byId: new Map(),
    lineOwner: new Map(),
    hunkOwner: new Map(),
    firstItemOfFile: new Map(),
    firstItemOfStep: new Map(),
  };
  review.guide.steps.forEach((step, stepIndex) => {
    const seen = new Map<string, number>();
    for (const item of step.items) {
      const file = model.byPath.get(item.path);
      if (!file) continue;
      const n = seen.get(item.path) ?? 0;
      seen.set(item.path, n + 1);
      const id = itemId(step, item, n);
      const parsed = parsePatchFiles(buildItemPatch(model, item), { throwOnError: false })[0]?.files[0];
      if (!parsed) continue;
      parsed.cacheKey = `item:${id}:${parsed.hunks.length}`;
      const pieces = file.hunks.length ? itemPieces(file, item) : [];
      const viewKeys: string[] = [];
      for (const piece of pieces) {
        const hunk = model.hunkById.get(piece.hunkId)!.hunk;
        viewKeys.push(pieceKey(piece.hunkId, piece.rows, hunk.rows.length));
        let last: { side: Side; line: number } | undefined;
        for (let i = piece.rows[0]; i <= piece.rows[1]; i++) {
          const r = hunk.rows[i]!;
          if (r.newLine !== undefined) layout.lineOwner.set(`${item.path}|new|${r.newLine}`, id);
          if (r.oldLine !== undefined) layout.lineOwner.set(`${item.path}|old|${r.oldLine}`, id);
          if (r.newLine !== undefined) last = { side: "new", line: r.newLine };
          else if (r.oldLine !== undefined && (!last || last.side === "old")) last = { side: "old", line: r.oldLine };
        }
        if (last && !layout.hunkOwner.has(piece.hunkId)) layout.hunkOwner.set(piece.hunkId, { itemId: id, ...last });
      }
      if (file.hunks.length === 0) viewKeys.push(`file:${item.path}`);
      if (!layout.firstItemOfFile.has(item.path)) layout.firstItemOfFile.set(item.path, id);
      if (!layout.firstItemOfStep.has(step.id)) layout.firstItemOfStep.set(step.id, id);
      const info: ItemInfo = { id, stepId: step.id, stepIndex, path: item.path, viewKeys, fileDiff: parsed };
      layout.infos.push(info);
      layout.byId.set(id, info);
    }
  });
  return layout;
}

export type Placement = { kind: "item"; itemId: string; side: Side; line: number } | { kind: "review" } | { kind: "nowhere" };

export function placeAnchor(layout: Layout, anchor: Anchor): Placement {
  switch (anchor.kind) {
    case "review":
      return { kind: "review" };
    case "file": {
      const id = layout.firstItemOfFile.get(anchor.path);
      return id ? { kind: "item", itemId: id, side: "new", line: 0 } : { kind: "nowhere" };
    }
    case "hunk": {
      const owner = layout.hunkOwner.get(anchor.hunk);
      if (owner) return { kind: "item", ...owner };
      const id = layout.firstItemOfFile.get(anchor.path);
      return id ? { kind: "item", itemId: id, side: "new", line: 0 } : { kind: "nowhere" };
    }
    case "lines": {
      const id =
        layout.lineOwner.get(`${anchor.path}|${anchor.side}|${anchor.end}`) ??
        layout.lineOwner.get(`${anchor.path}|${anchor.side}|${anchor.start}`);
      if (id) {
        const line = layout.lineOwner.get(`${anchor.path}|${anchor.side}|${anchor.end}`) ? anchor.end : anchor.start;
        return { kind: "item", itemId: id, side: anchor.side, line };
      }
      const first = layout.firstItemOfFile.get(anchor.path);
      return first ? { kind: "item", itemId: first, side: "new", line: 0 } : { kind: "nowhere" };
    }
  }
}

export function isViewed(review: Pick<ReviewFile, "state">, info: ItemInfo): boolean {
  return info.viewKeys.length > 0 && info.viewKeys.every((k) => k in review.state.viewed);
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface Decorated {
  items: Item[];
  reviewThreadIds: string[];
  reviewNoteIds: string[];
  outdatedThreadIds: string[];
  /** Open thread count per item and per path, for headers and the file tree. */
  openByItem: Map<string, number>;
  openByPath: Map<string, number>;
}

/** Cheap part: place threads and notes, apply filters and viewed state. */
export function decorate(
  review: ReviewFile,
  layout: Layout,
  opts: { filters: Filters; draft?: Draft | null; expanded: Set<string>; collapsedByDefault: Set<string> },
): Decorated {
  const spots = new Map<string, DiffLineAnnotation<SpotMeta>[]>();
  const spot = (itemId: string, side: Side, line: number): SpotMeta => {
    const info = layout.byId.get(itemId)!;
    const pierreSide = line === 0 && info.fileDiff.type === "deleted" ? "deletions" : toPierreSide(line === 0 ? "new" : side);
    const list = spots.get(itemId) ?? [];
    let found = list.find((a) => a.side === pierreSide && a.lineNumber === line);
    if (!found) {
      found = { side: pierreSide, lineNumber: line, metadata: { threadIds: [], noteIds: [] } };
      list.push(found);
      spots.set(itemId, list);
    }
    return found.metadata;
  };

  for (const step of review.guide.steps) {
    const first = layout.firstItemOfStep.get(step.id);
    if (first) spot(first, "new", 0).narrativeStep = step.id;
  }

  const out: Decorated = {
    items: [],
    reviewThreadIds: [],
    reviewNoteIds: [],
    outdatedThreadIds: [],
    openByItem: new Map(),
    openByPath: new Map(),
  };

  for (const t of review.threads) {
    if (t.status === "outdated") {
      out.outdatedThreadIds.push(t.id);
      continue;
    }
    if (!opts.filters.sources[t.source]) continue;
    if (t.status === "resolved" && !opts.filters.showResolved) continue;
    const p = placeAnchor(layout, t.anchor);
    if (p.kind === "review") out.reviewThreadIds.push(t.id);
    else if (p.kind === "nowhere") out.outdatedThreadIds.push(t.id);
    else {
      spot(p.itemId, p.side, p.line).threadIds.push(t.id);
      if (t.status === "open") {
        out.openByItem.set(p.itemId, (out.openByItem.get(p.itemId) ?? 0) + 1);
        const path = layout.byId.get(p.itemId)!.path;
        out.openByPath.set(path, (out.openByPath.get(path) ?? 0) + 1);
      }
    }
  }
  if (opts.filters.showNotes) {
    for (const a of review.annotations) {
      if (a.outdated || !opts.filters.sources[a.source]) continue;
      const p = placeAnchor(layout, a.anchor);
      if (p.kind === "review") out.reviewNoteIds.push(a.id);
      else if (p.kind === "item") spot(p.itemId, p.side, p.line).noteIds.push(a.id);
    }
  }
  if (opts.draft && layout.byId.has(opts.draft.itemId)) {
    spot(opts.draft.itemId, opts.draft.side, opts.draft.end).composer = true;
  }

  for (const info of layout.infos) {
    const annotations = spots.get(info.id) ?? [];
    const viewed = isViewed(review, info);
    const collapsed = !opts.expanded.has(info.id) && (viewed || opts.collapsedByDefault.has(info.id));
    const version = hash(`${JSON.stringify(annotations)}|${collapsed}|${viewed}|${review.threads.length}|${review.annotations.length}`);
    out.items.push({ id: info.id, type: "diff", fileDiff: info.fileDiff, annotations, collapsed, version });
  }
  return out;
}

/** Items in steps the guide marks as mechanical start collapsed. */
export function mechanicalItems(review: ReviewFile, layout: Layout): Set<string> {
  const kinds = new Map(review.guide.steps.map((s) => [s.id, s.kind]));
  return new Set(
    layout.infos.filter((i) => kinds.get(i.stepId) === "mechanical" || kinds.get(i.stepId) === "generated").map((i) => i.id),
  );
}

export function stepProgress(review: ReviewFile, layout: Layout, stepId: string): { viewed: number; total: number } {
  const keys = layout.infos.filter((i) => i.stepId === stepId).flatMap((i) => i.viewKeys);
  return { viewed: keys.filter((k) => k in review.state.viewed).length, total: keys.length };
}
