import { spawnSync } from "node:child_process";

// Workers Builds currently uploads immediately after npm ci, with no separate
// build command. Compile here so Wrangler can follow Vite's generated deploy
// config. Local installs and GitHub CI keep their explicit build step.
// https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables
if (process.env.WORKERS_CI === "1") {
  console.log("[postinstall] Building the application for Cloudflare Workers upload.");
  const packageManager = process.env.npm_execpath;
  const result = spawnSync(
    packageManager ? process.execPath : "npm",
    packageManager ? [packageManager, "run", "build"] : ["run", "build"],
    { stdio: "inherit", shell: !packageManager && process.platform === "win32" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
