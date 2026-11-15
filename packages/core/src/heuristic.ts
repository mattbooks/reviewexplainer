/**
 * Rule-based first pass: no model needed. Orders files by role, then by
 * import dependencies among the changed files, so definitions come before
 * the code that uses them and generated files come last.
 */
import { posix } from "node:path";
import {
  ensureRemainingStep,
  parsePatch,
  type FileEntry,
  type ReviewFile,
  type Step,
  type StepKind,
} from "@reviewexplainer/format";
import { isDefinitionPath } from "./roles.ts";

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".vue", ".svelte"];

export function extractImports(path: string, content: string): string[] {
  const specs: string[] = [];
  const push = (re: RegExp) => {
    for (const m of content.matchAll(re)) if (m[1]) specs.push(m[1]);
  };
  if (/\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/.test(path)) {
    push(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g);
    push(/import\s*['"]([^'"]+)['"]/g);
    push(/require\(\s*['"]([^'"]+)['"]\s*\)/g);
    push(/import\(\s*['"]([^'"]+)['"]\s*\)/g);
  } else if (/\.py$/.test(path)) {
    push(/^\s*from\s+([.\w]+)\s+import/gm);
    push(/^\s*import\s+([\w.]+)/gm);
  } else if (/\.(c|cc|cpp|h|hpp)$/.test(path)) {
    push(/#include\s+"([^"]+)"/g);
  }
  return specs;
}

/** Resolve an import specifier to one of the changed paths, if it points at one. */
export function resolveImport(from: string, spec: string, changed: Set<string>): string | undefined {
  const dir = posix.dirname(from);
  const candidates: string[] = [];
  if (/\.py$/.test(from)) {
    let base: string;
    if (spec.startsWith(".")) {
      const dots = /^\.+/.exec(spec)![0].length;
      let d = dir;
      for (let i = 1; i < dots; i++) d = posix.dirname(d);
      base = posix.join(d, spec.slice(dots).replace(/\./g, "/"));
    } else {
      base = spec.replace(/\./g, "/");
    }
    for (const b of [base, `src/${base}`]) candidates.push(`${b}.py`, `${b}/__init__.py`);
  } else if (spec.startsWith(".") || /\.(c|cc|cpp|h|hpp)$/.test(from)) {
    const joined = posix.normalize(posix.join(dir, spec));
    const stripped = joined.replace(/\.(m|c)?js$/, "");
    candidates.push(joined);
    for (const b of [joined, stripped]) {
      for (const ext of JS_EXTS) candidates.push(b + ext, `${b}/index${ext}`);
    }
  } else {
    // A bare specifier may name a workspace package in this change, e.g.
    // "@acme/format" -> packages/format/src/index.ts.
    const parts = spec.split("/");
    const name = spec.startsWith("@") ? parts[1] : parts[0];
    if (!name) return undefined;
    const entry = new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(src/)?index\\.(m|c)?[jt]sx?$`);
    return [...changed].find((c) => c !== from && entry.test(c));
  }
  return candidates.find((c) => c !== from && changed.has(c));
}

/** Topological order: dependencies first; ties and cycles keep the input order. */
export function dependencyOrder(paths: string[], deps: Map<string, Set<string>>): string[] {
  const inSet = new Set(paths);
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];
  const visit = (p: string) => {
    if (done.has(p) || visiting.has(p)) return;
    visiting.add(p);
    for (const d of [...(deps.get(p) ?? [])].sort((a, b) => paths.indexOf(a) - paths.indexOf(b))) {
      if (inSet.has(d)) visit(d);
    }
    visiting.delete(p);
    done.add(p);
    out.push(p);
  };
  for (const p of paths) visit(p);
  return out;
}

interface Bucket {
  id: string;
  title: string;
  kind: StepKind;
  narrative: string;
  paths: string[];
}

function lineStats(file: FileEntry, model: ReturnType<typeof parsePatch>) {
  const parsed = model.byPath.get(file.path);
  let add = 0;
  let del = 0;
  for (const h of parsed?.hunks ?? []) {
    for (const r of h.rows) {
      if (r.type === "add") add++;
      else if (r.type === "del") del++;
    }
  }
  return { add, del };
}

const MAX_FILES_PER_STEP = 12;

function groupKey(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0]! : ".";
}

/**
 * Split a large step by directory. Groups are ordered by the imports between
 * them (a group that others depend on comes first), then by first appearance.
 */
function splitLarge(bucket: Bucket, deps: Map<string, Set<string>>): Bucket[] {
  if (bucket.paths.length <= MAX_FILES_PER_STEP) return [bucket];
  const groups = new Map<string, string[]>();
  for (const p of bucket.paths) {
    const key = groupKey(p);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  if (groups.size <= 1) return [bucket];
  const groupDeps = new Map<string, Set<string>>();
  for (const [key, paths] of groups) {
    const set = new Set<string>();
    for (const p of paths) {
      for (const d of deps.get(p) ?? []) {
        const other = groupKey(d);
        if (other !== key && groups.has(other)) set.add(other);
      }
    }
    groupDeps.set(key, set);
  }
  return dependencyOrder([...groups.keys()], groupDeps).map((key) => ({
    ...bucket,
    id: `${bucket.id}-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    title: `${bucket.title} (${key})`,
    paths: groups.get(key)!,
  }));
}

