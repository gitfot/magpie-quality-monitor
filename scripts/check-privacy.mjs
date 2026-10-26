import { spawnSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import assert from "node:assert/strict";

const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  [
    "provider-key",
    /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/g,
  ],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["credential-url", /https?:\/\/[^\s/"'<>:@]+:[^\s/"'<>@]+@/g],
  [
    "personal-windows-path",
    /\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[^\\/\s"'<>]+/gi,
  ],
  [
    "personal-unix-path",
    /\/(?:home|Users)\/(?!example(?:\/|\b)|test(?:\/|\b))[^/\s"'<>]+/g,
  ],
  [
    "private-ip",
    /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  ],
];

// Audited artificial literals only; tests are not blanket-exempt from scanning.
const artificial = new Set([
  "mock-only",
  "fixture-private-key",
  "stale-token",
  "old-token",
  "test-key",
  "fake-key",
  "invalid-token",
  "expired-token",
  "mock-token",
  "local-key",
  "local-only",
  "dead",
  "wrong",
]);
const syntheticProviderKey = ["sk", "secret", "FIXTURE", "123456789"].join("-");
const sensitiveName =
  /(?:^|\/)(?:\.env(?:\.(?!example$).*)?|auth\.json|credentials?\.json|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|sqlite(?:-wal|-shm)?|db))$/i;

export function inspect(file, text) {
  const findings = [];
  const add = (rule, index = 0) => {
    const line = text.slice(0, index).split("\n").length;
    if (!findings.some((item) => item.rule === rule && item.line === line))
      findings.push({ file, line, rule });
  };
  if (sensitiveName.test(file)) add("sensitive-filename");
  if (text.includes("\0")) add("binary-review-required");
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (
        rule === "provider-key" &&
        file === "tests/codex-fixture.ts" &&
        match[0] === syntheticProviderKey
      )
        continue;
      add(rule, match.index);
    }
  }
  for (const match of text.matchAll(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  )) {
    if (
      !/@(?:users\.noreply\.github\.com|example\.(?:com|org|net))$/i.test(
        match[0],
      )
    )
      add("personal-email", match.index);
  }
  for (const match of text.matchAll(
    /\b(?:[a-z][a-z0-9]*_)*(?:api[_-]?key|secret|password|token|authorization|key)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi,
  )) {
    const value = match[1].trim(),
      credential = value.replace(/^Bearer\s+/i, "");
    const fixtureValue =
      file.startsWith("tests/") && artificial.has(credential);
    if (
      value &&
      !fixtureValue &&
      value !== "Bearer" &&
      !value.includes("${") &&
      !/^[01]$/.test(value)
    )
      add("credential-literal-review", match.index);
  }
  if (
    file === "page/index.html" &&
    /(?:https?:\/\/(?:127\.0\.0\.1|localhost):\d+|[a-f0-9]{64})/i.test(text)
  )
    add("generated-runtime-entry");
  return findings;
}

function selfTest() {
  const checks = [
    ["x.txt", "ghp_" + "A".repeat(40), "provider-key"],
    ["x.txt", "sk-proj-" + "A".repeat(30), "provider-key"],
    ["x.txt", ["-----BEGIN", "PRIVATE KEY-----"].join(" "), "private-key"],
    [
      "x.txt",
      ["https://", "someone", ":", "credential", "@example.com"].join(""),
      "credential-url",
    ],
    [
      "x.txt",
      ["C:", "Users", "sample-user", "private"].join("\\"),
      "personal-windows-path",
    ],
    ["x.txt", ["192", "168", "4", "5"].join("."), "private-ip"],
    [".env", "ordinary text", "sensitive-filename"],
    [
      "page/index.html",
      ["http://127.0.0.1:", "4321/#", "a".repeat(64)].join(""),
      "generated-runtime-entry",
    ],
    [
      "x.txt",
      'apiKey: "' + "unreviewed" + '-credential"',
      "credential-literal-review",
    ],
  ];
  for (const [file, text, rule] of checks)
    assert.ok(
      inspect(file, text).some((item) => item.rule === rule),
      rule,
    );
  assert.deepEqual(
    inspect(
      "tests/example.ts",
      [
        "key",
        ": ",
        JSON.stringify("mock-only"),
        "; ",
        "token",
        ": ",
        JSON.stringify("stale-token"),
      ].join(""),
    ),
    [],
  );
  assert.deepEqual(inspect("tests/codex-fixture.ts", syntheticProviderKey), []);
  assert.ok(
    inspect("unreviewed.ts", syntheticProviderKey).some(
      (item) => item.rule === "provider-key",
    ),
  );
  assert.deepEqual(
    inspect("page/index.html", "<!doctype html><p>Starting monitor</p>"),
    [],
  );
  assert.deepEqual(inspect("README.md", "gitfot@users.noreply.github.com"), []);
  const redacted = inspect("x.txt", "ghp_" + "A".repeat(40));
  assert.equal(JSON.stringify(redacted).includes("A".repeat(40)), false);
  console.log(
    `Privacy scanner self-tests passed (${checks.length + 6} checks).`,
  );
}

function git(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw Error(
      `Cannot read Git ${args[0]}; run from the repository root with Git available.`,
    );
  return result.stdout;
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (
    process.argv
      .slice(2)
      .some((arg) => !["--staged", "--worktree"].includes(arg))
  )
    throw Error("Usage: check-privacy.mjs [--staged|--worktree|--self-test]");
  const staged = process.argv.includes("--staged");
  const root = resolve(git(["rev-parse", "--show-toplevel"]).trim());
  const files = [
    ...new Set(
      git(
        staged
          ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
          : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
  if (!files.length)
    throw Error(
      "No files to scan; stage the intended files before a staged check.",
    );
  const findings = [];
  for (const file of files) {
    const path = resolve(root, file);
    if (
      isAbsolute(relative(root, path)) ||
      relative(root, path).startsWith("..")
    )
      throw Error("Git returned a path outside the repository.");
    if (!staged && lstatSync(path).isSymbolicLink()) {
      findings.push({ file, line: 1, rule: "symlink-review-required" });
      continue;
    }
    const text = staged
      ? git(["show", `:${file}`])
      : readFileSync(path, "utf8");
    findings.push(...inspect(file, text));
  }
  console.log(
    `Privacy scan: ${files.length} ${staged ? "staged" : "working-tree"} files; ${findings.length} findings.`,
  );
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line} [${finding.rule}]`);
  if (findings.length) process.exitCode = 1;
  else
    console.log(
      "No configured-rule findings. Manually review the release scope and public Git author identity.",
    );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
