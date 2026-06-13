// The single-page web UI for the LAN/phone head, shipped as TS string constants
// so it bundles into the single binary with no static files and no build step.
//
// Design identity — "the band plan": a calm, deliberate chat surface for an
// amateur-radio packet client. Deep ink background with a single warm amber
// signal accent (the "carrier"); callsigns and timestamps set in a monospace
// "log" face, message bodies in a humanist sans for readability. A three-pane
// desktop layout (rail · stream · roster) that collapses to one focused column
// on a phone, with a back-affordance and a presence dot that pulses on the live
// SSE link. All fetch/EventSource URLs are RELATIVE so the app works at "/"
// standalone and under the app-gateway "/apps/whatspac/" prefix unchanged.

/** The full HTML document served at GET "/". */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<base href="./" />
<title>WhatsPac</title>
<style>${CSS()}</style>
</head>
<body>
<div id="app" data-view="channels">
  <!-- Top bar: identity + live-link indicator -->
  <header class="topbar">
    <button class="back" id="back" aria-label="Back" hidden>&#8249;</button>
    <div class="brand">
      <span class="sigil" aria-hidden="true"></span>
      <span class="wordmark">WhatsPac</span>
    </div>
    <div class="ident" id="ident" title="Connection">
      <span class="link-dot" id="linkDot"></span>
      <span class="call" id="meCall">&mldr;</span>
    </div>
  </header>

  <main class="frame">
    <!-- Rail: tabs + conversation/channel list -->
    <nav class="rail" id="rail">
      <div class="tabs" role="tablist">
        <button class="tab is-active" id="tabChannels" role="tab">Channels</button>
        <button class="tab" id="tabDms" role="tab">Direct</button>
      </div>
      <div class="list" id="list" aria-live="polite"></div>
    </nav>

    <!-- Stream: the open channel/DM timeline + composer -->
    <section class="stream" id="stream">
      <div class="stream-head" id="streamHead">
        <div class="sh-title" id="shTitle">Select a channel</div>
        <div class="sh-meta" id="shMeta"></div>
        <button class="sub-toggle" id="subToggle" hidden></button>
      </div>
      <div class="timeline" id="timeline">
        <div class="empty" id="emptyStream">
          <span class="sigil big" aria-hidden="true"></span>
          <p>Pick a channel or a contact to start.</p>
        </div>
      </div>
      <form class="composer" id="composer" hidden autocomplete="off">
        <input id="msg" class="msg" placeholder="Message&hellip;" maxlength="2048" />
        <button class="send" id="send" type="submit" aria-label="Send">&#10148;</button>
      </form>
    </section>

    <!-- Roster: who's on the air -->
    <aside class="roster" id="roster">
      <div class="roster-head">On the air <span class="count" id="onCount">0</span></div>
      <div class="roster-list" id="rosterList"></div>
    </aside>
  </main>

  <div class="toast" id="toast" role="status"></div>
</div>
<script>${JS()}</script>
</body>
</html>`;

function CSS(): string {
  return `
:root{
  --ink:#0d1117; --ink-2:#141b24; --ink-3:#1b2531; --line:#26313d;
  --fg:#e6edf3; --fg-dim:#8b97a4; --fg-faint:#5b6672;
  --carrier:#f0a500; --carrier-soft:#f0a50022; --carrier-line:#f0a50055;
  --me:#1f6feb; --me-soft:#1f6feb1a; --good:#3fb950; --bad:#f85149;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --r:12px; --sp:14px;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{
  font-family:var(--sans); color:var(--fg); background:var(--ink);
  -webkit-font-smoothing:antialiased; overscroll-behavior:none;
}
#app{
  display:grid; height:100dvh;
  grid-template-rows:auto 1fr;
}

/* ---- top bar ---- */
.topbar{
  display:flex; align-items:center; gap:12px; padding:10px 16px;
  border-bottom:1px solid var(--line); background:var(--ink-2);
  padding-top:max(10px,env(safe-area-inset-top));
}
.back{
  display:none; background:none; border:0; color:var(--fg); font-size:26px;
  line-height:1; cursor:pointer; padding:0 6px 0 0; margin-left:-4px;
}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;letter-spacing:.2px}
.wordmark{font-size:16px}
.sigil{
  width:14px;height:14px;border-radius:3px;
  background:conic-gradient(from 210deg,var(--carrier),#ffd86b,var(--carrier));
  box-shadow:0 0 12px var(--carrier-soft);
}
.sigil.big{width:34px;height:34px;border-radius:8px;opacity:.5}
.ident{
  margin-left:auto; display:flex; align-items:center; gap:8px;
  font-family:var(--mono); font-size:13px; color:var(--fg-dim);
}
.call{color:var(--fg)}
.link-dot{
  width:9px;height:9px;border-radius:50%;background:var(--fg-faint);
  transition:background .3s,box-shadow .3s;
}
.link-dot.live{background:var(--good);box-shadow:0 0 0 0 var(--good);animation:pulse 2.4s infinite}
.link-dot.down{background:var(--bad)}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 #3fb95066} 70%{box-shadow:0 0 0 7px #3fb95000} 100%{box-shadow:0 0 0 0 #3fb95000}
}

