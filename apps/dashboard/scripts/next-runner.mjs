import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mode = process.argv[2] ?? "dev";
const port = process.env.DASHBOARD_PORT ?? "5000";
const nextCli = require.resolve("next/dist/bin/next");

const args = [nextCli, mode];
if (mode !== "build") {
  args.push("-p", port);
}

const child = spawn(process.execPath, args, {
  stdio: "inherit"
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
