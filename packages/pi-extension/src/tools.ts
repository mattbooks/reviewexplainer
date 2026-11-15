/**
 * Tools the model uses to build a guided review. Each tool validates its
 * input against the patch and saves the review file, so mistakes come back
 * to the model as tool errors it can fix.
 */
import { Type, type Static } from "typebox";
import {
  coverage,
  coverageProblems,
  ensureRemainingStep,
  makeLinesAnchor,
  newId,
  nowIso,
  parsePatch,
  Severity,
  StepKind,
  type Anchor,
  type ParsedFile,
  type ParsedHunk,
  type ReviewFile,
  type Step,
} from "@reviewexplainer/format";

export interface ReviewSession {
  /** Current review document. */
  get(): ReviewFile;
  /** Replace and persist the review document (throws if invalid). */
  save(next: ReviewFile): void;
  /** Model info for AI-authored comments. */
  ai(): { model: string; provider: string } | undefined;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

export interface ReviewTool<P extends ReturnType<typeof Type.Object>> {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: P;
  run(session: ReviewSession, params: Static<P>): ToolResult;
}

const text = (t: string, details: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: "text", text: t }],
  details,
});

function stats(file: ParsedFile) {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) for (const r of h.rows) r.type === "add" ? add++ : r.type === "del" ? del++ : 0;
  return { add, del };
}

export function renderHunk(file: ParsedFile, hunk: ParsedHunk): string {
  const out = [`hunk ${hunk.id}  ${hunk.header}  (${hunk.rows.length} rows)`, " row   old   new"];
  hunk.rows.forEach((r, i) => {
    const sign = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
    const col = (n?: number) => (n === undefined ? "" : String(n)).padStart(5);
    out.push(`${String(i).padStart(4)} ${col(r.oldLine)} ${col(r.newLine)} ${sign} ${r.text}`);
  });
  return out.join("\n");
}

const AnchorParams = {
  path: Type.Optional(Type.String({ description: "File path. Omit for a note on the whole change." })),
  hunk: Type.Optional(Type.String({ description: "Hunk id, to anchor to a whole hunk." })),
  side: Type.Optional(
    Type.Union([Type.Literal("old"), Type.Literal("new")], {
      description: "Side the line numbers refer to: new (head, default) or old (base, for deleted lines).",
    }),
  ),
  start: Type.Optional(Type.Integer({ minimum: 1, description: "First line number on that side." })),
  end: Type.Optional(Type.Integer({ minimum: 1, description: "Last line number (default: start)." })),
};

type AnchorInput = { path?: string; hunk?: string; side?: "old" | "new"; start?: number; end?: number };

export function anchorFrom(review: ReviewFile, p: AnchorInput): Anchor {
  const model = parsePatch(review.patch);
  if (!p.path) {
    if (p.hunk || p.start) throw new Error("Give a path along with hunk or line numbers");
    return { kind: "review" };
  }
  const file = model.byPath.get(p.path);
  if (!file) throw new Error(`${p.path} is not in this diff. Call review_files to list the changed files.`);
  if (p.start !== undefined) {
    return makeLinesAnchor(
      model,
      { path: p.path, side: p.side ?? "new", start: p.start, end: p.end ?? p.start, commit: review.subject.head.sha },
      review,
    );
  }
  if (p.hunk) {
    if (!file.hunks.some((h) => h.id === p.hunk)) {
      throw new Error(`Hunk ${p.hunk} is not in ${p.path}. Its hunks are: ${file.hunks.map((h) => h.id).join(", ")}`);
    }
    return { kind: "hunk", path: p.path, hunk: p.hunk };
  }
  return { kind: "file", path: p.path };
}

