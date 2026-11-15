import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function write(root: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function commit(root: string, message: string): string {
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", message);
  return sh(root, "rev-parse", "HEAD").trim();
}

const numbered = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `export const ${prefix}${i + 1} = ${i + 1};`).join("\n");

/**
 * A small TypeScript project: base on main, a feature branch that changes
 * types, a service using them, an API using the service, tests, docs, a
 * lockfile and a generated file.
 */
export function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "greview-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "test@example.com");
  sh(root, "config", "user.name", "Test");
  write(root, {
    "src/types.ts": "export interface User {\n  id: string;\n  name: string;\n}\n",
    "src/service.ts": `import type { User } from "./types";\n\nexport function greet(u: User): string {\n  return "hi " + u.name;\n}\n${numbered("pad", 30)}\n`,
    "src/api.ts": 'import { greet } from "./service";\n\nexport function handler(name: string) {\n  return greet({ id: "1", name });\n}\n',
    "src/standalone.ts": "export const flag = false;\n",
    "test/service.test.ts": 'import { greet } from "../src/service";\n',
    "README.md": "# demo\n",
    "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
    "src/gen/client.generated.ts": "export const generated = 1;\n",
  });
  commit(root, "base");
  sh(root, "checkout", "-q", "-b", "feature");
  write(root, {
    "src/types.ts": "export interface User {\n  id: string;\n  name: string;\n  email?: string;\n}\n",
    "src/service.ts": `import type { User } from "./types";\n\nexport function greet(u: User): string {\n  return "hello " + u.name + (u.email ? " <" + u.email + ">" : "");\n}\n${numbered("pad", 30).replace("pad20 = 20", "pad20 = 2000")}\n`,
    "src/api.ts": 'import { greet } from "./service";\n\nexport function handler(name: string, email?: string) {\n  return greet({ id: "1", name, email });\n}\n',
    "src/standalone.ts": "export const flag = true;\n",
    "test/service.test.ts": 'import { greet } from "../src/service";\n\ntest("greets", () => expect(greet({ id: "1", name: "a" })).toBe("hello a"));\n',
    "README.md": "# demo\n\nNow with emails.\n",
    "package-lock.json": '{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
    "src/gen/client.generated.ts": "export const generated = 2;\n",
  });
  commit(root, "feature");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
