import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Runs at plugin initialization, not in response to a model/tool request. */
export function autoStartProjectMonitor(): void {
  if (process.env.CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS === "1") return;
  execFile(process.execPath, [fileURLToPath(new URL("./open-dashboard.mjs", import.meta.url)), "--ensure"], {
    windowsHide: true, timeout: 15_000,
  }, error => {
    if (error) process.stderr.write("Context monitor: automatic project integration could not start. Check Node.js 22.13+ and the local project registry.\n");
  });
}