export interface HeuristicOptions {
  /** Head-side contents of changed files, for import analysis. */
  contentAt?: (path: string) => Promise<string | undefined>;
}

export async function heuristicGuide(review: ReviewFile, opts: HeuristicOptions = {}): Promise<ReviewFile> {
  const model = parsePatch(review.patch);
  const files = review.files;
  const changed = new Set(files.filter((f) => f.status !== "deleted").map((f) => f.path));

  const deps = new Map<string, Set<string>>();
  const importedBy = new Map<string, number>();
  if (opts.contentAt) {
    for (const f of files) {
      if (f.status === "deleted" || f.binary || (f.role && f.role !== "source" && f.role !== "test")) continue;
      const content = await opts.contentAt(f.path);
      if (!content) continue;
      const set = new Set<string>();
      for (const spec of extractImports(f.path, content)) {
        const target = resolveImport(f.path, spec, changed);
        if (target) set.add(target);
      }
      deps.set(f.path, set);
      if (f.role === "source" || !f.role) {
        for (const t of set) importedBy.set(t, (importedBy.get(t) ?? 0) + 1);
      }
    }
  }

  const isMechanical = (f: FileEntry) =>
    f.binary ||
    f.role === "lockfile" ||
    f.role === "generated" ||
    f.role === "vendored" ||
    (f.status === "renamed" && f.hunks.length === 0);
  const source = files.filter((f) => !isMechanical(f) && (f.role ?? "source") === "source");
  const definitions = source.filter((f) => isDefinitionPath(f.path)).map((f) => f.path);
  const rest = source.filter((f) => !definitions.includes(f.path)).map((f) => f.path);
  const core = rest.filter((p) => (importedBy.get(p) ?? 0) > 0);
  const callers = rest.filter((p) => !core.includes(p));
  const byRole = (role: string) => files.filter((f) => !isMechanical(f) && f.role === role).map((f) => f.path);

  const buckets: Bucket[] = [
    {
      id: "definitions",
      title: "Types, schemas and data definitions",
      kind: "context",
      narrative:
        "Start with the data shapes. Later steps rely on these, so note new or renamed fields, changed signatures and anything removed.",
      paths: dependencyOrder(definitions, deps),
    },
    {
      id: "core",
      title: core.length && callers.length ? "Core changes" : "Source changes",
      kind: "core",
      narrative:
        "The main behavior change. Other changed files import these, so read them before their callers. Check edge cases, error handling and any change in what callers can rely on.",
      paths: dependencyOrder(core.length ? core : callers, deps),
    },
    {
      id: "callers",
      title: "Code that uses those changes",
      kind: "wiring",
      narrative:
        "Call sites and wiring built on the earlier steps. Check that each caller handles the new behavior and nothing was missed.",
      paths: core.length ? dependencyOrder(callers, deps) : [],
    },
    {
      id: "config",
      title: "Configuration and build",
      kind: "wiring",
      narrative: "Settings, dependencies and build or CI changes that support the code above.",
      paths: byRole("config"),
    },
    {
      id: "tests",
      title: "Tests",
      kind: "tests",
      narrative: "Check that the tests cover the behavior changed above, including failure paths, and that none were weakened.",
      paths: dependencyOrder(byRole("test"), deps),
    },
    {
      id: "docs",
      title: "Documentation",
      kind: "context",
      narrative: "Check that the docs match the new behavior.",
      paths: byRole("docs"),
    },
    {
      id: "mechanical",
      title: "Generated, vendored and mechanical changes",
      kind: "mechanical",
      narrative:
        "Lockfiles, generated output, vendored code, binary files and pure renames. Usually safe to skim; look for unexpected entries.",
      paths: files.filter(isMechanical).map((f) => f.path),
    },
  ];

  const steps: Step[] = buckets
    .filter((b) => b.paths.length > 0)
    .flatMap((b) => (b.id === "core" || b.id === "callers" ? splitLarge(b, deps) : [b]))
    .map((b) => ({
      id: b.id,
      title: b.title,
      kind: b.kind,
      narrative: b.narrative,
      items: b.paths.map((path) => ({ path, hunks: "all" as const })),
    }));

  let add = 0;
  let del = 0;
  for (const f of files) {
    const s = lineStats(f, model);
    add += s.add;
    del += s.del;
  }
  const pr = review.subject.pr;
  const overview = [
    pr ? `**${pr.title}** (#${pr.number} by ${pr.author})` : undefined,
    `${files.length} files changed, +${add} −${del}. This order was produced by rules (definitions, then core code and its callers, then config, tests, docs, and generated files last). Run \`greview ai\` for an AI-written guide with explanations.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return ensureRemainingStep({ ...review, guide: { overview, generatedBy: "heuristic", steps } }, model);
}
