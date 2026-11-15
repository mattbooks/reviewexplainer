/**
 * The review file schema, written once in TypeBox. The same definitions give
 * the TypeScript types (via `Static`), the JSON Schema (`writeJsonSchema`), and
 * the parameter schemas for the pi tools.
 */
import { Type, type Static } from "typebox";

export const FORMAT_VERSION = 1 as const;

export const Side = Type.Union([Type.Literal("old"), Type.Literal("new")], {
  description: "Which side of the diff a line number refers to: old (base) or new (head).",
});

export const HunkId = Type.String({
  pattern: "^[0-9a-f]{10}(-[0-9]+)?$",
  description: "Content hash of a hunk: sha1(path + newline + body lines), first 10 hex chars.",
});

export const ReviewAnchor = Type.Object({ kind: Type.Literal("review") });
export const FileAnchor = Type.Object({ kind: Type.Literal("file"), path: Type.String() });
export const HunkAnchor = Type.Object({
  kind: Type.Literal("hunk"),
  path: Type.String(),
  hunk: HunkId,
});
export const LinesAnchor = Type.Object({
  kind: Type.Literal("lines"),
  path: Type.String(),
  side: Side,
  start: Type.Integer({ minimum: 1, description: "First line, 1-based, on the given side." }),
  end: Type.Integer({ minimum: 1, description: "Last line, inclusive." }),
  hunk: Type.Optional(HunkId),
  commit: Type.String({ description: "Commit the line numbers refer to." }),
  fingerprint: Type.String({ description: "Hash of the anchored lines, used to re-place the anchor." }),
});
export const Anchor = Type.Union([ReviewAnchor, FileAnchor, HunkAnchor, LinesAnchor]);

export const FileStatus = Type.Union([
  Type.Literal("added"),
  Type.Literal("modified"),
  Type.Literal("deleted"),
  Type.Literal("renamed"),
]);

export const FileRole = Type.Union([
  Type.Literal("source"),
  Type.Literal("test"),
  Type.Literal("generated"),
  Type.Literal("lockfile"),
  Type.Literal("vendored"),
  Type.Literal("docs"),
  Type.Literal("config"),
]);

export const HunkRecord = Type.Object({
  id: HunkId,
  header: Type.String(),
  oldStart: Type.Integer({ minimum: 0 }),
  oldCount: Type.Integer({ minimum: 0 }),
  newStart: Type.Integer({ minimum: 0 }),
  newCount: Type.Integer({ minimum: 0 }),
  rows: Type.Integer({ minimum: 0, description: "Body rows, excluding no-newline markers." }),
});

export const FileEntry = Type.Object({
  path: Type.String(),
  oldPath: Type.Optional(Type.String()),
  status: FileStatus,
  role: Type.Optional(FileRole),
  binary: Type.Optional(Type.Boolean()),
  hunks: Type.Array(HunkRecord),
});

export const HunkSlice = Type.Object({
  hunk: HunkId,
  rows: Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })], {
    description: "0-based, inclusive range of hunk body rows.",
  }),
});

export const StepItem = Type.Object({
  path: Type.String(),
  hunks: Type.Union([Type.Array(HunkId), Type.Literal("all")]),
  slices: Type.Optional(Type.Array(HunkSlice)),
  note: Type.Optional(Type.String()),
});

export const StepKind = Type.Union([
  Type.Literal("context"),
  Type.Literal("core"),
  Type.Literal("wiring"),
  Type.Literal("tests"),
  Type.Literal("mechanical"),
  Type.Literal("generated"),
  Type.Literal("remaining"),
]);

export const Step = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  kind: Type.Optional(StepKind),
  narrative: Type.String({ description: "Markdown explaining what to look for in this step." }),
  items: Type.Array(StepItem),
  dependsOn: Type.Optional(Type.Array(Type.String())),
});

export const Source = Type.Union([Type.Literal("ai"), Type.Literal("github"), Type.Literal("local")]);

export const Guide = Type.Object({
  overview: Type.String(),
  generatedBy: Type.Union([Type.Literal("heuristic"), Type.Literal("ai"), Type.Literal("manual")]),
  steps: Type.Array(Step),
});

export const Author = Type.Object({
  name: Type.String(),
  kind: Type.Union([Type.Literal("human"), Type.Literal("ai")]),
});

