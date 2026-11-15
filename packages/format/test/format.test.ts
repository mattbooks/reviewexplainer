import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  applyJsonPatch,
  buildItemPatch,
  coverage,
  createReview,
  ensureRemainingStep,
  fingerprintLines,
  makeLinesAnchor,
  parsePatch,
  relocateRange,
  REMAINING_STEP_ID,
  resolveAnchor,
  sha1Hex,
  sliceHunk,
  validateReview,
  type ReviewFile,
} from "../src/index.ts";

const patch = readFileSync(new URL("./fixtures/sample.patch", import.meta.url), "utf8");
const subject = { base: { sha: "aaa" }, head: { sha: "bbb" } };

function review(): ReviewFile {
  return createReview({ subject, patch, tool: "test", version: "0" });
}

describe("sha1", () => {
  it("matches known digests", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("a".repeat(1000))).toBe("291e9a6c66994949b57ba5e650361e98fc36b1ba");
    for (const s of ["héllo ✓", "x".repeat(55), "x".repeat(56), "x".repeat(64), "🙂\n\t"]) {
      expect(sha1Hex(s)).toBe(createHash("sha1").update(s).digest("hex"));
    }
  });
});

describe("parsePatch", () => {
  const model = parsePatch(patch);

  it("finds every file with its status", () => {
    expect(model.files.map((f) => [f.path, f.status, f.hunks.length])).toEqual([
      ["logo.bin", "modified", 0],
      ["src/gone.ts", "deleted", 1],
      ["src/math.ts", "modified", 3],
      ["src/new-name.ts", "renamed", 1],
      ["src/nonl.ts", "modified", 1],
      ["src/renamed-pure.ts", "renamed", 0],
      ["test/math.test.ts", "added", 1],
    ]);
    expect(model.byPath.get("logo.bin")!.binary).toBe(true);
    expect(model.byPath.get("src/new-name.ts")!.oldPath).toBe("src/old-name.ts");
    expect(model.byPath.get("src/renamed-pure.ts")!.oldPath).toBe("src/pure.ts");
  });

  it("numbers rows on both sides", () => {
    const h = model.byPath.get("src/math.ts")!.hunks[0]!;
    expect(h.rows.length).toBe(10);
    expect(h.rows[2]).toMatchObject({ type: "del", oldLine: 3 });
    expect(h.rows[3]).toMatchObject({ type: "add", newLine: 3 });
    expect(h.rows[6]).toMatchObject({ type: "add", newLine: 6 });
    expect(h.rows[9]).toMatchObject({ type: "context", oldLine: 8, newLine: 9 });
    const added = model.byPath.get("test/math.test.ts")!.hunks[0]!;
    expect(added.rows.map((r) => r.newLine)).toEqual([1, 2, 3]);
  });

  it("tracks no-newline markers", () => {
    const rows = model.byPath.get("src/nonl.ts")!.hunks[0]!.rows;
    expect(rows.filter((r) => r.noNewline).length).toBe(2);
  });

  it("gives stable content-hashed hunk ids that ignore the @@ header", () => {
    const ids = model.files.flatMap((f) => f.hunks.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{10}$/);
    const shifted = patch.replace("@@ -37,7 +38,7 @@", "@@ -47,7 +48,7 @@");
    expect(parsePatch(shifted).files.flatMap((f) => f.hunks.map((h) => h.id))).toEqual(ids);
  });

  it("suffixes identical hunks in one file", () => {
    const dup = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -10,1 +10,1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const ids = parsePatch(dup).files[0]!.hunks.map((h) => h.id);
    expect(ids[1]).toBe(`${ids[0]}-2`);
  });
});

describe("sub-patches", () => {
  const model = parsePatch(patch);
  const math = model.byPath.get("src/math.ts")!;

  it("rebuilds the whole file section byte for byte", () => {
    const text = buildItemPatch(model, { path: "src/math.ts", hunks: "all" });
    expect(patch).toContain(text.trimEnd());
  });

  it("recomputes headers for slices", () => {
    const h = math.hunks[0]!;
    expect(sliceHunk(h, 2, 3).header).toBe("@@ -3 +3 @@");
    expect(sliceHunk(h, 5, 7).header).toBe("@@ -5,2 +5,3 @@");
    expect(sliceHunk(h, 6, 6).header).toBe("@@ -5,0 +6 @@");
    const added = model.byPath.get("test/math.test.ts")!.hunks[0]!;
    expect(sliceHunk(added, 1, 2).header).toBe("@@ -0,0 +2,2 @@");
  });

  it("produces patches that @pierre/diffs parses into the same lines", () => {
    const item = {
      path: "src/math.ts",
      hunks: [math.hunks[2]!.id],
      slices: [{ hunk: math.hunks[0]!.id, rows: [5, 7] as [number, number] }],
    };
    const parsed = parsePatchFiles(buildItemPatch(model, item), { throwOnError: true });
    const file = parsed[0]!.files[0]!;
    expect(file.name).toBe("src/math.ts");
    expect(file.hunks.map((h) => [h.deletionStart, h.deletionCount, h.additionStart, h.additionCount])).toEqual([
      [5, 2, 5, 3],
      [52, 7, 53, 7],
    ]);
    expect(file.additionLines.join("")).toContain("export const inserted = true;");
  });

  it("keeps no-newline markers in slices", () => {
    const nonl = model.byPath.get("src/nonl.ts")!;
    const text = buildItemPatch(model, { path: "src/nonl.ts", hunks: [], slices: [{ hunk: nonl.hunks[0]!.id, rows: [1, 2] }] });
    expect(text.match(/No newline/g)?.length).toBe(2);
    expect(() => parsePatchFiles(text, { throwOnError: true })).not.toThrow();
  });

  it("emits header-only patches for hunkless files", () => {
    const text = buildItemPatch(model, { path: "src/renamed-pure.ts", hunks: "all" });
    const file = parsePatchFiles(text, { throwOnError: true })[0]!.files[0]!;
    expect(file.type).toBe("rename-pure");
  });
});

