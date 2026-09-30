import { ContextMonitorService } from "./context-monitor-service.js";
import { RolloutContextProvider } from "./providers/rollout-context-provider.js";
import { startDashboard } from "./dashboard-server.js";
const provider=new RolloutContextProvider();
const server=await startDashboard(new ContextMonitorService(provider),provider);
const session=process.argv[2];
console.log(`${server.url}${session?`?session=${encodeURIComponent(session)}`:""}`);
for(const event of ["SIGINT","SIGTERM"] as const)process.on(event,()=>{void server.close().then(()=>process.exit(0));});