export const AiInfo = Type.Object({
  model: Type.String(),
  provider: Type.String(),
  session: Type.Optional(Type.String()),
});

export const Annotation = Type.Object({
  id: Type.String({ minLength: 1 }),
  anchor: Anchor,
  body: Type.String(),
  source: Source,
  author: Type.Optional(Author),
  createdAt: Type.String(),
  outdated: Type.Optional(Type.Boolean()),
});

export const Comment = Type.Object({
  id: Type.String({ minLength: 1 }),
  author: Author,
  body: Type.String(),
  createdAt: Type.String(),
  ai: Type.Optional(AiInfo),
  githubId: Type.Optional(Type.Integer()),
});

export const Severity = Type.Union([
  Type.Literal("blocker"),
  Type.Literal("major"),
  Type.Literal("minor"),
  Type.Literal("nit"),
]);

export const Thread = Type.Object({
  id: Type.String({ minLength: 1 }),
  anchor: Anchor,
  source: Source,
  status: Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("outdated")]),
  severity: Type.Optional(Severity),
  category: Type.Optional(Type.String()),
  suggestion: Type.Optional(Type.Object({ replacement: Type.String() })),
  external: Type.Optional(
    Type.Object({
      github: Type.Optional(
        Type.Object({ commentIds: Type.Array(Type.Integer()), url: Type.String() }),
      ),
    }),
  ),
  comments: Type.Array(Comment, { minItems: 1 }),
});

export const Subject = Type.Object({
  repo: Type.Optional(Type.Object({ owner: Type.String(), name: Type.String() })),
  base: Type.Object({ ref: Type.Optional(Type.String()), sha: Type.String() }),
  head: Type.Object({ ref: Type.Optional(Type.String()), sha: Type.String() }),
  mergeBase: Type.Optional(Type.String()),
  pr: Type.Optional(
    Type.Object({
      number: Type.Integer(),
      url: Type.String(),
      title: Type.String(),
      author: Type.String(),
      body: Type.Optional(Type.String()),
    }),
  ),
});

export const ViewedEntry = Type.Object({ at: Type.String(), by: Type.Optional(Type.String()) });

export const ReviewState = Type.Object({
  viewed: Type.Record(Type.String(), ViewedEntry),
  verdict: Type.Optional(
    Type.Union([Type.Literal("approve"), Type.Literal("request-changes"), Type.Literal("comment")]),
  ),
  newSinceRefresh: Type.Optional(Type.Array(HunkId)),
});

export const GeneratorEntry = Type.Object({
  tool: Type.String(),
  version: Type.String(),
  at: Type.String(),
  model: Type.Optional(Type.String()),
});

export const Blob = Type.Object({
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
});

export const ReviewFile = Type.Object({
  $schema: Type.Optional(Type.String()),
  version: Type.Literal(FORMAT_VERSION),
  generators: Type.Array(GeneratorEntry),
  subject: Subject,
  patch: Type.String({ description: "Canonical unified diff (git format)." }),
  files: Type.Array(FileEntry),
  guide: Guide,
  annotations: Type.Array(Annotation),
  threads: Type.Array(Thread),
  state: ReviewState,
  blobs: Type.Optional(Type.Record(Type.String(), Blob)),
});

export type Side = Static<typeof Side>;
export type HunkId = Static<typeof HunkId>;
export type Anchor = Static<typeof Anchor>;
export type LinesAnchor = Static<typeof LinesAnchor>;
export type FileStatus = Static<typeof FileStatus>;
export type FileRole = Static<typeof FileRole>;
export type HunkRecord = Static<typeof HunkRecord>;
export type FileEntry = Static<typeof FileEntry>;
export type HunkSlice = Static<typeof HunkSlice>;
export type StepItem = Static<typeof StepItem>;
export type StepKind = Static<typeof StepKind>;
export type Step = Static<typeof Step>;
export type Source = Static<typeof Source>;
export type Guide = Static<typeof Guide>;
export type Author = Static<typeof Author>;
export type Annotation = Static<typeof Annotation>;
export type Comment = Static<typeof Comment>;
export type Severity = Static<typeof Severity>;
export type Thread = Static<typeof Thread>;
export type Subject = Static<typeof Subject>;
export type ReviewState = Static<typeof ReviewState>;
export type GeneratorEntry = Static<typeof GeneratorEntry>;
export type ReviewFile = Static<typeof ReviewFile>;
