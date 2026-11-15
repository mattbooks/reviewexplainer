/**
 * A stand-in for agent-safehouse, which only runs on macOS. It records its
 * arguments, then runs the command after `--` with only the environment
 * variables named by --env-pass (plus PATH), like safehouse's sanitized
 * environment. It does not enforce filesystem rules: tests that need those
 * check the arguments instead.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeSafehouse {
  command: string;
  calls(): { args: string[]; cwd: string }[];
}

export function fakeSafehouse(dir: string): FakeSafehouse {
  const log = join(dir, "safehouse-calls.jsonl");
  const command = join(dir, "safehouse");
  writeFileSync(
    command,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const sep = args.indexOf("--");
if (sep < 0) { console.error("safehouse: missing --"); process.exit(2); }
const pass = (args.find((a) => a.startsWith("--env-pass=")) || "--env-pass=").slice(11).split(",").filter(Boolean);
const env = { PATH: process.env.PATH };
for (const n of pass) if (process.env[n] !== undefined) env[n] = process.env[n];
const [cmd, ...rest] = args.slice(sep + 1);
const r = spawnSync(cmd, rest, { stdio: "inherit", env });
process.exit(r.status === null ? 137 : r.status);
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}