describe("coverage and the remaining step", () => {
  it("puts everything in a remaining step when the guide is empty", () => {
    const r = ensureRemainingStep(review());
    expect(r.guide.steps).toHaveLength(1);
    expect(r.guide.steps[0]!.id).toBe(REMAINING_STEP_ID);
    expect(validateReview(r)).toMatchObject({ ok: true, errors: [] });
  });

  it("covers the gaps left by slices", () => {
    const model = parsePatch(patch);
    const h = model.byPath.get("src/math.ts")!.hunks[0]!;
    const base = review();
    const r = ensureRemainingStep({
      ...base,
      guide: {
        overview: "",
        generatedBy: "manual",
        steps: [
          { id: "s1", title: "One", narrative: "", items: [{ path: "src/math.ts", hunks: [], slices: [{ hunk: h.id, rows: [2, 3] }] }] },
        ],
      },
    });
    const remaining = r.guide.steps.at(-1)!;
    const mathItem = remaining.items.find((i) => i.path === "src/math.ts")!;
    expect(mathItem.slices).toEqual([
      { hunk: h.id, rows: [0, 1] },
      { hunk: h.id, rows: [4, 9] },
    ]);
    expect(validateReview(r).errors).toEqual([]);
  });

  it("reports duplicates and unknown hunks", () => {
    const model = parsePatch(patch);
    const h = model.byPath.get("src/math.ts")!.hunks[0]!;
    const report = coverage(
      {
        guide: {
          overview: "",
          generatedBy: "manual",
          steps: [
            { id: "a", title: "A", narrative: "", items: [{ path: "src/math.ts", hunks: [h.id] }] },
            { id: "b", title: "B", narrative: "", items: [{ path: "src/math.ts", hunks: [], slices: [{ hunk: h.id, rows: [0, 1] }] }] },
            { id: "c", title: "C", narrative: "", items: [{ path: "nope.ts", hunks: "all" }] },
          ],
        },
      },
      model,
    );
    expect(report.duplicated).toEqual([{ path: "src/math.ts", hunk: h.id, steps: ["a", "b"] }]);
    expect(report.unknown).toEqual([{ step: "c", path: "nope.ts" }]);
  });
});

describe("anchors", () => {
  const model = parsePatch(patch);

  it("anchors lines inside the diff and rejects others", () => {
    const a = makeLinesAnchor(model, { path: "src/math.ts", side: "new", start: 3, commit: "bbb" });
    expect(a.hunk).toBe(model.byPath.get("src/math.ts")!.hunks[0]!.id);
    expect(resolveAnchor(model, a).ok).toBe(true);
    expect(() => makeLinesAnchor(model, { path: "src/math.ts", side: "new", start: 20, commit: "bbb" })).toThrow(
      /not in the diff.*1-9/,
    );
  });

  it("relocates a fingerprinted range to the nearest match", () => {
    const lines = ["a", "b", "target", "c", "target", "d"];
    const fp = fingerprintLines(["target"]);
    expect(relocateRange(fp, 1, 4, (n) => lines[n - 1], lines.length)).toBe(5);
    expect(relocateRange(fp, 1, 2, (n) => lines[n - 1], lines.length)).toBe(3);
    expect(relocateRange(fingerprintLines(["zzz"]), 1, 2, (n) => lines[n - 1], lines.length)).toBeUndefined();
  });
});

describe("validation", () => {
  it("rejects bad shapes and broken anchors", () => {
    expect(validateReview({ version: 2 }).ok).toBe(false);
    const r = ensureRemainingStep(review());
    r.threads.push({
      id: "t1",
      source: "local",
      status: "open",
      anchor: { kind: "lines", path: "src/math.ts", side: "new", start: 30, end: 30, commit: "bbb", fingerprint: "x" },
      comments: [{ id: "c1", author: { name: "me", kind: "human" }, body: "hm", createdAt: "now" }],
    });
    const result = validateReview(r);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/Thread t1: Lines 30-30/);
  });

  it("requires dependsOn to point at earlier steps", () => {
    const r = ensureRemainingStep(review());
    r.guide.steps.unshift({ id: "first", title: "First", narrative: "", items: [], dependsOn: [REMAINING_STEP_ID] });
    expect(validateReview(r).errors).toContain('Step "first" depends on "remaining", which is not an earlier step');
  });
});

describe("json patch", () => {
  it("applies add, replace, remove and test", () => {
    const doc = { threads: [{ id: "a" }], state: { viewed: {} as Record<string, unknown> } };
    const out = applyJsonPatch(doc, [
      { op: "add", path: "/threads/-", value: { id: "b" } },
      { op: "add", path: "/state/viewed/h~1x", value: { at: "now" } },
      { op: "test", path: "/threads/0/id", value: "a" },
      { op: "remove", path: "/threads/0" },
    ]);
    expect(out).toEqual({ threads: [{ id: "b" }], state: { viewed: { "h/x": { at: "now" } } } });
    expect(doc.threads).toHaveLength(1);
    expect(() => applyJsonPatch(doc, [{ op: "test", path: "/threads/0/id", value: "z" }])).toThrow();
  });
});
