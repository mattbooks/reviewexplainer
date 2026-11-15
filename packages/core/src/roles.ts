import type { FileRole } from "@reviewexplainer/format";

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "Podfile.lock",
  "packages.lock.json",
]);

const GENERATED = [
  /(^|\/)(dist|build|out|gen|generated|__generated__)\//,
  /\.generated\.\w+$/,
  /\.gen\.\w+$/,
  /_pb2(_grpc)?\.py$/,
  /\.pb\.(go|cc|h)$/,
  /\.min\.(js|css)$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

const VENDORED = [/(^|\/)(vendor|third_party|third-party|node_modules)\//];

const TESTS = [
  /(^|\/)(test|tests|__tests__|spec|specs|e2e|testdata|fixtures)\//,
  /\.(test|spec)\.\w+$/,
  /_test\.(go|py|rb|exs?)$/,
  /(^|\/)test_[^/]+\.py$/,
  /Tests?\.(cs|java|kt|swift)$/,
];

const DOCS = [/\.(md|mdx|rst|adoc|txt)$/i, /(^|\/)(docs?|documentation)\//, /(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i];

const CONFIG = [
  /(^|\/)\.[^/]+rc(\.\w+)?$/,
  /(^|\/)\.github\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)(Dockerfile|Makefile|Procfile|Justfile)[^/]*$/,
  /(^|\/)(package|tsconfig[^/]*|jsconfig|deno|composer|app)\.json$/,
  /(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|Cargo\.toml|go\.mod|Gemfile|requirements[^/]*\.txt)$/,
  /\.(ya?ml|toml|ini|cfg|conf|env|properties)$/,
  /(^|\/)[^/]*\.config\.(js|cjs|mjs|ts)$/,
  /(^|\/)\.gitignore$|(^|\/)\.gitattributes$|(^|\/)\.editorconfig$/,
];

export function roleForPath(path: string, attrs?: Set<string>): FileRole {
  const base = path.split("/").pop() ?? path;
  if (LOCKFILES.has(base)) return "lockfile";
  if (attrs?.has("linguist-vendored") || VENDORED.some((r) => r.test(path))) return "vendored";
  if (attrs?.has("linguist-generated") || GENERATED.some((r) => r.test(path))) return "generated";
  if (TESTS.some((r) => r.test(path))) return "test";
  if (attrs?.has("linguist-documentation") || DOCS.some((r) => r.test(path))) return "docs";
  if (CONFIG.some((r) => r.test(path))) return "config";
  return "source";
}

/** Paths that usually hold data shapes: read these before the code using them. */
export function isDefinitionPath(path: string): boolean {
  return (
    /\.d\.ts$/.test(path) ||
    /\.(proto|graphql|gql|prisma|thrift|avsc|sql)$/.test(path) ||
    /(^|\/)(types?|schemas?|models?|interfaces?|entities|dto|migrations?)(\/|\.\w+$)/i.test(path)
  );
}
