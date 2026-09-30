import { mkdir } from "node:fs/promises";

import { build } from "esbuild";

await Promise.all([
  mkdir("runtime", { recursive: true }),
  mkdir("runtime/core", { recursive: true }),
  mkdir("runtime/ui", { recursive: true }),
]);

const shared = {
  bundle: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  target: "node22",
};

await Promise.all([
  build({...shared,entryPoints:["src/open-dashboard.ts"],outfile:"runtime/open-dashboard.mjs",platform:"node",format:"esm"}),
  build({...shared,entryPoints:["src/dashboard.ts"],outfile:"runtime/dashboard.mjs",platform:"node",format:"esm"}),
  build({
    ...shared,
    entryPoints: ["src/mcp-server.ts"],
    outfile: "runtime/mcp-server.mjs",
    platform: "node",
    format: "esm",
  }),
  build({
    ...shared,
    entryPoints: ["src/context-hook.ts"],
    outfile: "runtime/context-hook.mjs",
    platform: "node",
    format: "esm",
  }),
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "runtime/core/index.mjs",
    platform: "node",
    format: "esm",
  }),
  build({
    bundle: true,
    entryPoints: ["src/ui/context-details-panel.ts"],
    outfile: "runtime/ui/context-details-panel.js",
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
  }),
]);
