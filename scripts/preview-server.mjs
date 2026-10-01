import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { previewDashboard } from "./preview-data.mjs";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.CONTEXT_MONITOR_PREVIEW_PORT ?? "4174", 10);
const [script, fixtureText] = await Promise.all([
  readFile(new URL("../runtime/ui/context-details-panel.js", import.meta.url), "utf8"),
  readFile(new URL("../test/fixtures/exact-dashboard.json", import.meta.url), "utf8"),
]);
const fixture=previewDashboard(JSON.parse(fixtureText));

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Context Monitor · 演示数据</title><link rel="icon" href="data:,"></head>
<body>
<div id="root"></div>
<script>window.__CONTEXT_MONITOR_PREVIEW__=${JSON.stringify(fixture).replaceAll("<","\\u003c")};</script>
<script type="module">${script}</script>
</body></html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
});

server.listen(port, host, () => {
  console.log(`Context Window Monitor preview: http://${host}:${port}`);
});
