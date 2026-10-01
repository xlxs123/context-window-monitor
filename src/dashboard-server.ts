import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ContextMonitorService } from "./context-monitor-service.js";
import type { RolloutContextProvider } from "./providers/rollout-context-provider.js";

/** Local UI for Codex hosts without inline MCP Apps. Random capability path, no public listener. */
export async function startDashboard(monitor:ContextMonitorService,provider:RolloutContextProvider,projectStatus?:()=>unknown){
  const capability=randomBytes(24).toString("hex");const prefix=`/${capability}/`;
  const script=await readFile(new URL("./ui/context-details-panel.js",import.meta.url),"utf8");
  const server=createServer(async(req,res)=>{
    const address=server.address();if(!address||typeof address==="string"){res.writeHead(503).end();return;}
    const host=`127.0.0.1:${address.port}`;
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
    if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==`http://${host}`)||req.headers["sec-fetch-site"]==="cross-site"){res.writeHead(403).end();return;}
    const url=new URL(req.url??"/",`http://${host}`);
    if(!url.pathname.startsWith(prefix)){res.writeHead(404).end();return;}
    const relative=url.pathname.slice(prefix.length);
    if(req.method==="GET"&&relative==="health"){
      res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({application:"context-window-monitor",version:"0.4.3",pid:process.pid,projectIntegration:projectStatus?.()}));return;
    }
    if(req.method==="GET"&&relative===""){
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}).end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 上下文监控</title><link rel="icon" href="data:,"></head><body><div id="root" data-local-dashboard="true"></div><script type="module" src="app.js"></script></body></html>');return;
    }
    if(req.method==="GET"&&relative==="app.js"){res.writeHead(200,{"Content-Type":"application/javascript"}).end(script);return;}
    if(req.method!=="POST"||relative!=="api"){res.writeHead(404).end();return;}
    try{
      let body="";for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8192){res.writeHead(413).end();return;}}
      const data=JSON.parse(body);const args=data.arguments??{};let value:unknown;
      if(data.name==="get_context_usage")value=await monitor.dashboard(typeof args.sessionId==="string"?args.sessionId:undefined);
      else if(data.name==="list_context_sessions")value={sessions:await provider.listSessions(20)};
      else if(data.name==="read_context_item"&&args.confirmReveal===true&&typeof args.sessionId==="string"&&typeof args.itemId==="string")value=await provider.readItem(args.sessionId,args.itemId);
      else throw new Error("Unsupported operation");
      res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({structuredContent:value}));
    }catch(e){res.writeHead(400,{"Content-Type":"application/json"}).end(JSON.stringify({error:String(e)}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve());});
  const address=server.address();if(!address||typeof address==="string")throw new Error("No local dashboard address");
  return {url:`http://127.0.0.1:${address.port}${prefix}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
