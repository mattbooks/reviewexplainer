/**
 * Minimal RFC 6902 JSON Patch (add, remove, replace, test) used by the viewer
 * to send edits to `greview serve`. Returns a new document; the input is not
 * mutated.
 */
export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "test"; path: string; value: unknown };

export function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`Invalid JSON pointer "${path}"`);
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function pointer(...segments: (string | number)[]): string {
  return segments.map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function applyJsonPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  const root = { value: clone(doc) as unknown };
  for (const op of ops) {
    const segs = parsePointer(op.path);
    if (segs.length === 0) {
      if (op.op === "test") {
        if (JSON.stringify(root.value) !== JSON.stringify(op.value)) throw new Error("test failed at root");
        continue;
      }
      if (op.op === "remove") throw new Error("Cannot remove the root");
      root.value = clone(op.value);
      continue;
    }
    let parent: any = root.value;
    for (const s of segs.slice(0, -1)) {
      parent = Array.isArray(parent) ? parent[Number(s)] : parent?.[s];
      if (parent === undefined || parent === null) throw new Error(`Path not found: ${op.path}`);
    }
    const key = segs[segs.length - 1]!;
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) {
        throw new Error(`Bad array index in ${op.path}`);
      }
      if (op.op === "add") parent.splice(index, 0, clone(op.value));
      else if (op.op === "replace") {
        if (index >= parent.length) throw new Error(`Path not found: ${op.path}`);
        parent[index] = clone(op.value);
      } else if (op.op === "remove") {
        if (index >= parent.length) throw new Error(`Path not found: ${op.path}`);
        parent.splice(index, 1);
      } else if (JSON.stringify(parent[index]) !== JSON.stringify(op.value)) {
        throw new Error(`test failed at ${op.path}`);
      }
    } else {
      if (typeof parent !== "object") throw new Error(`Path not found: ${op.path}`);
      if (op.op === "add") parent[key] = clone(op.value);
      else if (op.op === "replace") {
        if (!(key in parent)) throw new Error(`Path not found: ${op.path}`);
        parent[key] = clone(op.value);
      } else if (op.op === "remove") {
        if (!(key in parent)) throw new Error(`Path not found: ${op.path}`);
        delete parent[key];
      } else if (JSON.stringify(parent[key]) !== JSON.stringify(op.value)) {
        throw new Error(`test failed at ${op.path}`);
      }
    }
  }
  return root.value as T;
}
