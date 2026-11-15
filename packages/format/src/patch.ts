/**
 * A small, dependency-free parser for git unified diffs. It keeps the raw
 * header and hunk lines so sub-patches can be rebuilt byte-for-byte, and gives
 * every hunk a content-hashed id that survives line shifts.
 */
import { sha1Hex } from "./sha1.ts";
import type { FileEntry, FileStatus, HunkRecord } from "./schema.ts";

export type RowType = "context" | "add" | "del";

export interface Row {
  type: RowType;
  text: string;
  /** Line number on the old side (context and deletions). */
  oldLine?: number;
  /** Line number on the new side (context and additions). */
  newLine?: number;
  /** The line is followed by a "\ No newline at end of file" marker. */
  noNewline?: boolean;
}

export interface ParsedHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context: string;
  /** Raw body lines, including their prefix and any "\" markers. */
  lines: string[];
  rows: Row[];
}

export interface ParsedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  /** Raw lines before the first hunk (diff --git, index, ---, +++ ...). */
  headerLines: string[];
  hunks: ParsedHunk[];
}

export interface PatchModel {
  files: ParsedFile[];
  byPath: Map<string, ParsedFile>;
  hunkById: Map<string, { file: ParsedFile; hunk: ParsedHunk; index: number }>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\t/g, "\t");
  }
  return p;
}

function stripPrefix(p: string): string | null {
  const clean = unquote(p.trim().split("\t")[0]!);
  if (clean === "/dev/null") return null;
  return clean.replace(/^[ab]\//, "");
}

export function hunkIdFor(path: string, lines: string[]): string {
  return sha1Hex(`${path}\n${lines.join("\n")}`).slice(0, 10);
}

function buildRows(h: Omit<ParsedHunk, "rows" | "id">): Row[] {
  const rows: Row[] = [];
  let oldLine = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
  let newLine = h.newCount === 0 ? h.newStart + 1 : h.newStart;
  for (const raw of h.lines) {
    const prefix = raw[0];
    const text = raw.slice(1);
    if (prefix === "\\") {
      const last = rows[rows.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    if (prefix === "+") {
      rows.push({ type: "add", text, newLine: newLine++ });
    } else if (prefix === "-") {
      rows.push({ type: "del", text, oldLine: oldLine++ });
    } else {
      rows.push({ type: "context", text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return rows;
}

export function parsePatch(patch: string): PatchModel {
  const lines = patch.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files: ParsedFile[] = [];
  let file: ParsedFile | null = null;
  let hunk: Omit<ParsedHunk, "rows" | "id"> | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let pendingOld: string | null | undefined;
  let pendingNew: string | null | undefined;

  const finishHunk = () => {
    if (file && hunk) {
      file.hunks.push({ ...hunk, id: "", rows: buildRows(hunk) });
    }
    hunk = null;
  };
  const finishFile = () => {
    finishHunk();
    if (file) {
      if (pendingOld !== undefined || pendingNew !== undefined) {
        const oldP = pendingOld ?? null;
        const newP = pendingNew ?? null;
        if (newP) file.path = newP;
        else if (oldP) file.path = oldP;
        if (oldP && newP && oldP !== newP && !file.oldPath) file.oldPath = oldP;
        if (oldP === null && newP) file.status = "added";
        if (newP === null && oldP) file.status = "deleted";
      }
      if (file.oldPath && file.status === "modified") file.status = "renamed";
      files.push(file);
    }
    file = null;
    pendingOld = undefined;
    pendingNew = undefined;
  };
  const startFile = (path: string): ParsedFile => ({
    path,
    status: "modified",
    binary: false,
    headerLines: [],
    hunks: [],
  });

  for (const line of lines) {
    if (hunk && (oldRemaining > 0 || newRemaining > 0 || line.startsWith("\\"))) {
      const p = line[0];
      if (p === "\\") {
        hunk.lines.push(line);
        continue;
      }
      if (p === " " || p === "+" || p === "-" || line === "") {
        const normalized = line === "" ? " " : line;
        hunk.lines.push(normalized);
        if (normalized[0] !== "+") oldRemaining--;
        if (normalized[0] !== "-") newRemaining--;
        continue;
      }
    }
    if (line.startsWith("diff --git ")) {
      finishFile();
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = startFile(m ? unquote(m[2]!) : line.slice(11));
      if (m && m[1] !== m[2]) file.oldPath = unquote(m[1]!);
      file.headerLines.push(line);
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (!file) file = startFile("unknown");
      finishHunk();
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        oldCount,
        newStart: Number(header[3]),
        newCount,
        context: header[5] ?? "",
        lines: [],
      };
      oldRemaining = oldCount;
      newRemaining = newCount;
      continue;
    }
    if (line.startsWith("--- ") && (!file || file.hunks.length > 0 || hunk)) {
      // A plain (non-git) diff: each "---" starts a new file.
      finishFile();
      file = startFile("unknown");
    }
    if (!file) continue;
    finishHunk();
    file.headerLines.push(line);
    if (line.startsWith("--- ")) pendingOld = stripPrefix(line.slice(4));
    else if (line.startsWith("+++ ")) pendingNew = stripPrefix(line.slice(4));
    else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) file.oldPath = unquote(line.slice(12));
    else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
    else if (line.startsWith("copy from ")) file.oldPath = unquote(line.slice(10));
    else if (line.startsWith("copy to ")) file.path = unquote(line.slice(8));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
  }
  finishFile();

  const byPath = new Map<string, ParsedFile>();
  const hunkById = new Map<string, { file: ParsedFile; hunk: ParsedHunk; index: number }>();
  for (const f of files) {
    byPath.set(f.path, f);
    const seen = new Map<string, number>();
    f.hunks.forEach((h, index) => {
      const base = hunkIdFor(f.path, h.lines);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      h.id = n === 1 ? base : `${base}-${n}`;
      hunkById.set(h.id, { file: f, hunk: h, index });
    });
  }
  return { files, byPath, hunkById };
}

export function hunkRecord(h: ParsedHunk): HunkRecord {
  return {
    id: h.id,
    header: h.header,
    oldStart: h.oldStart,
    oldCount: h.oldCount,
    newStart: h.newStart,
    newCount: h.newCount,
    rows: h.rows.length,
  };
}

export function fileEntries(model: PatchModel): FileEntry[] {
  return model.files.map((f) => {
    const entry: FileEntry = { path: f.path, status: f.status, hunks: f.hunks.map(hunkRecord) };
    if (f.oldPath) entry.oldPath = f.oldPath;
    if (f.binary) entry.binary = true;
    return entry;
  });
}

/** Text of a file's section of the patch, header included. */
export function filePatchText(file: ParsedFile, hunks: { header: string; lines: string[] }[] = file.hunks): string {
  const out = [...file.headerLines];
  for (const h of hunks) out.push(h.header, ...h.lines);
  return `${out.join("\n")}\n`;
}

/** Lines known from the patch for one side of a file, keyed by line number. */
export function knownLines(file: ParsedFile, side: "old" | "new"): Map<number, string> {
  const map = new Map<number, string>();
  for (const h of file.hunks) {
    for (const r of h.rows) {
      const n = side === "old" ? r.oldLine : r.newLine;
      if (n !== undefined) map.set(n, r.text);
    }
  }
  return map;
}
