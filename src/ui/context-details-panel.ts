import type {ActivityItem,ContextDashboard,RawContextSnapshot} from "../context-types.js";
import {styles} from "./styles.js";
declare global {interface Window {openai?:{toolOutput?:unknown;callTool?:(name:string,args:Record<string,unknown>)=>Promise<unknown>};__CONTEXT_MONITOR_PREVIEW__?:unknown}}
type Page="overview"|"timeline"|"records"|"sources"|"tools"|"agents"|"compaction"|"compare"|"settings";
interface Session {sessionId:string;model:string|null;parentSessionId?:string|null;agentName?:string|null}
const tabs:Record<Page,string>={overview:"总览",timeline:"时间线",records:"上下文记录",sources:"来源分析",tools:"工具与文件",agents:"Agent 网络",compaction:"压缩",compare:"快照对比",settings:"设置"};
const labels:Record<string,string>={system:"系统提示词",developer:"开发者指令",user:"用户消息",assistant:"助手消息",reasoning:"公开思考摘要",tool_call:"工具参数",tool_result:"工具结果",compaction:"压缩记录",other:"其他记录"};
const colors:Record<string,string>={system:"#9585d9",developer:"#bd94db",user:"#6eafa1",assistant:"#829fd1",reasoning:"#af92cd",tool_call:"#cfb374",tool_result:"#6ba99f",compaction:"#be8d92",other:"#868896"};
const esc=(v:unknown):string=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"?v as Record<string,unknown>:null;
const num=(v:number|null|undefined):string=>(v===null||v===undefined)?"Unavailable":v.toLocaleString("en-US");
const short=(v:number|null|undefined):string=>(v===null||v===undefined)?"—":v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1e3?`${(v/1e3).toFixed(1)}k`:String(v);
const time=(v:string|null|undefined):string=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleTimeString("zh-CN",{hour12:false}):"—";
const signed=(v:number|null):string=>v===null?"—":`${v>0?"+":""}${short(v)}`;
const empty=(s:string):string=>`<div class="empty">${esc(s)}</div>`;
const card=(title:string,body:string,note="",extra=""):string=>`<section class="card ${extra}"><div class="card-head"><h3>${esc(title)}</h3><small>${esc(note)}</small></div>${body}</section>`;
function isDashboard(v:unknown):v is ContextDashboard {const r=obj(v);return r?.schemaVersion===1&&!!obj(r.usage)&&Array.isArray(r.recentChanges);}
type Segment={name:string;value:number|null;color:string};
function ring(values:Segment[],total:string,label:string):string{
  const sum=values.reduce((n,v)=>n+Math.max(0,v.value??0),0);let start=0;
  const segments=values.map(v=>{const from=start;start+=sum?Math.max(0,v.value??0)/sum*100:0;return `${v.color} ${from}% ${start}%`;});
  return `<div class="ring" role="img" aria-label="${esc(label)} ${esc(total)}" style="background:${sum?`conic-gradient(${segments.join(",")})`:"#2b2b33"}"><div><strong>${esc(total)}</strong><small>${esc(label)}</small></div></div>`;
}
function legend(values:Segment[],note:string):string{return `<div class="legend">${values.map(v=>`<span><i class="dot" style="background:${v.color}"></i>${esc(v.name)}</span><strong>${num(v.value)}</strong>`).join("")}<small>${esc(note)}</small></div>`;}
function download(value:unknown,name:string):void{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export class ContextDetailsPanel {
  private dashboard:ContextDashboard|null=null;
  private page:Page="overview";
  private compact=false;
  private sessions:Session[]=[];
  private sessionId=new URLSearchParams(location.search).get("session")??"";
  private projectSelection=new URLSearchParams(location.search).get("selection")??"";
  private selectedIndex=-1;
  private selectedItem:ActivityItem|null=null;
  private content:string|null=null;
  private contentVersion=0;
  private query="";
  private category="all";
  private top=5;
  private a=0;
  private b=-1;
  private compareSession="";
  private other:ContextDashboard|null=null;
  private paused=false;
  private allowContent=false;
  private delta=false;
  private error="";
  private refreshing=false;
  private sequence=0;
  private timer:number|null=null;
  private nextId=1;
  private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(v:unknown)=>void;timer:number}>();
  private readonly local:boolean;
  private readonly preview:boolean;
  constructor(private root:HTMLElement){
    this.local=root.dataset.localDashboard==="true";this.preview=window.__CONTEXT_MONITOR_PREVIEW__!==undefined;
    this.bridge();root.addEventListener("click",e=>void this.click(e));root.addEventListener("change",e=>void this.change(e));
    root.addEventListener("input",e=>{if((e.target as HTMLElement).matches('[data-field="query"]')){this.query=(e.target as HTMLInputElement).value;this.render();}});
    document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!this.paused)void this.refresh();});
    window.addEventListener("pagehide",()=>this.dispose(),{once:true});
    const initial=window.__CONTEXT_MONITOR_PREVIEW__??window.openai?.toolOutput;
    if(isDashboard(initial))this.update(initial);else this.render();
    if(this.local){void this.refresh();void this.loadSessions();}
    else if(!this.preview&&window.parent!==window){void this.request("ui/initialize",{appInfo:{name:"context-window-monitor",version:"0.4.3"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]},protocolVersion:"2026-01-26"}).then(()=>{this.notify("ui/notifications/initialized",{});void this.loadSessions();}).catch(()=>{if(window.openai?.callTool)void this.refresh();});}
    this.timer=window.setInterval(()=>{if(!this.paused&&!document.hidden&&!this.preview)void this.refresh();},5000);
  }
  update(d:ContextDashboard):void{this.dashboard=d;this.sessionId=d.usage.sessionId??this.sessionId;this.render();}
  private snapshots():RawContextSnapshot[]{return this.dashboard?.snapshots??[];}
  private rows():ActivityItem[]{return (this.dashboard?.activity?.items??[]).filter(i=>(this.category==="all"||i.category===this.category)&&`${i.name} ${i.type} ${i.callId??""} ${i.messageId??""} ${i.file??""}`.toLowerCase().includes(this.query.toLowerCase()));}
  private records(items:ActivityItem[],rank=false):string{return items.map((i,n)=>`<button class="record" data-action="inspect" data-id="${esc(i.id)}">${rank?`<b>${String(n+1).padStart(2,"0")}</b>`:`<i class="dot" style="background:${colors[i.category]}"></i>`}<span><strong>${esc(i.name)}</strong><small>${esc(labels[i.category])} · ${time(i.timestamp)} · ${num(i.characters)} 字符</small></span><em>${short(i.characters)} 字符 ↗</em></button>`).join("");}
  private filters():string{return `<div class="filters"><input data-field="query" aria-label="搜索记录" placeholder="搜索工具、来源、消息 ID…" value="${esc(this.query)}"><select data-field="category" aria-label="类别过滤"><option value="all">所有来源</option>${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${this.category===k?"selected":""}>${v}</option>`).join("")}</select></div>`;}
  private trend():string{
    const ss=this.snapshots();if(!ss.length)return empty("等待 Codex 上报真实用量快照。");
    const values=ss.map((s,i)=>this.delta?s.last.inputTokens-(ss[i-1]?.last.inputTokens??s.last.inputTokens):s.last.inputTokens);
    const max=Math.max(1,...values.map(Math.abs));const selected=this.selectedIndex>=0?ss[this.selectedIndex]:ss.at(-1);
    return `<div class="chart-controls"><small>${this.delta?"相邻输入差值 · Exact":"最近模型输入 · Exact"}</small><button data-action="delta">${this.delta?"显示全量":"显示增量"}</button></div><div class="chart" role="group" aria-label="上下文增长柱状图">${ss.map((s,i)=>{const v=values[i]!;const ratio=s.last.inputTokens?s.last.cachedInputTokens/s.last.inputTokens*100:0;return `<button data-action="snapshot" data-index="${i}" class="${selected===s?"selected":""}" style="--height:${Math.max(2,Math.abs(v)/max*100)}%;${v<0?"background:#c3909e":""}" aria-label="快照 ${i+1}，${num(v)} tokens" title="${time(s.timestamp)} · ${num(v)} tokens">${!this.delta?`<i style="height:${Math.min(100,ratio)}%"></i>`:""}</button>`;}).join("")}</div><div class="chart-labels"><span>${time(ss[0]?.timestamp)}</span><span>峰值 ${short(max)} · ${ss.length} 个快照</span><span>${time(ss.at(-1)?.timestamp)}</span></div>${selected?`<div class="selected-snapshot"><strong>快照 #${ss.indexOf(selected)+1}</strong><span>${time(selected.timestamp)}</span><span>输入 ${num(selected.last.inputTokens)}</span><span>输出 ${num(selected.last.outputTokens)}</span></div>`:""}`;
  }
  private browser():string{
    const items=this.rows();return this.filters()+Object.entries(labels).map(([key,label])=>{const rows=items.filter(i=>i.category===key);return rows.length?`<details class="group" data-group="${key}"><summary><i class="dot" style="background:${colors[key]}"></i><strong>${label}</strong><span>${rows.length} 项</span><small>Token 未提供</small></summary><div class="group-content">${this.records(rows.slice(-80).reverse())}</div></details>`:"";}).join("")+(items.length?"":empty("没有匹配的日志记录。"))+`<p class="note">日志用于追踪来源，不代表模型当前完整请求。分类 Token 未提供，不按字符数估算。</p>`;
  }
  private events():string{return this.dashboard!.recentChanges.slice(0,12).map(e=>`<div class="event"><span>${e.kind==="compaction"?"↘":"+"}</span><span><strong>${e.kind==="compaction"?"上下文压缩":e.kind==="snapshot"?"初始快照":"模型输入变化"}</strong><small>${e.attribution==="exact-event"?"正式事件":"相邻快照；原因未归属"}</small></span><em>${signed(e.deltaTokens)}</em><time>${time(e.timestamp)}</time></div>`).join("")||empty("暂无用量变化。");}
  private network():string{
    const d=this.dashboard!;const u=d.usage;const children=this.sessions.filter(s=>s.parentSessionId===u.sessionId);const parent=d.activity?.parentSessionId;
    return `<div class="chart-controls"><span class="badge">${children.length+1} 个已关联会话</span><small>只显示明确的父子关系</small></div><div class="network"><div class="network-node">${ring([{name:"已用",value:u.usedTokens,color:"#9283d4"},{name:"剩余",value:u.remainingTokens,color:"#30303b"}],u.percentage===null?"—":`${u.percentage.toFixed(0)}%`,"当前会话")}<strong>${esc(d.activity?.agentName??u.sessionId?.slice(0,18)??"暂无 Session")}</strong><small>${short(u.usedTokens)} / ${short(u.totalTokens)}</small></div>${children.length?`<div class="network-children">${children.map(s=>`<button data-action="session" data-id="${esc(s.sessionId)}">↳ ${esc(s.agentName??s.sessionId.slice(0,18))}<small>点击查看该会话的实际用量</small></button>`).join("")}</div>`:""}</div>${parent?`<button data-action="session" data-id="${esc(parent)}">打开父会话 ${esc(parent.slice(0,18))} ↗</button>`:""}${!children.length?'<p class="muted">最近会话中未发现明确关联的子 Agent；结果写入主上下文的 Token 数未单独上报。</p>':""}`;
  }
  private overview():string{
    const d=this.dashboard!;const u=d.usage;const b=d.exactBreakdown;const items=d.activity?.items??[];
    const cache=b.currentModelInputTokens&&b.cachedInputTokens!==null?(b.cachedInputTokens/b.currentModelInputTokens*100).toFixed(2)+"%":"—";
    const input=[{name:"缓存读取",value:b.cachedInputTokens,color:"#6ba99f"},{name:"缓存写入",value:b.cacheWriteInputTokens,color:"#cfb374"},{name:"未缓存输入",value:b.uncachedInputTokens,color:"#9283d4"}];
    const output=[{name:"Reasoning 输出",value:b.reasoningOutputTokens,color:"#ad91c5"},{name:"其他输出",value:b.lastOutputTokens===null||b.reasoningOutputTokens===null?null:Math.max(0,b.lastOutputTokens-b.reasoningOutputTokens),color:"#829fd1"}];
    const stats=[["用量快照",d.snapshots?d.snapshots.length:"—"],["用户记录",d.activity?items.filter(i=>i.category==="user").length:"—"],["工具调用",d.activity?items.filter(i=>i.category==="tool_call").length:"—"],["缓存命中",cache],["压缩事件",d.compactions.length],["累计 Token",short(d.cumulativeTokens)]];
    const top=[...items].sort((a,b)=>b.characters-a.characters).slice(0,this.top);
    return `<div class="grid summary-grid">${card("上下文统计",`<div class="stats">${stats.map(([k,v])=>`<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("")}</div>`,"计数范围：保留的日志记录")}${card("插件信息",'<div class="plugin"><span>插件</span><strong>Context Monitor 0.4</strong><span>宿主</span><strong>Codex</strong><span>设置</span><button data-page="settings">打开设置 ↗</button></div>',"本地 · 只读")}</div><div class="grid">${card("输入 Token 分布",`<div class="ring-row">${ring(input,short(b.currentModelInputTokens),"最近模型输入")}${legend(input,"缓存 Token 是 input 的子集，不重复相加。")}</div>`,"Exact · Codex 实际上报")}${card("输出 Token 分布",`<div class="ring-row">${ring(output,short(b.lastOutputTokens),"最近模型输出")}${legend(output,"Reasoning 是 output 的子集。累计消耗与窗口占用分别显示。")}</div>`,"Exact · 最近一次响应")}</div><div class="grid"><div>${card("当前上下文",`<div class="usage-line"><strong>${short(u.usedTokens)} <small>/ ${short(u.totalTokens)} tokens</small></strong><span>${u.percentage?.toFixed(1)??"—"}%</span></div><div class="meter" role="progressbar" aria-label="上下文占用" ${u.percentage===null?"":`aria-valuenow="${u.percentage.toFixed(1)}"`} aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100,u.percentage??0)}%;${u.health==="danger"?"background:#d68791":""}"></i></div><div class="capacity-meta"><span>剩余 ${num(u.remainingTokens)}</span><span>${u.precision==="exact"?"Exact":"会话匹配待确认"}</span></div><div class="three"><div><small>已用输入</small><strong>${num(u.usedTokens)}</strong></div><div><small>窗口容量</small><strong>${num(u.totalTokens)}</strong></div><div><small>最近输出</small><strong>${num(b.lastOutputTokens)}</strong></div></div>`,u.model??"模型未提供")}${card("上下文趋势",this.trend(),"点击柱形查看快照")}</div>${card("上下文记录浏览器",this.browser(),d.activity?.truncated?"日志尾部 · 已截取":"已读取日志范围","browser")}</div><div class="grid">${card("上下文事件",this.events(),"真实快照变化与正式压缩")}${card("最大日志内容",`<div class="chart-controls"><small>按字符量排序，不推导 Token 占用</small><select data-field="top" aria-label="Top 数量">${[5,10,20].map(n=>`<option ${this.top===n?"selected":""} value="${n}">Top ${n}</option>`).join("")}</select></div>${this.records(top,true)||empty("暂无可分析内容。")}`,"定位长工具结果与长消息")}</div>${card("Agent 网络",this.network(),"明确关联的 Codex 会话")}`;
  }
  private table(items:ActivityItem[]):string{return items.length?`<div class="table-wrap"><table><thead><tr><th>来源</th><th>类型</th><th>字符量</th><th>Token</th><th>时间</th><th></th></tr></thead><tbody>${items.slice(-150).reverse().map(i=>`<tr><td>${esc(i.name)}<small>${esc(i.messageId??i.callId??i.id)}</small></td><td>${labels[i.category]}</td><td>${num(i.characters)}</td><td class="muted">Unavailable</td><td>${time(i.timestamp)}</td><td><button data-action="inspect" data-id="${esc(i.id)}">检查 ↗</button></td></tr>`).join("")}</tbody></table></div><p class="muted">最多显示最近 150 项，可按名称或来源筛选。</p>`:empty("没有匹配记录。");}
  private comparison():string{
    const ss=this.snapshots();const left=ss[this.a];const right=this.other?.snapshots?.at(-1)??ss[this.b<0?ss.length-1:this.b];
    const options=(selected:number)=>ss.map((s,i)=>`<option value="${i}" ${selected===i?"selected":""}>#${i+1} · ${time(s.timestamp)} · ${short(s.last.inputTokens)}</option>`).join("");
    const rows=left&&right?(["inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens","totalTokens"] as const).map(k=>`<tr><td>${k}</td><td>${num(left.last[k])}</td><td>${num(right.last[k])}</td><td>${signed(right.last[k]-left.last[k])}</td></tr>`).join(""):"";
    return card("用量快照对比",`<div class="compare-controls"><label>Snapshot A<select data-field="a">${options(this.a)}</select></label><label>Snapshot B<select data-field="b">${options(this.b<0?ss.length-1:this.b)}</select></label></div><div class="filters"><select data-field="compare-session" aria-label="对比会话"><option value="">或选择另一个会话</option>${this.sessions.filter(s=>s.sessionId!==this.sessionId).map(s=>`<option value="${esc(s.sessionId)}" ${this.compareSession===s.sessionId?"selected":""}>${esc(s.agentName??s.sessionId)}</option>`).join("")}</select><button data-action="compare-session" ${!this.compareSession?"disabled":""}>对比会话</button></div>${this.other?`<p class="note">B 是会话 ${esc(this.other.usage.sessionId)} 的最近快照。</p>`:""}${rows?`<div class="table-wrap"><table><thead><tr><th>字段</th><th>A</th><th>B</th><th>变化</th></tr></thead><tbody>${rows}</tbody></table></div>`:empty("需要有真实用量的快照。")}<p class="note">比较真实用量字段。Codex 未暴露完整模型 messages 快照，无法可靠提供内容的 Added / Removed / Modified。</p>`);
  }
  private body():string{
    const d=this.dashboard;if(!d)return empty(this.error||"正在读取 Codex 上下文…");
    switch(this.page){
      case "overview":return this.overview();
      case "timeline":return card("输入增长曲线",this.trend())+card("快照时间线",`<div class="table-wrap"><table><thead><tr><th>时间</th><th>模型</th><th>输入</th><th>缓存读取</th><th>输出</th><th>容量</th></tr></thead><tbody>${[...this.snapshots()].reverse().map(s=>`<tr><td>${time(s.timestamp)}</td><td>${esc(s.model??"Unavailable")}</td><td>${num(s.last.inputTokens)}</td><td>${num(s.last.cachedInputTokens)}</td><td>${num(s.last.outputTokens)}</td><td>${num(s.modelContextWindow)}</td></tr>`).join("")}</tbody></table></div>`,"Exact · 最多 80 个快照");
      case "records":return '<p class="note">模型最终完整请求：Unavailable。以下是 Codex 保存的记录，可能包含已压缩内容，不能等同于当前模型可见上下文。</p>'+card("上下文记录",this.filters()+this.table(this.rows()),d.activity?.scope??"暂无日志记录");
      case "sources":return card("来源分类",this.filters()+this.table(this.rows()))+card("重复长内容",(d.activity?.duplicates??[]).map(g=>`<div class="event"><span>≡</span><span><strong>${g.ids.length} 条完全相同的公开文本</strong><small>SHA-256 · 多余副本 ${num(g.characters)} 字符 · Token 未知</small></span><button data-action="inspect" data-id="${esc(g.ids[0])}">检查</button></div>`).join("")||empty("未发现 ≥ 256 字符的完全重复内容，不评判历史内容是否有用。"),"仅保留日志，可能不在当前窗口");
      case "tools":return card("工具调用",`<p class="note">次数和字符量来自保留日志。Tool Result 的独立 Token 占用未提供。</p><div class="table-wrap"><table><thead><tr><th>工具</th><th>调用</th><th>结果</th><th>参数字符</th><th>结果字符</th></tr></thead><tbody>${(d.activity?.tools??[]).map(t=>`<tr><td>${esc(t.name)}</td><td>${t.calls}</td><td>${t.results}</td><td>${num(t.argumentCharacters)}</td><td>${num(t.resultCharacters)}</td></tr>`).join("")}</tbody></table></div>`)+card("文件活动",(d.activity?.files??[]).map(f=>`<div class="event"><span>▤</span><span><strong>${esc(f.path)}</strong><small>${f.calls} 次包含明确路径参数的调用</small></span><span>${short(f.characters)} 参数字符</span></div>`).join("")||empty("未发现明确的 path / file_path 参数；不解析 Shell 命令猜测文件。"),"只读已记录路径，不扫描文件内容");
      case "agents":return card("Agent 网络",this.network(),"近期会话中可验证的父子关系");
      case "compaction":return d.compactions.length?d.compactions.map(c=>card(`上下文压缩 · ${time(c.timestamp)}`,`<div class="three"><div><small>Before · 模型输入</small><strong>${num(c.beforeTokens)}</strong></div><div><small>After · 模型输入</small><strong>${num(c.afterTokens)}</strong></div><div><small>观测减少量</small><strong>${num(c.reducedTokens)}</strong></div></div><p class="note">触发：${esc(c.trigger)} · ${c.precision}。数值来自事件两侧的请求快照，期间新增内容也可能影响差值。</p><button data-action="compaction-compare" data-time="${esc(c.timestamp)}">查看前后快照</button>`,"正式 Codex 事件")).join(""):empty("未发现正式压缩事件。普通 Token 下降不会被当成压缩。");
      case "compare":return this.comparison();
      case "settings":return card("显示与隐私",`<label class="setting"><span><strong>实时刷新</strong><small>每 5 秒读取新增日志，页面隐藏时暂停。</small></span><input type="checkbox" data-field="realtime" ${this.paused?"":"checked"}></label><label class="setting"><span><strong>允许原文预览</strong><small>只在点击「读取原文」时读取选中记录，每次打开默认关闭。</small></span><input type="checkbox" data-field="content" ${this.allowContent?"checked":""}></label><label class="setting"><span><strong>紧凑模式</strong><small>保留用量摘要，点击展开恢复详细面板。</small></span><input type="checkbox" data-field="compact" ${this.compact?"checked":""}></label><p class="note">主题：黑色<br>Token：仅实际报告，不按字符估算<br>保留：80 个用量快照、500 条日志记录、20 个压缩事件、12 个 Session 缓存<br>读取：首次最多 2 MiB 日志尾部，此后增量读取<br>保存：只保存既有 hook 元数据；不另存日志原文<br>限制：语义 Token 分类、完整模型请求、子 Agent 结果 Token 归因不可用。</p>`,"设置作用于本次仪表盘");
    }
  }
  private render():void{
    const inspectorScroll=this.root.querySelector<HTMLElement>(".inspector")?.scrollTop??0;
    const focused=document.activeElement as HTMLInputElement|null;const focusQuery=focused?.matches('[data-field="query"]');const caret=focusQuery?focused?.selectionStart??null:null;
    const groups=[...this.root.querySelectorAll<HTMLDetailsElement>("details[open][data-group]")].map(d=>d.dataset.group);
    const d=this.dashboard;const u=d?.usage;
    this.root.innerHTML=`<style>${styles}</style><article class="monitor ${this.compact?"compact":""}"><header class="header"><div class="logo" aria-hidden="true">▥</div><div><h1>上下文监控<span>CODEX CONTEXT MONITOR</span></h1><p>看清每次输入，追踪上下文变化</p></div><div class="actions"><span class="badge">● ${this.preview?"演示数据":this.paused?"已暂停":"本地只读"}</span><button data-action="refresh">刷新</button><button data-action="export" ${d?"":"disabled"}>导出 JSON ↗</button><button data-action="compact">${this.compact?"展开仪表盘":"收起"}</button></div></header><div class="session"><span>SESSION</span><select data-field="session" aria-label="选择 Session"><option value="${esc(this.sessionId)}">${esc(this.sessionId||"自动选择当前会话")}</option>${this.sessions.filter(s=>s.sessionId!==this.sessionId).map(s=>`<option value="${esc(s.sessionId)}">${esc(s.agentName??s.sessionId)}</option>`).join("")}</select><span class="model">${esc(u?.model??"模型未知")}</span><span class="badge">${esc(u?.precision??"Unavailable")}</span></div><div class="summary-bar"><strong>${short(u?.usedTokens)} / ${short(u?.totalTokens)}</strong> · ${u?.percentage?.toFixed(1)??"—"}%</div><nav class="tabs" aria-label="监控导航">${Object.entries(tabs).map(([key,name])=>`<button data-page="${key}" ${key===this.page?'aria-current="page"':""}>${name}</button>`).join("")}</nav><main class="page"><div class="page-title"><div><div class="eyebrow">CONTEXT OBSERVABILITY</div><h2>${tabs[this.page]}</h2></div><small>最近用量 ${time(u?.updatedAt)}${d?.activity?.truncated?" · 日志已截取":""}</small></div>${this.error?`<div class="notice" role="alert">${esc(this.error)}</div>`:""}${u?.precision==="estimated"?'<div class="notice">用量是 Codex 实际报告；当前按最新日志选择会话，请确认 Session。</div>':""}${this.projectSelection==="recent-session"?'<div class="notice">已打开本机最近活动的会话。托盘和快捷键无法识别当前选中的聊天，可通过 SESSION 切换。</div>':this.projectSelection==="recent-project"?'<div class="notice">已打开本项目最近活动的会话。项目操作无法识别当前选中的聊天，可通过 SESSION 切换。</div>':this.projectSelection==="no-project-session"?'<div class="notice">当前项目暂无可读取的近期会话，请通过 SESSION 选择。</div>':""}${this.body()}<footer class="footer"><span>Codex Context Monitor · 本地只读 · 不调用模型</span><span>Exact = 真实用量 Unavailable = 未提供</span></footer></main></article>${this.selectedItem?this.inspector():""}`;
    for(const g of groups)this.root.querySelector<HTMLDetailsElement>(`details[data-group="${g}"]`)?.setAttribute("open","");
    const inspector=this.root.querySelector<HTMLElement>(".inspector");if(inspector)inspector.scrollTop=inspectorScroll;
    if(focusQuery){const input=this.root.querySelector<HTMLInputElement>('[data-field="query"]');input?.focus();if(caret!==null)input?.setSelectionRange(caret,caret);}
    if(!this.local&&!this.preview)this.notify("ui/notifications/size-changed",{height:Math.min(1800,this.root.scrollHeight),width:this.root.clientWidth});
  }
  private inspector():string{const i=this.selectedItem!;return `<aside class="inspector" aria-label="Context Inspector"><div class="card-head"><h3>Context Inspector</h3><button data-action="close-inspector" aria-label="关闭检查器">×</button></div><span class="badge">${labels[i.category]}</span><h3>${esc(i.name)}</h3><dl>${[["类型",i.type],["角色",i.role??"Unavailable"],["Message ID",i.messageId??"Unavailable"],["Call ID",i.callId??"Unavailable"],["记录 ID",i.id],["时间",time(i.timestamp)],["字符数",num(i.characters)],["Token","Unavailable"],["文件",i.file??"Unavailable"]].map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl><p class="note">这是已记录的公开内容，无法据此判断当前是否仍在模型上下文中。</p><button data-action="reveal" ${this.allowContent?"":"disabled"}>读取这条记录的原文</button>${this.allowContent?"":'<p class="muted">原文默认隐藏，可在设置中启用。</p>'}${this.content!==null?`<pre>${esc(this.content)}</pre><button data-action="export-item">导出这条记录</button>`:""}</aside>`;}
  private async click(e:Event):Promise<void>{
    const target=(e.target as HTMLElement).closest<HTMLButtonElement>("button");if(!target)return;
    if(target.dataset.page){this.page=target.dataset.page as Page;this.render();return;}
    const action=target.dataset.action;
    if(action==="refresh"){await this.refresh();await this.loadSessions();return;}
    if(action==="export"){download(this.dashboard,"codex-context-report.json");return;}
    if(action==="compact")this.compact=!this.compact;
    if(action==="delta")this.delta=!this.delta;
    if(action==="snapshot")this.selectedIndex=Number(target.dataset.index);
    if(action==="inspect"){this.selectedItem=this.dashboard?.activity?.items.find(i=>i.id===target.dataset.id)??null;this.content=null;this.contentVersion++;}
    if(action==="close-inspector"){this.selectedItem=null;this.content=null;this.contentVersion++;}
    if(action==="reveal"&&this.allowContent&&this.selectedItem){
      const item=this.selectedItem;const version=++this.contentVersion;this.content="读取中…";this.render();
      try{const result=obj(await this.callTool("read_context_item",{sessionId:this.sessionId,itemId:item.id,confirmReveal:true}));const data=obj(result?.structuredContent);if(this.contentVersion!==version||!this.allowContent)return;this.content=typeof data?.text==="string"?data.text+(data.truncated?"\n[已截取前 32,768 字符]":""):"未记录可展示的公开文本。";}catch(error){if(this.contentVersion===version)this.content=String(error);}
    }
    if(action==="export-item"&&this.content!==null)download({metadata:this.selectedItem,text:this.content},"codex-context-item.json");
    if(action==="session"&&target.dataset.id){await this.switchSession(target.dataset.id);return;}
    if(action==="compaction-compare"){
      const t=Date.parse(target.dataset.time??"");const ss=this.snapshots();let before=-1;ss.forEach((s,i)=>{if(Date.parse(s.timestamp)<t)before=i;});const after=ss.findIndex(s=>Date.parse(s.timestamp)>t);
      if(before<0||after<0){this.error="保留范围内缺少压缩前或压缩后的用量快照，无法对比。";}else{this.a=before;this.b=after;this.other=null;this.error="";this.page="compare";}
    }
    if(action==="compare-session"&&this.compareSession)try{const data=obj(await this.callTool("get_context_usage",{sessionId:this.compareSession}))?.structuredContent;if(isDashboard(data))this.other=data;}catch(error){this.error=String(error);}
    this.render();
  }
  private async change(e:Event):Promise<void>{const input=e.target as HTMLInputElement;switch(input.dataset.field){
    case "session":await this.switchSession(input.value);return;
    case "category":this.category=input.value;break;
    case "top":this.top=Number(input.value);break;
    case "a":this.a=Number(input.value);break;
    case "b":this.b=Number(input.value);this.other=null;break;
    case "compare-session":this.compareSession=input.value;break;
    case "realtime":this.paused=!input.checked;break;
    case "content":this.allowContent=input.checked;this.content=null;this.contentVersion++;break;
    case "compact":this.compact=input.checked;break;
    default:return;
  }this.render();}
  private async switchSession(id:string):Promise<void>{this.sessionId=id;this.projectSelection="";this.selectedItem=null;this.content=null;this.contentVersion++;this.other=null;this.a=0;this.b=-1;this.selectedIndex=-1;this.dashboard=null;this.sequence++;await this.refresh(true);}
  private async refresh(force=false):Promise<void>{if((this.refreshing&&!force)||document.hidden||this.preview)return;const version=++this.sequence;this.refreshing=true;
    try{const result=obj(await this.callTool("get_context_usage",this.sessionId?{sessionId:this.sessionId}:{}));const value=result?.structuredContent;if(version===this.sequence&&isDashboard(value)){this.error="";this.update(value);}}
    catch(error){if(version===this.sequence){this.error=`刷新失败，保留最后快照：${String(error)}`;this.render();}}
    finally{if(version===this.sequence)this.refreshing=false;}
  }
  private async loadSessions():Promise<void>{if(this.preview)return;try{const data=obj(obj(await this.callTool("list_context_sessions",{limit:20}))?.structuredContent);if(Array.isArray(data?.sessions)){this.sessions=data.sessions as Session[];this.render();}}catch{/* Keep the selected session usable if discovery fails. */}}
  private async callTool(name:string,args:Record<string,unknown>):Promise<unknown>{
    if(name==="get_context_usage")args={...args,details:true};
    if(this.preview)throw new Error("演示模式不读取任何真实原文。");
    if(this.local){const res=await fetch(new URL("api",location.href),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,arguments:args})});const data=await res.json();if(!res.ok)throw new Error(String(data.error??res.status));return data;}
    if(window.openai?.callTool)return window.openai.callTool(name,args);
    return this.request("tools/call",{name,arguments:args});
  }
  private notify(method:string,params:Record<string,unknown>):void{if(window.parent!==window)window.parent.postMessage({jsonrpc:"2.0",method,params},"*");}
  private request(method:string,params:Record<string,unknown>):Promise<unknown>{const id=this.nextId++;return new Promise((resolve,reject)=>{const timer=window.setTimeout(()=>{this.pending.delete(id);reject(new Error("MCP Apps bridge timed out"));},10000);this.pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:"2.0",id,method,params},"*");});}
  private bridge():void{window.addEventListener("message",event=>{
    if(event.source!==window.parent||window.parent===window)return;const m=obj(event.data);if(m?.jsonrpc!=="2.0")return;
    if(typeof m.id==="number"&&this.pending.has(m.id)){const p=this.pending.get(m.id)!;clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(m.error);else p.resolve(m.result);return;}
    if(m.method==="ui/notifications/tool-result"){const params=obj(m.params);const result=obj(params?._meta)?.dashboard??params?.structuredContent;if(isDashboard(result)&&(!this.sessionId||result.usage.sessionId===this.sessionId))this.update(result);}
    if(m.method==="ui/resource-teardown"){this.dispose();window.parent.postMessage({jsonrpc:"2.0",id:m.id,result:{}},"*");}
  });}
  private dispose():void{if(this.timer!==null)clearInterval(this.timer);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error("View closed"));}this.pending.clear();}
}
const root=document.getElementById("root");if(root)new ContextDetailsPanel(root);
