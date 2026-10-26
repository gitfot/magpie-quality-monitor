import { spawnSync } from "node:child_process";
const run = spawnSync(process.env.MAGPIE_BUN || "bun", process.argv.slice(2), {
  stdio: "inherit",
});
if (run.error)
  console.error(
    "Set MAGPIE_BUN to the installed Bun executable:",
    run.error.message,
  );
process.exit(run.status ?? 1);