/* ---- frame ---- */
.frame{
  display:grid; min-height:0;
  grid-template-columns:minmax(220px,300px) 1fr minmax(180px,240px);
}
.rail{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line);background:var(--ink-2)}
.tabs{display:flex;padding:10px 10px 0;gap:6px}
.tab{
  flex:1; padding:9px 8px; border:0; border-radius:9px 9px 0 0; cursor:pointer;
  background:transparent; color:var(--fg-dim); font:inherit; font-weight:600; font-size:13.5px;
  border-bottom:2px solid transparent;
}
.tab.is-active{color:var(--fg);border-bottom-color:var(--carrier)}
.list{flex:1;overflow:auto;padding:8px}

.row{
  display:flex; align-items:center; gap:11px; width:100%; text-align:left;
  padding:10px 11px; border-radius:var(--r); border:0; background:transparent;
  color:inherit; font:inherit; cursor:pointer; margin-bottom:2px;
}
.row:hover{background:var(--ink-3)}
.row.is-active{background:var(--carrier-soft);box-shadow:inset 0 0 0 1px var(--carrier-line)}
.row .ava{
  flex:0 0 38px;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
  font-family:var(--mono);font-size:13px;font-weight:600;color:var(--ink);
  background:linear-gradient(140deg,var(--carrier),#ffcf5c);
}
.row.chan .ava{background:linear-gradient(140deg,#2b3a4b,#384a5e);color:var(--carrier);font-size:16px}
.row .meta{min-width:0;flex:1}
.row .name{font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .sub{font-size:12.5px;color:var(--fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.row .name .cid{font-family:var(--mono);font-size:12px;color:var(--fg-faint);font-weight:500}
.pill{
  font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:20px;
  border:1px solid var(--line);color:var(--fg-faint);
}
.pill.on{color:var(--carrier);border-color:var(--carrier-line)}

/* ---- stream ---- */
.stream{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--ink)}
.stream-head{
  display:flex;align-items:center;gap:12px;padding:13px 18px;border-bottom:1px solid var(--line);
  min-height:54px;
}
.sh-title{font-weight:650;font-size:15.5px}
.sh-title .cid{font-family:var(--mono);font-size:12.5px;color:var(--fg-faint);margin-left:6px}
.sh-meta{font-family:var(--mono);font-size:12px;color:var(--fg-dim);margin-left:auto}
.sub-toggle{
  margin-left:12px;padding:6px 13px;border-radius:20px;cursor:pointer;font:inherit;font-size:12.5px;
  font-weight:600;background:transparent;border:1px solid var(--carrier-line);color:var(--carrier);
}
.sub-toggle.is-sub{background:var(--carrier-soft)}
.sub-toggle.is-sub::before{content:"\\2713  "}

.timeline{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:3px}
.empty{margin:auto;text-align:center;color:var(--fg-faint);display:flex;flex-direction:column;gap:12px;align-items:center}
.empty p{margin:0;font-size:14px}

.post{max-width:74%;padding:9px 13px 8px;border-radius:14px;background:var(--ink-2);align-self:flex-start;
  border:1px solid var(--line)}
.post.mine{align-self:flex-end;background:var(--me-soft);border-color:#1f6feb44}
.post .who{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--carrier);margin-bottom:3px;
  display:flex;gap:8px;align-items:baseline}
.post.mine .who{color:#79b0ff}
.post .who .at{color:var(--fg-faint);font-weight:500}
.post .body{font-size:14.5px;line-height:1.42;white-space:pre-wrap;word-break:break-word}
.post .stamp{font-family:var(--mono);font-size:10px;color:var(--fg-faint);margin-top:4px;text-align:right}
.daysep{align-self:center;font-family:var(--mono);font-size:10.5px;color:var(--fg-faint);
  padding:8px 0 4px;letter-spacing:.5px;text-transform:uppercase}

/* ---- composer ---- */
.composer{display:flex;gap:9px;padding:12px 16px;border-top:1px solid var(--line);background:var(--ink-2);
  padding-bottom:max(12px,env(safe-area-inset-bottom))}
.msg{flex:1;background:var(--ink);border:1px solid var(--line);border-radius:22px;color:var(--fg);
  padding:11px 16px;font:inherit;font-size:15px;outline:none}
.msg:focus{border-color:var(--carrier-line);box-shadow:0 0 0 3px var(--carrier-soft)}
.send{flex:0 0 44px;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;font-size:17px;
  background:var(--carrier);color:var(--ink);font-weight:700}
.send:disabled{opacity:.4;cursor:default}

/* ---- roster ---- */
.roster{display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--line);background:var(--ink-2)}
.roster-head{padding:14px 16px 10px;font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
  color:var(--fg-dim);display:flex;align-items:center;gap:8px}
.count{font-family:var(--mono);font-size:11px;color:var(--ink);background:var(--carrier);border-radius:20px;
  padding:1px 8px;font-weight:700}
.roster-list{overflow:auto;padding:0 10px 14px}
.op{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:9px;cursor:pointer}
.op:hover{background:var(--ink-3)}
.op .dot{width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:0 0 6px #3fb95088;flex:0 0 8px}
.op .c{font-family:var(--mono);font-size:13px}
.op .n{font-size:12px;color:var(--fg-dim);margin-left:auto;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:90px}

/* ---- toast ---- */
.toast{
  position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;pointer-events:none;
  background:var(--ink-3);border:1px solid var(--line);color:var(--fg);padding:10px 16px;border-radius:11px;
  font-size:13.5px;transition:.25s;box-shadow:0 8px 30px #0008;max-width:88vw;z-index:50;
}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{border-color:var(--bad);color:#ffb4ae}

/* ---- responsive: phone = single focused column ---- */
@media (max-width:860px){
  .frame{grid-template-columns:1fr}
  .roster{display:none}
  .stream{display:none}
  #app[data-view="stream"] .rail{display:none}
  #app[data-view="stream"] .stream{display:flex}
  #app[data-view="stream"] .back{display:block}
}
`;
}

function JS(): string {
  // Vanilla, dependency-free. RELATIVE fetch/EventSource URLs throughout so the
  // page works at "/" and behind the gateway prefix unchanged.
  return String.raw`
"use strict";
const $ = (id) => document.getElementById(id);
const app = $("app");
const state = {
  me: "", scope: null,
  tab: "channels",
  channels: [], conversations: [], online: [], hams: {},
  open: null,              // {kind:'channel'|'dm', id, peer?, cn?, subscribed?}
  posts: [], dms: [],
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));
const initials = (c) => esc(String(c||"?").replace(/-.*$/,"").slice(0,2).toUpperCase());
function hamName(c){ const h=state.hams[c]; return h && h.n ? h.n : null; }

function fmtTime(ts){
  // posts are ms, DMs are seconds — normalise to ms.
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms); if (isNaN(d)) return "";
  return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}
function dayKey(ts){ const ms = ts>1e12?ts:ts*1000; const d=new Date(ms);
  return isNaN(d)?"":d.toLocaleDateString([], {weekday:"short", month:"short", day:"numeric"}); }

let toastT;
function toast(msg, bad){
  const el=$("toast"); el.textContent=msg; el.className="toast show"+(bad?" bad":"");
  clearTimeout(toastT); toastT=setTimeout(()=>el.className="toast",2600);
}

async function api(path, opts){
  const r = await fetch(path, opts);
  if (!r.ok){
    let detail=""; try{ detail=(await r.json()).error||""; }catch(_){}
    throw new Error(detail || (r.status+" "+r.statusText));
  }
  return r.status===204 ? null : r.json();
}
const canWrite = () => state.scope===null || state.scope==="operate" || state.scope==="admin";

// ---------- data loads ----------
async function loadStatus(){
  try{
    const s = await api("api/status");
    state.me = s.callsign || "";
    state.scope = s.scope ?? null;
    $("meCall").textContent = s.viewer ? s.viewer : (state.me || "—");
    if (!canWrite()) document.body.classList.add("readonly");
  }catch(e){ /* shown via link dot */ }
}
async function loadChannels(){ state.channels = await api("api/channels"); if(state.tab==="channels") renderList(); }
async function loadConversations(){ state.conversations = await api("api/conversations"); if(state.tab==="dms") renderList(); }
async function loadRoster(){
  const data = await api("api/status").then(()=>api("api/online")).catch(()=>null);
}

// ---------- list (rail) ----------
function setTab(t){
  state.tab=t;
  $("tabChannels").classList.toggle("is-active", t==="channels");
  $("tabDms").classList.toggle("is-active", t==="dms");
  renderList();
}
function renderList(){
  const list=$("list");
  if (state.tab==="channels"){
    if(!state.channels.length){ list.innerHTML='<div class="empty" style="padding:30px"><p>No channels yet.</p></div>'; return; }
    list.innerHTML = state.channels.map((c)=>{
      const active = state.open && state.open.kind==="channel" && state.open.id===c.cid;
      const name = esc(c.cn || c.cid);
      const cid = c.cn ? '<span class="cid">#'+esc(c.cid)+'</span>' : '';
      const pill = c.subscribed ? '<span class="pill on">SUB</span>' : '';
      return '<button class="row chan'+(active?' is-active':'')+'" data-cid="'+esc(c.cid)+'">'+
        '<span class="ava">#</span><span class="meta"><div class="name">'+name+' '+cid+'</div>'+
        '<div class="sub">'+(c.subscribed?"subscribed":"tap to open")+'</div></span>'+pill+'</button>';
    }).join("");
    list.querySelectorAll(".row").forEach((b)=>b.onclick=()=>openChannel(b.dataset.cid));
  } else {
    if(!state.conversations.length){ list.innerHTML='<div class="empty" style="padding:30px"><p>No direct messages.<br>Tap a callsign on the right to start one.</p></div>'; return; }
    list.innerHTML = state.conversations.map((c)=>{
      const active = state.open && state.open.kind==="dm" && state.open.peer===c.peer;
      const nm = hamName(c.peer);
      return '<button class="row'+(active?' is-active':'')+'" data-peer="'+esc(c.peer)+'">'+
        '<span class="ava">'+initials(c.peer)+'</span><span class="meta">'+
        '<div class="name">'+esc(c.peer)+(nm?' <span class="cid">'+esc(nm)+'</span>':'')+'</div>'+
        '<div class="sub">'+esc(c.lastText)+'</div></span></button>';
    }).join("");
    list.querySelectorAll(".row").forEach((b)=>b.onclick=()=>openDm(b.dataset.peer));
  }
}

// ---------- stream ----------
async function openChannel(cid){
  const ch = state.channels.find((c)=>c.cid===cid) || { cid };
  state.open = { kind:"channel", id:cid, cn:ch.cn, subscribed:!!ch.subscribed };
  app.dataset.view="stream"; renderList();
  $("shTitle").innerHTML = esc(ch.cn||cid) + (ch.cn?'<span class="cid">#'+esc(cid)+'</span>':'');
  const tog=$("subToggle"); tog.hidden=false;
  tog.textContent = ch.subscribed ? "Subscribed" : "Subscribe";
  tog.classList.toggle("is-sub", !!ch.subscribed);
  tog.onclick = ()=>toggleSub(cid, !state.open.subscribed);
  showComposer(true);
  try{ state.posts = await api("api/channels/"+encodeURIComponent(cid)+"/posts"); }
  catch(e){ state.posts=[]; toast("Couldn't load posts: "+e.message, true); }
  renderTimeline("channel");
}
async function openDm(peer){
  state.open = { kind:"dm", id:peer, peer };
  app.dataset.view="stream"; setTab("dms");
  $("shTitle").innerHTML = esc(peer) + (hamName(peer)?'<span class="cid">'+esc(hamName(peer))+'</span>':'');
  $("subToggle").hidden=true; showComposer(true);
  try{ state.dms = await api("api/conversations/"+encodeURIComponent(peer)+"/messages"); }
  catch(e){ state.dms=[]; toast("Couldn't load messages: "+e.message, true); }
  renderTimeline("dm");
}
function showComposer(on){
  const f=$("composer"); f.hidden=!on;
  if(on && !canWrite()){ f.hidden=true; $("shMeta").textContent="read-only"; }
}
function renderTimeline(kind){
  const tl=$("timeline");
  const items = kind==="channel"
    ? state.posts.map((p)=>({who:p.fc, name:p.senderName, body:p.p, ts:p.ts}))
    : state.dms.map((m)=>({who:m.fc, body:m.m, ts:m.ts}));
  // store returns newest-first; render oldest-first.
  items.reverse();
  if(!items.length){ tl.innerHTML='<div class="empty" style="margin:auto"><p>No messages yet — say hello.</p></div>';
    return; }
  let html="", lastDay="";
  for(const it of items){
    const dk=dayKey(it.ts);
    if(dk && dk!==lastDay){ html+='<div class="daysep">'+esc(dk)+'</div>'; lastDay=dk; }
    const mine = it.who===state.me;
    const nm = it.name || hamName(it.who);
    html += '<div class="post'+(mine?' mine':'')+'">'+
      (mine?'':'<div class="who">'+esc(it.who)+(nm?' <span class="at">'+esc(nm)+'</span>':'')+'</div>')+
      '<div class="body">'+esc(it.body)+'</div>'+
      '<div class="stamp">'+esc(fmtTime(it.ts))+'</div></div>';
  }
  tl.innerHTML=html; tl.scrollTop=tl.scrollHeight;
}

async function toggleSub(cid, want){
  try{
    await api("api/channels/"+encodeURIComponent(cid)+"/subscription",
      { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({subscribed:want}) });
    const ch=state.channels.find((c)=>c.cid===cid); if(ch) ch.subscribed=want;
    if(state.open) state.open.subscribed=want;
    const tog=$("subToggle"); tog.textContent=want?"Subscribed":"Subscribe"; tog.classList.toggle("is-sub",want);
    renderList();
  }catch(e){ toast(e.message, true); }
}

// ---------- composer submit ----------
$("composer").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const input=$("msg"); const text=input.value.trim();
  if(!text || !state.open) return;
  input.value=""; input.focus();
  try{
    if(state.open.kind==="channel"){
      await api("api/channels/"+encodeURIComponent(state.open.id)+"/posts",
        { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({text}) });
    } else {
      await api("api/dm",
        { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({to:state.open.peer, text}) });
    }
  }catch(err){ input.value=text; toast("Send failed: "+err.message, true); }
});

// ---------- roster ----------
function renderRoster(){
  $("onCount").textContent=state.online.length;
  const el=$("rosterList");
  if(!state.online.length){ el.innerHTML='<div style="padding:8px 10px;color:var(--fg-faint);font-size:13px">Nobody online.</div>'; return; }
  el.innerHTML = state.online.map((c)=>{
    const nm=hamName(c);
    return '<div class="op" data-peer="'+esc(c)+'"><span class="dot"></span>'+
      '<span class="c">'+esc(c)+'</span>'+(nm?'<span class="n">'+esc(nm)+'</span>':'')+'</div>';
  }).join("");
  el.querySelectorAll(".op").forEach((o)=>o.onclick=()=>openDm(o.dataset.peer));
}

// ---------- live stream (SSE) ----------
function connectEvents(){
  const dot=$("linkDot");
  const es=new EventSource("api/events");
  es.addEventListener("open", ()=>{ dot.className="link-dot live"; });
  es.addEventListener("error", ()=>{ dot.className="link-dot down"; });
  es.addEventListener("status", (e)=>{
    const d=JSON.parse(e.data);
    dot.className="link-dot "+(d.status==="running"?"live":(d.status==="stopped"?"down":""));
  });
  es.addEventListener("presence", (e)=>{ state.online=JSON.parse(e.data).online||[]; renderRoster(); });
  es.addEventListener("post", (e)=>{
    const p=JSON.parse(e.data);
    if(state.open && state.open.kind==="channel" && state.open.id===p.cid){
      state.posts.unshift(p); renderTimeline("channel");
    }
    loadChannels();
  });
  es.addEventListener("message", (e)=>{
    const m=JSON.parse(e.data);
    const peer = m.fc===state.me ? m.tc : m.fc;
    if(state.open && state.open.kind==="dm" && state.open.peer===peer){
      state.dms.unshift(m); renderTimeline("dm");
    }
    loadConversations();
  });
  return es;
}

// ---------- boot ----------
$("tabChannels").onclick=()=>setTab("channels");
$("tabDms").onclick=()=>setTab("dms");
$("back").onclick=()=>{ app.dataset.view="channels"; state.open=null; renderList(); };
$("send").disabled=false;

(async function boot(){
  await loadStatus();
  // hams come in via SSE/avatars over time; seed display names lazily.
  try{ const r=await api("api/online"); state.online=r.online||[]; state.hams=r.hams||{}; }catch(_){}
  renderRoster();
  await Promise.all([ loadChannels().catch(()=>{}), loadConversations().catch(()=>{}) ]);
  connectEvents();
})();
`;
}
