import type {ActivityItem, ContextDashboard, RawContextSnapshot} from "../context-types.js";
import {styles} from "./styles.js";
import {categoryLabels as labels, categoryColors as colors, scopedItems, categoryComposition, observedTiming, fileRows, trendGroups} from "./dashboard-model.js";
import {donutArcs} from "./dsh-donut.js";

declare global {interface Window {openai?:{toolOutput?:unknown;callTool?:(name:string,args:Record<string,unknown>)=>Promise<unknown>};__CONTEXT_MONITOR_PREVIEW__?:unknown}}
type Page="overview"|"timeline"|"records"|"sources"|"tools"|"agents"|"compaction"|"compare"|"settings";
interface Session {sessionId:string;model:string|null;parentSessionId?:string|null;agentName?:string|null}
type Segment={name:string;value:number|null;color:string};
const tabs:Record<Page,string>={overview:"上下文",timeline:"趋势",records:"记录",sources:"来源",tools:"工具与文件",agents:"Agent 网络",compaction:"压缩",compare:"对比",settings:"设置"};
const esc=(value:unknown):string=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const obj=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"?value as Record<string,unknown>:null;
const num=(value:number|null|undefined):string=>value===null||value===undefined?"—":value.toLocaleString("en-US");
const short=(value:number|null|undefined):string=>value===null||value===undefined?"—":Math.abs(value)>=1e6?`${(value/1e6).toFixed(1)}M`:Math.abs(value)>=1e3?`${(value/1e3).toFixed(1)}k`:String(value);
const signed=(value:number|null):string=>value===null?"—":`${value>0?"+":""}${short(value)}`;
const time=(value:string|null|undefined):string=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleTimeString("zh-CN",{hour12:false}):"—";
const duration=(value:number|null):string=>value===null?"—":value>=3600?`${Math.floor(value/3600)}h${Math.floor(value%3600/60)}m`:value>=60?`${Math.floor(value/60)}m${Math.floor(value%60)}s`:`${value.toFixed(value<10?1:0)}s`;
const empty=(message:string):string=>`<div class="empty">${esc(message)}</div>`;
const card=(title:string,body:string,note="",extra=""):string=>`<section class="card ${extra}"><div class="card-head"><h3>${esc(title)}</h3><small>${esc(note)}</small></div>${body}</section>`;
const pill=(label:string,color:string):string=>`<i class="dot" style="background:${color}"></i>${esc(label)}`;
function isDashboard(value:unknown):value is ContextDashboard {const record=obj(value);return record?.schemaVersion===1&&!!obj(record.usage)&&Array.isArray(record.recentChanges);}
function ring(values:Segment[],total:string,label:string):string {
  const arcs=donutArcs(values.map(value=>({key:value.name,color:value.color,value:value.value})));
  return `<div class="ring" role="img" aria-label="${esc(label)} ${esc(total)}"><svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="15.9155" class="ring-track"/>${arcs.map(arc=>`<circle cx="21" cy="21" r="15.9155" stroke="${arc.color}" stroke-dasharray="${arc.length} ${100-arc.length}" stroke-dashoffset="${arc.offset}"/>`).join("")}</svg><div><strong>${esc(total)}</strong><small>${esc(label)}</small></div></div>`;
}
function legend(values:Segment[],unit="tokens"):string {
  const sum=values.reduce((total,value)=>total+Math.max(0,value.value??0),0);
  return `<div class="legend">${values.map(value=>`<div class="legend-entry"><span>${pill(value.name,value.color)}</span><b>${value.value===null?"—":sum?`${(value.value/sum*100).toFixed(1)}%`:"0%"}</b><small>${short(value.value)} ${unit}</small></div>`).join("")}</div>`;
}
function download(value:unknown,name:string):void {const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

export class ContextDetailsPanel {
  private dashboard:ContextDashboard|null=null;
  private page:Page="overview";
  private compact=false;
  private sessions:Session[]=[];
  private sessionId=new URLSearchParams(location.search).get("session")??"";
  private projectSelection=new URLSearchParams(location.search).get("selection")??"";
  private selectedIndex=-1;
  private hoveredIndex:number|null=null;
  private selectedItem:ActivityItem|null=null;
  private content:string|null=null;
  private contentVersion=0;
  private query="";
  private category="all";
  private fileQuery="";
  private fileKind="all";
  private fileSort="calls";
  private eventKind="all";
  private dna=false;
  private byTurn=false;
  private showDiff=false;
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
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(value:unknown)=>void;timer:number}>();
  private readonly local:boolean;
  private readonly preview:boolean;
  constructor(private root:HTMLElement) {
    this.local=root.dataset.localDashboard==="true";this.preview=window.__CONTEXT_MONITOR_PREVIEW__!==undefined;
    this.bridge();root.addEventListener("click",event=>void this.click(event));root.addEventListener("change",event=>void this.change(event));
    root.addEventListener("input",event=>{const target=event.target as HTMLInputElement;if(target.dataset.field==="query")this.query=target.value;else if(target.dataset.field==="file-query")this.fileQuery=target.value;else return;this.render();});
    root.addEventListener("mouseover",event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-action="snapshot"]');if(target){const index=Number(target.dataset.index);if(this.hoveredIndex!==index){this.hoveredIndex=index;this.renderFocus();}}});
    root.addEventListener("mouseout",event=>{const plot=(event.target as HTMLElement).closest(".trend-plot");if(plot&&!plot.contains(event.relatedTarget as Node|null)&&this.hoveredIndex!==null){this.hoveredIndex=null;this.renderFocus();}});
    document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!this.paused)void this.refresh();});
    window.addEventListener("pagehide",()=>this.dispose(),{once:true});
    const initial=window.__CONTEXT_MONITOR_PREVIEW__??window.openai?.toolOutput;
    if(isDashboard(initial))this.update(initial);else this.render();
    if(this.local){void this.refresh();void this.loadSessions();}
    else if(!this.preview&&window.parent!==window){void this.request("ui/initialize",{appInfo:{name:"context-window-monitor",version:"0.5.0"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]},protocolVersion:"2026-01-26"}).then(()=>{this.notify("ui/notifications/initialized",{});void this.loadSessions();}).catch(()=>{if(window.openai?.callTool)void this.refresh();});}
    this.timer=window.setInterval(()=>{if(!this.paused&&!document.hidden&&!this.preview)void this.refresh();},5000);
  }
  update(dashboard:ContextDashboard):void {this.dashboard=dashboard;this.sessionId=dashboard.usage.sessionId??this.sessionId;this.render();}
  private snapshots():RawContextSnapshot[] {return this.dashboard?.snapshots??[];}
  private focusIndex():number {return this.hoveredIndex??this.selectedIndex;}
  private focusedItems():ActivityItem[] {return this.dashboard?scopedItems(this.dashboard,this.focusIndex()):[];}
  private rows():ActivityItem[] {return this.focusedItems().filter(item=>(this.category==="all"||item.category===this.category)&&`${item.name} ${item.type} ${item.callId??""} ${item.messageId??""} ${item.file??""}`.toLowerCase().includes(this.query.toLowerCase()));}
  private records(items:ActivityItem[],rank=false):string {return items.map((item,index)=>`<button class="record" data-action="inspect" data-id="${esc(item.id)}">${rank?`<b>${String(index+1).padStart(2,"0")}</b>`:`<i class="dot" style="background:${colors[item.category]}"></i>`}<span><strong>${esc(item.name)}</strong><small>${esc(labels[item.category])} · ${time(item.timestamp)} · ${num(item.characters)} 字符</small></span><em>${short(item.characters)} <span>字符</span> ↗</em></button>`).join("");}
  private filters():string {return `<div class="filters"><input data-field="query" aria-label="搜索上下文记录" placeholder="搜索工具、来源、消息 ID…" value="${esc(this.query)}"><select data-field="category" aria-label="记录类别"><option value="all">所有来源</option>${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${this.category===key?"selected":""}>${label}</option>`).join("")}</select></div>`;}
  private requestDetail():string {
    const index=this.focusIndex();const snapshots=this.snapshots();const selected=index<0?snapshots.at(-1):snapshots[index];
    if(!selected)return empty("等待实际请求快照。");
    const before=snapshots[snapshots.indexOf(selected)-1];const cache=selected.last.inputTokens?selected.last.cachedInputTokens/selected.last.inputTokens*100:0;
    return `<div class="request-heading"><strong>${index<0?"最近请求":`请求 #${snapshots.indexOf(selected)+1}`}${this.hoveredIndex!==null?' <span class="badge">悬停预览</span>':this.selectedIndex>=0?' <span class="badge accent">已固定</span>':""}</strong><time>${time(selected.timestamp)}</time></div><div class="request-badges"><span>实际输入 <b>${short(selected.last.inputTokens)}</b></span><span>输出 <b>${short(selected.last.outputTokens)}</b></span><span>缓存 <b>${cache.toFixed(1)}%</b></span><span>输入变化 <b class="${before&&selected.last.inputTokens<before.last.inputTokens?"decrease":""}">${before?signed(selected.last.inputTokens-before.last.inputTokens):"—"}</b></span></div><small class="muted">${esc(selected.turnId?`轮次 ${selected.turnId.slice(0,24)}`:"轮次 ID 未提供")} · ${esc(selected.model??"模型未提供")}</small>`;
  }
  private trend():string {
    const snapshots=this.snapshots();if(!snapshots.length)return empty("等待 Codex 上报真实用量快照。");
    const groups=trendGroups(snapshots,this.byTurn);const values=groups.map((group,index)=>this.delta?group.snapshot.last.inputTokens-(groups[index-1]?.snapshot.last.inputTokens??group.snapshot.last.inputTokens):group.snapshot.last.inputTokens);
    const max=Math.max(1,...values.map(Math.abs));
    return `<div class="chart-controls"><span class="badge">${this.byTurn?"轮次":"步骤"} · ${groups.length}</span><div class="segmented"><button data-action="granularity" data-value="step" class="${!this.byTurn?"active":""}">步骤</button><button data-action="granularity" data-value="turn" class="${this.byTurn?"active":""}">轮次</button></div><div class="segmented"><button data-action="trend-mode" data-value="total" class="${!this.delta?"active":""}">全量</button><button data-action="trend-mode" data-value="delta" class="${this.delta?"active":""}">增量</button></div></div><div class="trend-frame"><div class="axis"><span>${short(max)}</span><span>${short(max/2)}</span><span>${this.delta?signed(-max):"0"}</span></div><div class="trend-scroll"><div class="trend-plot ${this.delta?"signed-plot":""}" role="group" aria-label="上下文趋势">${groups.map((group,index)=>{
      const snapshot=group.snapshot,value=values[index]!,height=Math.max(2,Math.abs(value)/max*(this.delta?48:100));
      const cached=snapshot.last.inputTokens?Math.min(100,snapshot.last.cachedInputTokens/snapshot.last.inputTokens*100):0;
      const compacted=this.dashboard!.compactions.some(marker=>Date.parse(marker.timestamp)>(Date.parse(groups[index-1]?.snapshot.timestamp??"1970-01-01"))&&Date.parse(marker.timestamp)<=Date.parse(snapshot.timestamp));
      return `<button data-action="snapshot" data-index="${group.index}" class="trend-bar ${this.selectedIndex===group.index?"selected":""} ${value<0?"negative":""}" style="--bar-height:${height}%" aria-label="选择请求 ${group.index+1}" title="${time(snapshot.timestamp)} · 输入 ${num(snapshot.last.inputTokens)} · ${group.count} 次请求">${compacted?'<span class="compaction-marker">✂</span>':""}${!this.delta?`<i style="height:${cached}%"></i>`:""}</button>`;
    }).join("")}</div></div></div><div class="chart-labels"><span>${time(snapshots[0]?.timestamp)}</span><span>输入 Token · 实际上报</span><span>${time(snapshots.at(-1)?.timestamp)}</span></div><div class="request-detail">${this.requestDetail()}</div>`;
  }
  private browser():string {
    const index=this.focusIndex(),items=this.rows();const comparisonIndex=index<0?this.snapshots().length-1:index;
    const previous=this.dashboard&&comparisonIndex>0?scopedItems(this.dashboard,comparisonIndex-1):[];
    const composition=categoryComposition(items,previous);const sum=items.reduce((total,item)=>total+item.characters,0);
    return `<div class="browser-toolbar"><div class="segmented"><button data-action="dna" class="${this.dna?"active":""}" aria-pressed="${this.dna}">DNA 模式</button><button data-action="browser-diff" class="${this.showDiff?"active":""}" aria-pressed="${this.showDiff}">对比前一步</button></div><select data-field="focus" aria-label="浏览请求范围"><option value="-1" ${index<0?"selected":""}>最新保留记录</option>${this.snapshots().map((snapshot,position)=>`<option value="${position}" ${position===index?"selected":""}>请求 #${position+1} · ${short(snapshot.last.inputTokens)}</option>`).join("")}</select></div><div class="browser-caption"><strong>${index<0?"当前 · 保留日志范围":`截至请求 #${index+1}`}</strong><small>${num(items.length)} 条${this.dashboard?.activity?.truncated?"（日志已截取）":""} · ${short(sum)} 字符</small></div><div class="composition-strip" aria-label="保留记录的字符组成">${composition.filter(part=>part.characters>0).map(part=>`<i style="width:${sum?part.characters/sum*100:0}%;background:${part.color}" title="${part.label} · ${num(part.characters)} 字符"></i>`).join("")}</div>${this.filters()}${this.dna?`<div class="dna-strip" aria-label="按日志顺序排列的 DNA 记录">${items.map(item=>`<button data-action="inspect" data-id="${esc(item.id)}" style="--dna-color:${colors[item.category]};flex-grow:${Math.max(1,item.characters)}" title="${esc(labels[item.category])} · ${esc(item.name)} · ${num(item.characters)} 字符" aria-label="检查 ${esc(item.name)}"></button>`).join("")}</div><p class="note">每块是一条日志，宽度按字符量；它不代表模型的完整请求顺序。</p>`:""}${composition.filter(part=>part.items.length).map(part=>`<details class="group" data-group="${part.category}"><summary>${pill(part.label,part.color)}<span>${part.items.length} 项</span>${this.showDiff&&comparisonIndex>0&&part.added?`<b class="delta-chip">+${part.added}</b>`:""}<small>${short(part.characters)} 字符</small><em>${sum?(part.characters/sum*100).toFixed(0):0}%</em></summary><div class="group-content">${this.records(part.items.slice(-80).reverse())}</div></details>`).join("")}${items.length?"":empty("该范围中没有匹配记录。")}<p class="note">分类条显示日志字符量，分类 Token 未提供。固定请求按时间筛选保留日志，不能还原完整模型 messages。</p>`;
  }
  private events():string {
    const changes=this.dashboard!.recentChanges;const kinds:Array<[string,string]>=[["all","全部"],["increase","增长"],["decrease","下降"],["compaction","压缩"],["snapshot","快照"]];
    const filtered=changes.filter(change=>this.eventKind==="all"||change.kind===this.eventKind);
    return `<div class="purpose-filters">${kinds.map(([kind,label])=>`<button data-action="event-filter" data-value="${kind}" class="${this.eventKind===kind?"active":""}">${label} <b>${changes.filter(change=>kind==="all"||change.kind===kind).length}</b></button>`).join("")}</div><div class="event-list">${filtered.slice(-18).reverse().map(change=>`<div class="event"><span class="event-symbol ${change.kind}">${change.kind==="compaction"?"✂":change.kind==="decrease"?"−":"+"}</span><span><strong><i class="event-chip ${change.kind}">${change.kind==="compaction"?"压缩":change.kind==="decrease"?"下降":change.kind==="snapshot"?"快照":"增长"}</i> ${esc(change.label)}</strong><small>${change.attribution==="exact-event"?"正式事件":"实际快照变化 · 原因未归属"}</small></span><b class="${change.deltaTokens!==null&&change.deltaTokens<0?"decrease":"growth"}">${signed(change.deltaTokens)}</b><time>${time(change.timestamp)}</time>${change.kind==="compaction"?`<button data-action="compaction-compare" data-time="${esc(change.timestamp)}" aria-label="对比压缩前后">↗</button>`:""}</div>`).join("")||empty("没有此类事件。")}</div>`;
  }
  private files():string {
    const all=fileRows(this.focusedItems());const kinds:Array<[string,string]>=[["all","全部"],["read","读取"],["write","写入"],["search","搜索"],["image","图片"]];
    const rows=all.filter(row=>(this.fileKind==="all"||row[this.fileKind as "read"|"write"|"search"|"image"]>0)&&row.path.toLowerCase().includes(this.fileQuery.toLowerCase()));
    rows.sort((left,right)=>this.fileSort==="path"?left.path.localeCompare(right.path):this.fileSort==="latest"?(Date.parse(right.lastAt??"")||0)-(Date.parse(left.lastAt??"")||0):right.calls-left.calls);
    return `<div class="purpose-filters file-filters">${kinds.map(([kind,label])=>`<button data-action="file-filter" data-value="${kind}" class="${this.fileKind===kind?"active":""} ${kind}">${label} <b>${kind==="all"?all.reduce((total,row)=>total+row.calls,0):all.reduce((total,row)=>total+row[kind as "read"|"write"|"search"|"image"],0)}</b></button>`).join("")}</div><div class="filters"><input data-field="file-query" aria-label="按文件路径筛选" placeholder="按路径筛选…" value="${esc(this.fileQuery)}"><select data-field="file-sort" aria-label="文件排序"><option value="calls" ${this.fileSort==="calls"?"selected":""}>按次数</option><option value="latest" ${this.fileSort==="latest"?"selected":""}>按最新</option><option value="path" ${this.fileSort==="path"?"selected":""}>按路径</option></select></div><div class="file-heading"><strong>${rows.length} 个文件</strong><small>${this.focusIndex()<0?"截至最新":"跟随所选请求"}</small></div><div class="file-list">${rows.slice(0,80).map(row=>{
      const name=row.path.replaceAll("\\","/").split("/").at(-1)??row.path;const ext=name.includes(".")?name.split(".").at(-1)!.slice(0,4).toUpperCase():"FILE";
      return `<details class="file-entry" data-file="${esc(row.path)}"><summary><span class="file-icon">${esc(ext)}</span><strong title="${esc(row.path)}">${esc(row.path)}</strong><div class="file-counts">${row.read?`<span class="read">● ${row.read}</span>`:""}${row.write?`<span class="write">● ${row.write}</span>`:""}${row.search?`<span class="search">● ${row.search}</span>`:""}${row.image?`<span class="image">● ${row.image}</span>`:""}${!row.read&&!row.write&&!row.search&&!row.image?`<span>${row.calls} 次</span>`:""}</div><span class="file-lines">${row.addedLines!==null||row.removedLines!==null?`<b class="growth">${row.addedLines===null?"—":`+${row.addedLines}`}</b> <b class="decrease">${row.removedLines===null?"—":`−${row.removedLines}`}</b>`:"—"}</span><time>${time(row.lastAt)}</time></summary><div class="file-operations">${this.records([...row.items].reverse())}</div></details>`;
    }).join("")||empty("未发现带明确路径的文件操作。")}</div><p class="note">读取 / 写入 / 搜索 / 图片计数来自工具元数据；增减行统计日志中的补丁请求，不代表落盘成功；未知值显示 —。</p>`;
  }
  private network():string {
    const dashboard=this.dashboard!,usage=dashboard.usage;const children=this.sessions.filter(session=>session.parentSessionId===usage.sessionId);const parent=dashboard.activity?.parentSessionId;
    return `<div class="network-meta"><span class="badge">${children.length+1} 个 Agent</span><span class="badge accent">${short(usage.usedTokens)} 当前输入</span><small>仅显示日志中明确的父子关系</small></div><div class="network">${parent?`<button class="parent-node" data-action="session" data-id="${esc(parent)}">↑ 父会话 ${esc(parent.slice(0,12))}</button>`:""}<div class="network-node">${ring([{name:"已用",value:usage.percentage!==null?usage.usedTokens:null,color:"#3285ff"},{name:"剩余",value:usage.percentage!==null?usage.remainingTokens:null,color:"#303745"}],usage.percentage===null?"—":`${usage.percentage.toFixed(0)}%`,"上下文占用")}<strong>${esc(dashboard.activity?.agentName??"当前 Codex 会话")}</strong><small>${short(usage.usedTokens)} / ${short(usage.totalTokens)}</small></div>${children.length?`<div class="network-children">${children.map(session=>`<button data-action="session" data-id="${esc(session.sessionId)}"><i class="node-link"></i><strong>${esc(session.agentName??session.sessionId.slice(0,18))}</strong><small>${esc(session.model??"打开查看实际用量")} ↗</small></button>`).join("")}</div>`:""}</div>${!children.length?'<p class="network-empty">还没有已关联的子 Agent — 当 Codex 日志记录委派关系时，协作网络会在这里展开。</p>':""}<div class="agent-strip"><strong>${esc(dashboard.activity?.agentName??"当前会话")}</strong><span class="badge">当前</span><span>${short(usage.usedTokens)} / ${short(usage.totalTokens)} · ${num(this.snapshots().length)} 个保留请求</span></div>`;
  }
  private current():string {
    const usage=this.dashboard!.usage,breakdown=this.dashboard!.exactBreakdown;const occupied=Math.min(100,Math.max(0,usage.percentage??0));
    const cached=usage.totalTokens&&breakdown.cachedInputTokens!==null?Math.min(occupied,breakdown.cachedInputTokens/usage.totalTokens*100):0;
    return `<div class="usage-line" data-health="${usage.health}"><strong>${short(usage.usedTokens)} <small>/ ${short(usage.totalTokens)} tokens</small></strong><span><b>${usage.percentage?.toFixed(0)??"—"}%</b> 上下文已用</span></div><div class="meter" role="progressbar" aria-label="上下文占用" ${usage.percentage===null?"":`aria-valuenow="${Math.min(100,usage.percentage).toFixed(1)}"`} aria-valuemin="0" aria-valuemax="100"><i class="cache" style="width:${cached}%"></i><i class="input" style="width:${Math.max(0,occupied-cached)}%"></i><i class="free" style="width:${usage.percentage===null?0:100-occupied}%"></i></div><div class="capacity-legend"><span>${pill("缓存读取","#00b9aa")} <b>${short(breakdown.cachedInputTokens)}</b></span><span>${pill("未缓存输入","#3285ff")} <b>${short(breakdown.uncachedInputTokens)}</b></span><span>${pill("剩余空间","#424951")} <b>${short(usage.remainingTokens)}</b></span></div><p class="note">最近一次实际模型输入 · ${esc(usage.precision)}。这是最近请求的占用，不是下一次请求预测。</p>`;
  }
  private overview():string {
    const dashboard=this.dashboard!,usage=dashboard.usage,breakdown=dashboard.exactBreakdown,items=dashboard.activity?.items??[],last=this.snapshots().at(-1);
    const turns=new Set(this.snapshots().map(snapshot=>snapshot.turnId).filter(Boolean));
    const cache=breakdown.currentModelInputTokens&&breakdown.cachedInputTokens!==null?`${(breakdown.cachedInputTokens/breakdown.currentModelInputTokens*100).toFixed(2)}%`:"—";
    const metrics=[["轮次",turns.size||"—"],["请求快照",this.snapshots().length],["用户输入",items.filter(item=>item.category==="user").length],["工具调用",items.filter(item=>item.category==="tool_call").length],["缓存命中",cache],["累计 Token",short(dashboard.cumulativeTokens)],["费用","未提供"],["子 Agent 费用","未提供"]];
    const cumulative=last?.cumulative;
    const tokenTotal=cumulative?.totalTokens??(breakdown.currentModelInputTokens!==null&&breakdown.lastOutputTokens!==null?breakdown.currentModelInputTokens+breakdown.lastOutputTokens:null);
    const tokenScope=cumulative?"累计用量":"最近请求";
    const values:Segment[]=[{name:"缓存读取",value:cumulative?.cachedInputTokens??breakdown.cachedInputTokens,color:"#00b9aa"},{name:"未缓存输入",value:cumulative?Math.max(0,cumulative.inputTokens-cumulative.cachedInputTokens-cumulative.cacheWriteInputTokens):breakdown.uncachedInputTokens,color:"#3285ff"},{name:"输出",value:cumulative?.outputTokens??breakdown.lastOutputTokens,color:"#e54aae"}];
    const cacheWrite=cumulative?.cacheWriteInputTokens??breakdown.cacheWriteInputTokens;
    if((cacheWrite??0)>0)values.push({name:"缓存写入",value:cacheWrite,color:"#ffad0a"});
    const timing=observedTiming(items);const timingSegments=[{name:"工具调用区间",value:timing.tool,color:"#00b9aa"},{name:"其他观测区间",value:timing.other,color:"#8b5cf6"}];
    return `<div class="grid summary-grid">${card("上下文统计",`<div class="stats">${metrics.map(([label,value])=>`<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`,"计数基于保留日志范围")}${card("插件信息",`<div class="plugin"><span>插件</span><strong>context-window-monitor <small>v0.5.0</small></strong><span>GitHub</span><a href="https://github.com/xlxs123/context-window-monitor" target="_blank" rel="noreferrer">xlxs123/context-window-monitor ↗</a><span>界面参考</span><a href="https://github.com/bowenliang123/dsh-context" target="_blank" rel="noreferrer">dsh-context · 0.62.2 ↗</a><span>设置</span><button data-page="settings">打开设置</button></div>`,"Codex 原生数据适配")}</div><div class="grid stats-row">${card("Token 统计",`<div class="ring-row">${ring(values,short(tokenTotal),tokenScope)}${legend(values)}</div><p class="note">缓存是输入的子集；Reasoning 是输出的子集，不重复相加。</p>`,cumulative?"实际用量 · 最新累计值":"实际用量 · 最近请求，累计分项未提供")}${card("耗时统计",`<div class="ring-row">${ring(timingSegments,duration(timing.span),"日志观测时段")}${legend(timingSegments,"秒")}</div><div class="timing-footer"><span>${timing.pairedCalls} 个可配对工具调用</span><span>模型等待 / 思考 / 输出：未提供</span></div>`,"并发工具区间合并后统计")}</div><div class="grid workspace-grid"><div class="left-column">${card("当前上下文",this.current(),usage.model??"模型未提供")}${card("上下文趋势",this.trend(),"悬停预览 · 点击固定")}</div>${card("上下文浏览器",`<div class="browser-body">${this.browser()}</div>`,"记录范围 · 分类 Token 未提供","browser")}</div><div class="grid activity-grid">${card("上下文事件",this.events(),"正式压缩与实际快照变化")}${card("文件活动",`<div class="file-body">${this.files()}</div>`,"跟随趋势图所选请求")}</div>${card("Agent 网络",this.network(),"点击节点切换关联会话","agent-card")}`;
  }
  private table(items:ActivityItem[]):string {return items.length?`<div class="table-wrap"><table><thead><tr><th>来源</th><th>类型</th><th>字符量</th><th>Token</th><th>时间</th><th></th></tr></thead><tbody>${items.slice(-150).reverse().map(item=>`<tr><td>${esc(item.name)}<small>${esc(item.messageId??item.callId??item.id)}</small></td><td>${labels[item.category]}</td><td>${num(item.characters)}</td><td class="muted">未提供</td><td>${time(item.timestamp)}</td><td><button data-action="inspect" data-id="${esc(item.id)}">检查 ↗</button></td></tr>`).join("")}</tbody></table></div>`:empty("没有匹配记录。");}
  private comparison():string {
    const snapshots=this.snapshots(),left=snapshots[this.a],right=this.other?.snapshots?.at(-1)??snapshots[this.b<0?snapshots.length-1:this.b];
    const options=(selected:number)=>snapshots.map((snapshot,index)=>`<option value="${index}" ${selected===index?"selected":""}>#${index+1} · ${time(snapshot.timestamp)} · ${short(snapshot.last.inputTokens)}</option>`).join("");
    const names={inputTokens:"实际输入",cachedInputTokens:"缓存读取",cacheWriteInputTokens:"缓存写入",outputTokens:"输出",reasoningOutputTokens:"Reasoning 输出",totalTokens:"总计"};
    const rows=left&&right?(Object.keys(names) as Array<keyof typeof names>).map(key=>`<tr><td>${names[key]}</td><td>${num(left.last[key])}</td><td>${num(right.last[key])}</td><td>${signed(right.last[key]-left.last[key])}</td></tr>`).join(""):"";
    return card("请求快照对比",`<div class="compare-controls"><label>快照 A<select data-field="a">${options(this.a)}</select></label><label>快照 B<select data-field="b">${options(this.b<0?snapshots.length-1:this.b)}</select></label></div><div class="filters"><select data-field="compare-session" aria-label="对比会话"><option value="">选择另一个会话</option>${this.sessions.filter(session=>session.sessionId!==this.sessionId).map(session=>`<option value="${esc(session.sessionId)}" ${this.compareSession===session.sessionId?"selected":""}>${esc(session.agentName??session.sessionId)}</option>`).join("")}</select><button data-action="compare-session" ${!this.compareSession?"disabled":""}>对比会话</button></div>${rows?`<div class="table-wrap"><table><thead><tr><th>字段</th><th>A</th><th>B</th><th>变化</th></tr></thead><tbody>${rows}</tbody></table></div>`:empty("需要有实际用量的快照。")}<p class="note">对比 Codex 实际用量字段；完整模型 messages 快照未提供。</p>`);
  }
  private body():string {
    const dashboard=this.dashboard;if(!dashboard)return empty(this.error||"正在读取 Codex 上下文…");
    switch(this.page){
      case "overview":return this.overview();
      case "timeline":return card("上下文趋势",this.trend())+card("请求时间线",`<div class="table-wrap"><table><thead><tr><th>请求</th><th>时间</th><th>实际输入</th><th>缓存读取</th><th>输出</th><th></th></tr></thead><tbody>${this.snapshots().map((snapshot,index)=>`<tr><td>#${index+1}</td><td>${time(snapshot.timestamp)}</td><td>${num(snapshot.last.inputTokens)}</td><td>${num(snapshot.last.cachedInputTokens)}</td><td>${num(snapshot.last.outputTokens)}</td><td><button data-action="snapshot" data-index="${index}">固定</button></td></tr>`).reverse().join("")}</tbody></table></div>`);
      case "records":return card("上下文浏览器",`<div class="browser-body">${this.browser()}</div>`,"保留日志，不等同于当前完整请求");
      case "sources":return card("来源记录",this.filters()+this.table(this.rows()))+card("重复长内容",(dashboard.activity?.duplicates??[]).map(group=>`<div class="event"><span>≡</span><span><strong>${group.ids.length} 条完全相同的公开文本</strong><small>多余副本 ${num(group.characters)} 字符 · Token 未提供</small></span><button data-action="inspect" data-id="${esc(group.ids[0])}">检查</button></div>`).join("")||empty("没有 ≥ 256 字符的完全重复记录。"));
      case "tools":return card("文件活动",`<div class="file-body">${this.files()}</div>`)+card("工具调用",`<div class="table-wrap"><table><thead><tr><th>工具</th><th>调用</th><th>结果</th><th>参数字符</th><th>结果字符</th></tr></thead><tbody>${(dashboard.activity?.tools??[]).map(tool=>`<tr><td>${esc(tool.name)}</td><td>${tool.calls}</td><td>${tool.results}</td><td>${num(tool.argumentCharacters)}</td><td>${num(tool.resultCharacters)}</td></tr>`).join("")}</tbody></table></div>`)+card("最大日志内容",`<div class="chart-controls"><small>按字符量排序</small><select data-field="top" aria-label="Top 数量">${[5,10,20].map(value=>`<option ${this.top===value?"selected":""} value="${value}">Top ${value}</option>`).join("")}</select></div>${this.records([...this.focusedItems()].sort((left,right)=>right.characters-left.characters).slice(0,this.top),true)}`);
      case "agents":return card("Agent 网络",this.network(),"明确的父子关系");
      case "compaction":return dashboard.compactions.length?dashboard.compactions.map(marker=>card(`上下文压缩 · ${time(marker.timestamp)}`,`<div class="three"><div><small>压缩前输入</small><strong>${num(marker.beforeTokens)}</strong></div><div><small>压缩后输入</small><strong>${num(marker.afterTokens)}</strong></div><div><small>观测减少量</small><strong>${num(marker.reducedTokens)}</strong></div></div><p class="note">触发 ${esc(marker.trigger)} · ${esc(marker.precision)}；期间新增消息也可能影响差值。</p><button data-action="compaction-compare" data-time="${esc(marker.timestamp)}">查看前后快照</button>`)).join(""):empty("未发现正式压缩事件；普通 Token 下降不被当成压缩。");
      case "compare":return this.comparison();
      case "settings":return card("显示与隐私",`<label class="setting"><span><strong>实时刷新</strong><small>每 5 秒刷新；页面隐藏时暂停。</small></span><input type="checkbox" data-field="realtime" ${this.paused?"":"checked"}></label><label class="setting"><span><strong>允许原文预览</strong><small>启用后仍需主动点击单条记录读取；每次打开默认关闭。</small></span><input type="checkbox" data-field="content" ${this.allowContent?"checked":""}></label><label class="setting"><span><strong>紧凑视图</strong><small>只显示当前占用摘要。</small></span><input type="checkbox" data-field="compact" ${this.compact?"checked":""}></label><p class="note">界面依据 dsh-context 0.62.2 源码适配。环图几何算法保留 Apache-2.0 许可；插件数据来源与 Windows 入口属于 Codex 实现。</p><a href="https://github.com/bowenliang123/dsh-context/tree/42f84915617705ccd4f1f9a0112bd5113b6089fd" target="_blank" rel="noreferrer">查看参考源码 ↗</a>`);
    }
  }
  private renderFocus():void {
    const opened=new Set([...this.root.querySelectorAll<HTMLDetailsElement>("details[open]")].map(detail=>detail.dataset.group??detail.dataset.file));
    const browser=this.root.querySelector<HTMLElement>(".browser-body");if(browser)browser.innerHTML=this.browser();
    const detail=this.root.querySelector<HTMLElement>(".request-detail");if(detail)detail.innerHTML=this.requestDetail();
    const files=this.root.querySelector<HTMLElement>(".file-body");if(files)files.innerHTML=this.files();
    this.root.querySelectorAll<HTMLDetailsElement>("details").forEach(detail=>{if(opened.has(detail.dataset.group??detail.dataset.file))detail.open=true;});
    this.root.querySelectorAll<HTMLElement>(".trend-bar").forEach(bar=>bar.classList.toggle("hovered",Number(bar.dataset.index)===this.hoveredIndex));
  }
  private render():void {
    const active=document.activeElement as HTMLInputElement|null;const focus=active?.dataset.field;const caret=active?.selectionStart??null;
    const openGroups=new Set([...this.root.querySelectorAll<HTMLDetailsElement>("details[open]")].map(detail=>detail.dataset.group??detail.dataset.file));
    const inspectorScroll=this.root.querySelector<HTMLElement>(".inspector")?.scrollTop??0;
    const dashboard=this.dashboard,usage=dashboard?.usage;
    const selection=this.projectSelection?`<div class="selection-note">${this.projectSelection==="recent-session"?"托盘入口：最近活动会话；仅切换聊天但未产生活动时，不会改变选择。":this.projectSelection==="no-project-session"?"当前项目还没有可用会话。":"项目入口：本项目最近活动会话。"}</div>`:"";
    this.root.innerHTML=`<style>${styles}</style><article class="monitor ${this.compact?"compact":""}" aria-label="CODEX CONTEXT MONITOR"><header class="header"><span class="logo" aria-hidden="true">◉</span><div><h1>上下文监控 <small>CODEX</small></h1><p>请求 · 上下文 · 文件 · Agent</p></div><div class="actions"><span class="badge ${this.preview?"demo":""}">${this.preview?"演示数据":this.paused?"已暂停":"● 本地只读"}</span><button data-action="refresh">刷新</button><button data-action="export" ${dashboard?"":"disabled"}>导出</button><button data-action="compact">${this.compact?"展开":"收起"}</button></div></header><div class="session"><label for="session-picker">会话</label><select id="session-picker" data-field="session" aria-label="选择 Session"><option value="${esc(this.sessionId)}">${esc(dashboard?.activity?.agentName??(this.sessionId||"自动选择会话"))}</option>${this.sessions.filter(session=>session.sessionId!==this.sessionId).map(session=>`<option value="${esc(session.sessionId)}">${esc(session.agentName??session.sessionId)}</option>`).join("")}</select><span class="model">${esc(usage?.model??"模型未提供")}</span><span class="badge">${esc(usage?.precision??"未提供")}</span></div><nav class="tabs" aria-label="监控导航">${Object.entries(tabs).map(([page,label])=>`<button data-page="${page}" class="${this.page===page?"active":""}" aria-current="${this.page===page?"page":"false"}">${label}</button>`).join("")}</nav><div class="summary-bar"><strong>${short(usage?.usedTokens)} / ${short(usage?.totalTokens)}</strong> · ${usage?.percentage?.toFixed(1)??"—"}%</div><main class="page">${selection}${usage?.precision==="estimated"?'<div class="notice">用量是 Codex 实际上报；当前使用最近日志回退，会话匹配待确认。</div>':""}${this.error?`<div class="notice" role="status">${esc(this.error)}</div>`:""}<div class="page-title"><strong>${tabs[this.page]}</strong><div>${this.selectedIndex>=0?`<span class="badge accent">已固定请求 #${this.selectedIndex+1}</span> <button data-action="live">返回最新</button>`:""}<small>更新 ${time(usage?.updatedAt)}</small></div></div>${this.body()}<footer class="footer"><span>Token 使用 Codex 实际上报 · 分类面积使用日志字符量</span><span>只读 · 原文按需读取 · v0.5.0</span></footer></main>${this.selectedItem?this.inspector():""}</article>`;
    this.root.querySelectorAll<HTMLDetailsElement>("details").forEach(detail=>{if(openGroups.has(detail.dataset.group??detail.dataset.file))detail.open=true;});
    const inspector=this.root.querySelector<HTMLElement>(".inspector");if(inspector)inspector.scrollTop=inspectorScroll;
    if(focus==="query"||focus==="file-query"){const input=this.root.querySelector<HTMLInputElement>(`[data-field="${focus}"]`);input?.focus();if(caret!==null)input?.setSelectionRange(caret,caret);}
    if(!this.local&&!this.preview)this.notify("ui/notifications/size-changed",{height:Math.min(1800,this.root.scrollHeight),width:this.root.clientWidth});
  }
  private inspector():string {
    const item=this.selectedItem!;
    return `<aside class="inspector" role="dialog" aria-label="记录检查器"><div class="card-head"><h3>记录检查器</h3><button data-action="close-inspector" aria-label="关闭检查器">×</button></div><span class="badge">${labels[item.category]}</span><h3>${esc(item.name)}</h3><dl>${[["类型",item.type],["角色",item.role??"未提供"],["消息 ID",item.messageId??"未提供"],["调用 ID",item.callId??"未提供"],["记录 ID",item.id],["时间",time(item.timestamp)],["字符数",num(item.characters)],["分类 Token","未提供"],["文件",item.file??"未提供"]].map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl><p class="note">这条记录可能已经被模型压缩；日志记录不等同于当前模型上下文。</p><button data-action="reveal" ${this.allowContent?"":"disabled"}>读取这条记录的原文</button>${this.allowContent?"":'<p class="muted">原文默认隐藏，可在设置中启用。</p>'}${this.content!==null?`<pre>${esc(this.content)}</pre><button data-action="export-item">导出这条记录</button>`:""}</aside>`;
  }
  private async click(event:Event):Promise<void> {
    const target=(event.target as HTMLElement).closest<HTMLButtonElement>("button");if(!target)return;
    if(target.dataset.page&&target.dataset.page in tabs){this.page=target.dataset.page as Page;this.hoveredIndex=null;this.render();return;}
    const action=target.dataset.action;
    if(action==="refresh"){await this.refresh();await this.loadSessions();return;}
    if(action==="export"){download(this.dashboard,"codex-context-report.json");return;}
    if(action==="compact")this.compact=!this.compact;
    if(action==="granularity")this.byTurn=target.dataset.value==="turn";
    if(action==="trend-mode")this.delta=target.dataset.value==="delta";
    if(action==="dna")this.dna=!this.dna;
    if(action==="browser-diff")this.showDiff=!this.showDiff;
    if(action==="event-filter")this.eventKind=target.dataset.value??"all";
    if(action==="file-filter")this.fileKind=target.dataset.value??"all";
    if(action==="snapshot"){this.selectedIndex=Number(target.dataset.index);this.hoveredIndex=null;}
    if(action==="live"){this.selectedIndex=-1;this.hoveredIndex=null;}
    if(action==="inspect"){this.selectedItem=this.dashboard?.activity?.items.find(item=>item.id===target.dataset.id)??null;this.content=null;this.contentVersion++;}
    if(action==="close-inspector"){this.selectedItem=null;this.content=null;this.contentVersion++;}
    if(action==="reveal"&&this.allowContent&&this.selectedItem){
      const item=this.selectedItem,version=++this.contentVersion;this.content="读取中…";this.render();
      try{const result=obj(await this.callTool("read_context_item",{sessionId:this.sessionId,itemId:item.id,confirmReveal:true}));const data=obj(result?.structuredContent);if(this.contentVersion!==version||!this.allowContent)return;this.content=typeof data?.text==="string"?data.text+(data.truncated?"\n[已截取前 32,768 字符]":""):"未记录可展示的公开文本。";}catch(error){if(this.contentVersion===version)this.content=String(error);}
    }
    if(action==="export-item"&&this.content!==null)download({metadata:this.selectedItem,text:this.content},"codex-context-item.json");
    if(action==="session"&&target.dataset.id){await this.switchSession(target.dataset.id);return;}
    if(action==="compaction-compare"){
      const timestamp=Date.parse(target.dataset.time??"");const snapshots=this.snapshots();let before=-1;snapshots.forEach((snapshot,index)=>{if(Date.parse(snapshot.timestamp)<timestamp)before=index;});const after=snapshots.findIndex(snapshot=>Date.parse(snapshot.timestamp)>timestamp);
      if(before<0||after<0)this.error="保留范围内缺少压缩前或后的快照，无法对比。";else{this.a=before;this.b=after;this.other=null;this.error="";this.page="compare";}
    }
    if(action==="compare-session"&&this.compareSession)try{const value=obj(await this.callTool("get_context_usage",{sessionId:this.compareSession}))?.structuredContent;if(isDashboard(value))this.other=value;}catch(error){this.error=String(error);}
    this.render();
  }
  private async change(event:Event):Promise<void> {
    const input=event.target as HTMLInputElement;
    switch(input.dataset.field){
      case "session":await this.switchSession(input.value);return;
      case "category":this.category=input.value;break;
      case "focus":this.selectedIndex=Number(input.value);this.hoveredIndex=null;break;
      case "file-sort":this.fileSort=input.value;break;
      case "top":this.top=Number(input.value);break;
      case "a":this.a=Number(input.value);break;
      case "b":this.b=Number(input.value);this.other=null;break;
      case "compare-session":this.compareSession=input.value;break;
      case "realtime":this.paused=!input.checked;break;
      case "content":this.allowContent=input.checked;this.content=null;this.contentVersion++;break;
      case "compact":this.compact=input.checked;break;
      default:return;
    }this.render();
  }
  private async switchSession(id:string):Promise<void> {this.sessionId=id;this.projectSelection="";this.selectedItem=null;this.content=null;this.contentVersion++;this.other=null;this.a=0;this.b=-1;this.selectedIndex=-1;this.hoveredIndex=null;this.dashboard=null;this.sequence++;await this.refresh(true);}

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
