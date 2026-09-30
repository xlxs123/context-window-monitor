import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Runs at plugin initialization, not in response to a model/tool request. */
export function autoStartProjectMonitor(): void {
  if (process.env.CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS === "1") return;
  execFile(process.execPath, [fileURLToPath(new URL("./open-dashboard.mjs", import.meta.url)), "--ensure"], {
    windowsHide: true, timeout: 30_000,
  }, error => {
    if (error) process.stderr.write("Context monitor: automatic startup could not finish. Check Node.js 22.13+ and the tray entry.\n");
  });
}