const filesParams = Type.Object({});
export const reviewFilesTool: ReviewTool<typeof filesParams> = {
  name: "review_files",
  label: "Review files",
  description:
    "List the files in the change under review with status, role, line counts and hunk ids, plus the current guide steps.",
  promptSnippet: "List changed files, hunk ids and the current guide",
  parameters: filesParams,
  run(session) {
    const review = session.get();
    const model = parsePatch(review.patch);
    const lines = [`Change: ${review.subject.base.ref ?? review.subject.base.sha} -> ${review.subject.head.ref ?? review.subject.head.sha} (head ${review.subject.head.sha.slice(0, 12)})`];
    if (review.subject.pr) lines.push(`PR #${review.subject.pr.number}: ${review.subject.pr.title}`);
    lines.push("", "Files:");
    for (const f of review.files) {
      const parsed = model.byPath.get(f.path)!;
      const s = stats(parsed);
      const rename = f.oldPath ? ` (from ${f.oldPath})` : "";
      lines.push(
        `- ${f.path}${rename}  [${f.status}, ${f.role ?? "source"}${f.binary ? ", binary" : ""}]  +${s.add} -${s.del}`,
      );
      for (const h of parsed.hunks) lines.push(`    ${h.id}  ${h.header}  ${h.rows.length} rows`);
    }
    lines.push("", `Guide (${review.guide.generatedBy}):`);
    for (const [i, s] of review.guide.steps.entries()) {
      lines.push(`${i + 1}. [${s.id}] ${s.title}: ${s.items.map((it) => it.path).join(", ")}`);
    }
    return text(lines.join("\n"), { files: review.files.length });
  },
};

const showParams = Type.Object({
  path: Type.String({ description: "File path from review_files." }),
  hunk: Type.Optional(Type.String({ description: "Hunk id. Omit to show every hunk of the file." })),
});
export const reviewShowHunkTool: ReviewTool<typeof showParams> = {
  name: "review_show_hunk",
  label: "Show hunk",
  description:
    "Show hunks of a changed file with row indexes and old/new line numbers. Use the line numbers when anchoring comments and the row indexes when slicing a hunk across steps.",
  promptSnippet: "Show a diff hunk with row indexes and line numbers",
  parameters: showParams,
  run(session, p) {
    const model = parsePatch(session.get().patch);
    const file = model.byPath.get(p.path);
    if (!file) throw new Error(`${p.path} is not in this diff`);
    if (file.hunks.length === 0) return text(`${p.path} has no text hunks (${file.binary ? "binary" : file.status}).`);
    const hunks = p.hunk ? file.hunks.filter((h) => h.id === p.hunk) : file.hunks;
    if (hunks.length === 0) throw new Error(`Hunk ${p.hunk} is not in ${p.path}`);
    return text(`${p.path}\n\n${hunks.map((h) => renderHunk(file, h)).join("\n\n")}`);
  },
};

const StepParam = Type.Object({
  id: Type.String({ description: "Short kebab-case id, unique in the guide." }),
  title: Type.String({ description: "Short title, e.g. 'Session token model'." }),
  kind: Type.Optional(StepKind),
  narrative: Type.String({
    description: "2-4 sentences of markdown: what changed in this step, why, and what the reviewer should check.",
  }),
  items: Type.Array(
    Type.Object({
      path: Type.String(),
      hunks: Type.Union([Type.Array(Type.String()), Type.Literal("all")], {
        description: 'Hunk ids shown whole in this step, or "all".',
      }),
      slices: Type.Optional(
        Type.Array(
          Type.Object({
            hunk: Type.String(),
            rows: Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })], {
              description: "Inclusive row index range from review_show_hunk.",
            }),
          }),
          { description: "Parts of large hunks, when one hunk mixes changes that belong in different steps." },
        ),
      ),
      note: Type.Optional(Type.String({ description: "One line on this file's role in the step." })),
    }),
  ),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids of earlier steps this step builds on." })),
});
const setStepsParams = Type.Object({ steps: Type.Array(StepParam, { minItems: 1 }) });
export const reviewSetStepsTool: ReviewTool<typeof setStepsParams> = {
  name: "review_set_steps",
  label: "Set reading order",
  description:
    "Replace the guide with ordered reading steps. Every hunk must appear exactly once across all steps (whole, or split into slices that cover all its rows). Rejected with a list of problems otherwise.",
  promptSnippet: "Set the ordered reading steps of the guide",
  parameters: setStepsParams,
  run(session, p) {
    const review = session.get();
    const model = parsePatch(review.patch);
    const steps = p.steps as Step[];
    const problems = coverageProblems(coverage({ guide: { overview: "", generatedBy: "ai", steps } }, model));
    const ids = new Set<string>();
    for (const s of steps) {
      if (ids.has(s.id)) problems.push(`Duplicate step id "${s.id}"`);
      for (const d of s.dependsOn ?? []) if (!ids.has(d)) problems.push(`Step "${s.id}" depends on "${d}", which is not an earlier step`);
      ids.add(s.id);
    }
    if (problems.length) {
      throw new Error(`The steps were not saved:\n- ${problems.join("\n- ")}`);
    }
    const next = ensureRemainingStep({ ...review, guide: { ...review.guide, generatedBy: "ai", steps } }, model);
    session.save(next);
    return text(`Saved ${steps.length} steps covering ${model.hunkById.size} hunks.`, { steps: steps.length });
  },
};

