import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ContextMonitorService } from "./context-monitor-service.js";
import type { ContextDashboard } from "./context-types.js";
import { RolloutContextProvider } from "./providers/rollout-context-provider.js";
import { SessionRegistry } from "./providers/session-registry.js";
import { startDashboard } from "./dashboard-server.js";
import { autoStartProjectMonitor } from "./auto-start.js";

const VERSION = "0.4.1";
const TEMPLATE_URI = "ui://context-window-monitor/v1.html";
const UI_SCRIPT_PATH = fileURLToPath(
  new URL("./ui/context-details-panel.js", import.meta.url),
);

const registry = new SessionRegistry();
const provider = new RolloutContextProvider(registry);
const monitor = new ContextMonitorService(provider);
const server = new McpServer(
  { name: "context-window-monitor", version: VERSION },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      "Use show_context_monitor for visual context-window status. Values come from Codex token events; never call cumulative usage the active context size.",
  },
);
let localDashboard:ReturnType<typeof startDashboard>|undefined;

function dashboardText(dashboard: ContextDashboard): string {
  const { usage } = dashboard;
  if (usage.usedTokens === null) {
    return `Context: unavailable (${usage.precisionDetail})`;
  }

  const lines = [
    "Context Usage",
    `Used: ${usage.usedTokens.toLocaleString()} tokens`,
    `Total: ${usage.totalTokens?.toLocaleString() ?? "Unavailable"}${usage.totalTokens === null ? "" : " tokens"}`,
    `Remaining: ${usage.remainingTokens?.toLocaleString() ?? "Unavailable"}${usage.remainingTokens === null ? "" : " tokens"}`,
    `Usage: ${usage.percentage === null ? "Unavailable" : `${usage.percentage.toFixed(1)}%`}`,
    `Status: ${usage.health}`,
    `Precision: ${usage.precision} — ${usage.precisionDetail}`,
    `Model: ${usage.model ?? "Unknown"}`,
  ];

  if (dashboard.compactions[0]) {
    const latest = dashboard.compactions[0];
    lines.push(
      `Latest compaction: ${latest.timestamp} (${latest.trigger}; reduced ${latest.reducedTokens?.toLocaleString() ?? "Unavailable"} tokens)`,
    );
  }
  return lines.join("\n");
}

async function readDashboard(sessionId?: string): Promise<ContextDashboard> {
  return monitor.dashboard(sessionId);
}

server.registerResource("context-window-monitor-ui", TEMPLATE_URI, {}, async () => {
  const script = await fs.readFile(UI_SCRIPT_PATH, "utf8");
  return {
    contents: [
      {
        uri: TEMPLATE_URI,
        mimeType: "text/html;profile=mcp-app",
        text: `<div id="root"></div><script type="module">${script}</script>`,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  };
});

const sessionInput = {
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional exact Codex session ID. Omit to use the active hooked session."),
};
function compactDashboard(dashboard:ContextDashboard):ContextDashboard {
  const compact={...dashboard};delete compact.snapshots;delete compact.activity;return compact;
}

server.registerTool(
  "get_context_usage",
  {
    title: "Get context usage",
    description:
      "Read the latest exact token-usage snapshot for a Codex session without rendering UI.",
    inputSchema: {...sessionInput,details:z.boolean().optional().describe("Include retained snapshot and activity metadata for interactive UI. Omit for a compact answer.")},
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  async ({ sessionId,details }) => {
    const dashboard = await readDashboard(sessionId);
    return {
      structuredContent: details?dashboard:compactDashboard(dashboard),
      content: [{ type: "text", text: dashboardText(dashboard) }],
    };
  },
);

server.registerTool(
  "show_context_monitor",
  {
    title: "Show context window monitor",
    description:
      "Open the black Codex context dashboard with exact usage, trends, recorded tool activity and compaction. Returns a local dashboard URL for the Codex browser panel and an optional MCP Apps resource.",
    inputSchema: sessionInput,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
    _meta: {
      ui: { resourceUri: TEMPLATE_URI },
      "openai/outputTemplate": TEMPLATE_URI,
      "openai/toolInvocation/invoking": "Reading Codex context usage…",
      "openai/toolInvocation/invoked": "Context usage ready.",
    },
  },
  async ({ sessionId }) => {
    const dashboard = await readDashboard(sessionId);
    localDashboard??=startDashboard(monitor,provider);
    const local=await localDashboard;
    const dashboardUrl=`${local.url}${dashboard.usage.sessionId?`?session=${encodeURIComponent(dashboard.usage.sessionId)}`:""}`;
    return {
      structuredContent: compactDashboard(dashboard),
      content: [{ type: "text", text: `${dashboardText(dashboard)}\nDashboard: ${dashboardUrl}` }],
      _meta: {
        dashboardUrl,
        dashboard,
        ui: { resourceUri: TEMPLATE_URI },
        "openai/outputTemplate": TEMPLATE_URI,
      },
    };
  },
);

server.registerTool(
  "list_context_sessions",
  {
    title: "List monitored context sessions",
    description:
      "List recently hooked Codex sessions so an exact session can be selected when several are active.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(10),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  async ({ limit }) => {
    const sessions = (await provider.listSessions(limit)).map((session) => ({
      sessionId: session.sessionId,
      model: session.model,
      lastSeenAt: session.lastSeenAt,
      active: session.active,
      parentSessionId:session.parentSessionId,
      agentName:session.agentName,
    }));
    return {
      structuredContent: { sessions },
      content: [
        {
          type: "text",
          text: sessions.length
            ? sessions
                .map(
                  (session) =>
                    `${session.sessionId} · ${session.model ?? "unknown model"} · ${session.lastSeenAt}`,
                )
                .join("\n")
            : "No hooked Codex sessions are available.",
        },
      ],
    };
  },
);

server.registerTool("read_context_item",{
  title:"Read a recorded context item",
  description:"Reveal one explicitly selected local Codex log item. Call only when the user asks to read its original content. It is not a full model request; encrypted reasoning is excluded.",
  inputSchema:{sessionId:z.string().min(1),itemId:z.string().min(1),confirmReveal:z.literal(true)},
  annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false},
},async({sessionId,itemId})=>{
  const item=await provider.readItem(sessionId,itemId);
  return {structuredContent:item,content:[{type:"text",text:JSON.stringify(item)}]};
});

await server.connect(new StdioServerTransport());
autoStartProjectMonitor();
process.stdin.on("end",()=>{void localDashboard?.then(d=>d.close());});