const overviewParams = Type.Object({
  summary: Type.String({
    description: "Markdown overview: what the change does, how the steps build on each other, and where the risk is. 3-6 sentences.",
  }),
});
export const reviewOverviewTool: ReviewTool<typeof overviewParams> = {
  name: "review_overview",
  label: "Set overview",
  description: "Set the guide's overview shown above the first step.",
  promptSnippet: "Set the guide overview",
  parameters: overviewParams,
  run(session, p) {
    const review = session.get();
    session.save({ ...review, guide: { ...review.guide, overview: p.summary } });
    return text("Overview saved.");
  },
};

const annotateParams = Type.Object({ ...AnchorParams, body: Type.String({ description: "Markdown explanation." }) });
export const reviewAnnotateTool: ReviewTool<typeof annotateParams> = {
  name: "review_annotate",
  label: "Annotate",
  description:
    "Attach an explanatory note to code (not a request for changes): why something is done, what is mechanical, where an entry point is. Anchor with path + start/end lines, path + hunk, path alone, or nothing for the whole change.",
  promptSnippet: "Add an explanatory note anchored to code",
  parameters: annotateParams,
  run(session, p) {
    const review = session.get();
    const ai = session.ai();
    const annotation = {
      id: newId("ann"),
      anchor: anchorFrom(review, p),
      body: p.body,
      source: "ai" as const,
      author: { name: ai ? `${ai.provider}/${ai.model}` : "AI", kind: "ai" as const },
      createdAt: nowIso(),
    };
    session.save({ ...review, annotations: [...review.annotations, annotation] });
    return text(`Annotation ${annotation.id} saved.`, { id: annotation.id });
  },
};

const commentParams = Type.Object({
  ...AnchorParams,
  body: Type.String({ description: "The finding: what is wrong, why it matters, and how to fix it." }),
  severity: Severity,
  category: Type.Optional(Type.String({ description: "bug, security, performance, correctness, test, api, readability..." })),
  suggestion: Type.Optional(
    Type.String({ description: "Replacement text for exactly the anchored new-side lines, as a GitHub suggestion." }),
  ),
});
export const reviewCommentTool: ReviewTool<typeof commentParams> = {
  name: "review_comment",
  label: "Review comment",
  description:
    "Record a review finding that needs action, anchored to code like review_annotate. Use severity blocker for must-fix bugs or security problems, major for likely bugs, minor for real but small issues, nit for optional polish.",
  promptSnippet: "Record an actionable review finding anchored to code",
  parameters: commentParams,
  run(session, p) {
    const review = session.get();
    const anchor = anchorFrom(review, p);
    if (p.suggestion !== undefined && (anchor.kind !== "lines" || anchor.side !== "new")) {
      throw new Error("A suggestion needs a new-side line anchor (path, start, end)");
    }
    const ai = session.ai();
    const comment = {
      id: newId("c"),
      author: { name: ai ? `${ai.provider}/${ai.model}` : "AI", kind: "ai" as const },
      body: p.body,
      createdAt: nowIso(),
      ...(ai ? { ai } : {}),
    };
    const thread = {
      id: newId("ai"),
      anchor,
      source: "ai" as const,
      status: "open" as const,
      severity: p.severity,
      ...(p.category ? { category: p.category } : {}),
      ...(p.suggestion !== undefined ? { suggestion: { replacement: p.suggestion } } : {}),
      comments: [comment],
    };
    session.save({ ...review, threads: [...review.threads, thread] });
    return text(`Comment ${thread.id} saved.`, { id: thread.id });
  },
};

export const ALL_TOOLS = [
  reviewFilesTool,
  reviewShowHunkTool,
  reviewSetStepsTool,
  reviewOverviewTool,
  reviewAnnotateTool,
  reviewCommentTool,
] as const;
