// frontend/src/App.jsx
import React, { useEffect, useMemo, useRef, useState, memo } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ClaudeAnswer from "./components/ClaudeAnswer";
import AutoCorrectPill from "./components/AutoCorrectPill";

const API = "https://aee3bb93b326.ngrok-free.app"; 
const STORAGE_KEY = "nebula_sessions_v5";

// ---- utils ----
const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
const titleOf = (s) => (trim(s).slice(0, 64) || "Untitled");
let uidCounter = 0;
const uid = () => `m_${Date.now()}_${uidCounter++}`;

// ---- icons ----
const Icon = {
  Plus:(p)=>(<svg viewBox="0 0 24 24" width="16" height="16" {...p}><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>),
  Trash:(p)=>(<svg viewBox="0 0 24 24" width="15" height="15" {...p}><path fill="currentColor" d="M9 3h6l1 2h5v2H3V5h5l1-2Zm1 7h2v8h-2v-8Zm6 0h-2v8h2v-8Zm-10 0h2v8H6v-8Z"/></svg>),
  Send:(p)=>(<svg viewBox="0 0 24 24" width="18" height="18" {...p}><path fill="currentColor" d="M2 21 23 12 2 3v7l15 2-15 2z"/></svg>),
  Pencil:(p)=>(<svg viewBox="0 0 24 24" width="14" height="14" {...p}><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41L18.37 3.3a1 1 0 0 0-1.41 0L15 5.25l3.75 3.75 1.96-1.96z"/></svg>),
};

// ---- Claude-style loader ----
const ClaudeLoader = ({ statusLine, plan, progress }) => (
  <div className="relative max-w-3xl rounded-3xl border border-white/10 bg-slate-800/40 p-5 overflow-hidden">
    <div className="flex items-center justify-between mb-3">
      <div className="inline-flex items-center gap-2 rounded-full px-3 py-1 bg-white/10 border border-white/10">
        <span className="h-2.5 w-2.5 rounded-full bg-fuchsia-400 animate-dot" style={{animationDelay:"0ms"}} />
        <span className="h-2.5 w-2.5 rounded-full bg-cyan-300 animate-dot" style={{animationDelay:"150ms"}} />
        <span className="h-2.5 w-2.5 rounded-full bg-indigo-300 animate-dot" style={{animationDelay:"300ms"}} />
        <span className="text-xs text-slate-300 ml-2">{statusLine || "Thinking…"}</span>
      </div>
      <div className="text-xs text-slate-300">{Math.max(0,Math.min(100,progress||0)).toFixed(0)}%</div>
    </div>
    {plan?.steps?.length > 0 && (
      <ul className="mb-3 space-y-1 text-sm">
        {plan.steps.map((s, i) => {
          const stepPct = ((i + 1) / plan.steps.length) * 100;
          const done = (progress || 0) >= stepPct - 1;
          return (
            <li key={i} className="flex items-start gap-2">
              <span className={`mt-0.5 h-4 w-4 rounded-full border ${done ? "bg-emerald-400/80 border-emerald-300" : "bg-white/10 border-white/20"}`} />
              <span className={done ? "text-slate-200" : "text-slate-400"}>{s}</span>
            </li>
          );
        })}
      </ul>
    )}
    <div className="space-y-2">
      <div className="h-3 w-5/6 bg-white/10 rounded" />
      <div className="h-3 w-2/3 bg-white/10 rounded" />
      <div className="h-3 w-4/5 bg-white/10 rounded" />
    </div>
    <div className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-3xl">
      <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-sweep" />
    </div>
  </div>
);

// ---- Memoized bubbles ----
const UserBubble = memo(function UserBubble({ text }) {
  return (
    <div className="max-w-3xl ml-auto rounded-3xl px-5 py-3 bg-gradient-to-r from-fuchsia-700/40 to-indigo-700/40 border border-fuchsia-500/30">
      <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
    </div>
  );
});

// ---- storage helpers ----
const loadSessions = () => { try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]"); }catch{ return []; } };
const saveSessions = (s) => { try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }catch{} };

export default function App(){
  const [sessions, setSessions] = useState(loadSessions());
  const [currentId, setCurrentId] = useState(sessions[0]?.id || null);
  const current = useMemo(()=> sessions.find(s=>s.id===currentId) || null, [sessions, currentId]);

  const [mode, setMode] = useState(current?.mode || "thorough");
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");   // idle | thinking | done | error | stopped
  const [elapsed, setElapsed] = useState(0);
  const [copiedId, setCopiedId] = useState(null);
  const [showResearch, setShowResearch] = useState(true);
  const [renaming, setRenaming] = useState(null);

  // Reasoning View
  const [plan, setPlan] = useState({ intent: null, steps: [] });
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState("");

  // Autocorrect (server suggestion + visible applied pill)
  const [autoCorrectOn, setAutoCorrectOn] = useState(true);
  const [suggestion, setSuggestion] = useState("");
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [ac, setAc] = useState(null); // {original, corrected}
  const suggestTimerRef = useRef(null);

  // streams & timers
  const esRef = useRef(null);
  const runIdRef = useRef(null);
  const timerRef = useRef(null);
  const t0Ref = useRef(0);

  // persist sessions
  useEffect(()=>saveSessions(sessions),[sessions]);
  useEffect(()=>{ if(!currentId) return; setSessions(prev=>prev.map(s=>s.id===currentId?{...s,mode}:s)); },[mode]); // eslint-disable-line

  const startTimer = ()=>{
    t0Ref.current = performance.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(()=> setElapsed((performance.now()-t0Ref.current)/1000), 100);
  };
  const stopTimer = ()=>{ if (timerRef.current) clearInterval(timerRef.current); };

  const ensureSession = (prompt)=>{
    if (current) return current.id;
    const id = uid();
    const s = { id, title: titleOf(prompt||"New chat"), mode, messages: [], trace: [], createdAt: Date.now() };
    setSessions(prev=>[s,...prev]); setCurrentId(id); return id;
  };

  const newChat = ()=>{ setCurrentId(null); setStatus("idle"); setElapsed(0); setQuestion(""); };
  const deleteSession=(id)=>{ setSessions(prev=>prev.filter(s=>s.id!==id)); if(currentId===id) setCurrentId(sessions.find(s=>s.id!==id)?.id||null); };
  const renameSession=(id,name)=> setSessions(prev=>prev.map(s=>s.id===id?{...s,title: titleOf(name)}:s));
  const appendTrace=(id,ev)=> setSessions(prev=>prev.map(s=>s.id===id?{...s,trace:[...(s.trace||[]),ev]}:s));

  // Stop
  function stopRun() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    stopTimer();
    setStatus("stopped");
    if (runIdRef.current) appendTrace(runIdRef.current, { type: "status", data: { state: "Stopped by user" } });
  }
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && status === "thinking") stopRun(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  // Autocorrect (debounced server suggestion)
  function requestAutocorrect(text){
    if (!autoCorrectOn){ setSuggestion(""); return; }
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(async ()=>{
      try{
        setSuggestLoading(true);
        const res = await fetch(`${API}/api/autocorrect?`+new URLSearchParams({q:text}));
        const j = await res.json();
        const sugg = (j?.suggestion || "").trim();
        if (sugg && sugg !== text.trim()) setSuggestion(sugg);
        else setSuggestion("");
      }catch{ setSuggestion(""); }
      finally{ setSuggestLoading(false); }
    }, 300);
  }

  // Send
  function send(){
    const raw = trim(question);
    if(!raw) return;

    // apply autocorrect if available, show pill
    let q = raw;
    if (autoCorrectOn && suggestion && suggestion !== raw) {
      setAc({ original: raw, corrected: suggestion });
      q = suggestion;
    } else {
      setAc(null);
    }
    setSuggestion("");

    const id = ensureSession(q);
    runIdRef.current = id;
    setSessions(prev=>prev.map(s=>s.id===id?{...s,title:s.messages.length?s.title:titleOf(q),messages:[...s.messages,{id:uid(),role:"user",content:q}],trace:[]}:s));
    setQuestion(""); setStatus("thinking"); setElapsed(0); setPlan({ intent: null, steps: [] }); setProgress(0); setStatusLine(""); startTimer();

    if (esRef.current){ esRef.current.close(); esRef.current=null; }
    const es = new EventSource(`${API}/api/stream_chat?`+new URLSearchParams({question:q,mode}));
    esRef.current = es;

    es.addEventListener("plan", (ev)=>{ const d=JSON.parse(ev.data); setPlan({intent:d.intent, steps:d.steps||[]}); appendTrace(id,{type:"plan",data:d}); });
    es.addEventListener("progress", (ev)=>{ const d=JSON.parse(ev.data); if(typeof d.pct==="number") setProgress(d.pct); });
    es.addEventListener("status", (ev)=>{ const d=JSON.parse(ev.data); setStatusLine(d?.state||""); appendTrace(id,{type:"status",data:d}); });
    es.addEventListener("queries",(ev)=> appendTrace(id,{type:"queries",data:JSON.parse(ev.data)}));
    es.addEventListener("search", (ev)=> appendTrace(id,{type:"search", data:JSON.parse(ev.data)}));
    es.addEventListener("read",   (ev)=> appendTrace(id,{type:"read",   data:JSON.parse(ev.data)}));
    es.addEventListener("extract",(ev)=> appendTrace(id,{type:"extract",data:JSON.parse(ev.data)}));
    es.addEventListener("rationale",(ev)=> appendTrace(id,{type:"rationale",data:JSON.parse(ev.data)}));

    es.addEventListener("final",  (ev)=>{
      const d = JSON.parse(ev.data);
      setSessions(prev=>prev.map(s=> s.id===id ? {...s, messages:[...s.messages, {id:uid(), role:"assistant", content:d.answer, citations:d.citations}]} : s));
      setProgress(100); setStatus("done"); stopTimer(); es.close();
      setTimeout(()=> setProgress(0), 800);
    });
    es.addEventListener("error",  ()=>{
      appendTrace(id, {type:"error", data:{message:"Network/server error"}});
      setStatus("error"); stopTimer(); es.close();
    });
  }

  useEffect(()=>()=>{ if (esRef.current) esRef.current.close(); stopTimer(); },[]);

  const messages = current?.messages || [];
  const trace = current?.trace || [];
  const asOf = new Date().toISOString().slice(0,10);

  // Memoized chat list to avoid flicker (now uses ClaudeAnswer)
  const chatList = useMemo(()=>(
    messages.map((msg)=>(
      msg.role==="user" ? (
        <UserBubble key={msg.id} text={msg.content} />
      ) : (
        <ClaudeAnswer
          key={msg.id}
          content={msg.content}
          citations={msg.citations}
          asOf={asOf}
          onCopy={async()=>{ await navigator.clipboard.writeText(msg.content||""); setCopiedId(msg.id); setTimeout(()=>setCopiedId(null),1200); }}
        />
      )
    ))
  ),[messages, copiedId, asOf]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-40 backdrop-blur bg-white/5 border-b border-fuchsia-500/20 flex items-center justify-between px-4 lg:px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-tr from-fuchsia-500 via-cyan-400 to-indigo-500 shadow-[0_0_20px] shadow-fuchsia-500/50" />
          <h1 className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-fuchsia-400 to-cyan-300 bg-clip-text text-transparent">Nebula Research</h1>
        </div>
        <div className="flex items-center gap-2">
          {["fast","thorough"].map(m=>(
            <button key={m} onClick={()=>setMode(m)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition ${
                (current?.mode||mode)===m
                  ? "bg-gradient-to-r from-fuchsia-600 to-indigo-600 shadow-[0_0_18px] shadow-fuchsia-500/40"
                  : "bg-white/10 hover:bg-white/20"}`}>
              {m}
            </button>
          ))}
          <span className="ml-2 text-xs px-2 py-1 rounded-md border border-white/10">{status==="thinking"?"⏱":"⏲"} {elapsed.toFixed(1)}s</span>
          <button
            onClick={()=>setAutoCorrectOn(s=>!s)}
            className={`ml-2 px-3 py-1.5 rounded-full text-xs border ${autoCorrectOn ? "border-emerald-400/40 text-emerald-300" : "border-white/20 text-slate-300"} hover:border-emerald-300`}
            title="Toggle autocorrect"
          >
            {autoCorrectOn ? "Autocorrect: ON" : "Autocorrect: OFF"}
          </button>
          {(current?.mode||mode)==="thorough" && (
            <button onClick={()=>setShowResearch(s=>!s)}
              className="ml-2 text-xs px-3 py-1.5 rounded-full border border-white/20 hover:border-fuchsia-400/40">
              {showResearch ? "Hide Research" : "Show Research"}
            </button>
          )}
        </div>
      </header>

      {/* 3-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_360px] gap-4 px-3 lg:px-6 py-4">
        {/* LEFT: history */}
        <aside className="lg:sticky lg:top-[64px] h-[calc(100vh-84px)] overflow-auto rounded-2xl border border-white/10 bg-slate-900/50 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-wider text-slate-400">History</div>
            <button onClick={()=>{setCurrentId(null); setStatus('idle'); setElapsed(0); setQuestion('');}}
                    className="text-xs px-2 py-1 rounded-md border border-white/10 hover:border-fuchsia-400/40 flex items-center gap-1">
              <Icon.Plus/> New
            </button>
          </div>
          <div className="space-y-2">
            {sessions.map(s=>(
              <div key={s.id}
                   className={`group rounded-xl p-3 border ${currentId===s.id?"border-fuchsia-400/40 bg-fuchsia-500/10":"border-white/10 bg-white/5 hover:bg-white/10"}`}
                   onClick={()=>setCurrentId(s.id)}>
                {renaming===s.id ? (
                  <input autoFocus defaultValue={s.title}
                         onBlur={(e)=>{renameSession(s.id,e.target.value); setRenaming(null);}}
                         onKeyDown={(e)=>{ if(e.key==="Enter"){ renameSession(s.id,e.target.value); setRenaming(null);} }}
                         className="w-full bg-transparent outline-none text-sm"/>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm line-clamp-2">{s.title}</div>
                    <button onClick={(e)=>{e.stopPropagation(); setRenaming(s.id);}} className="opacity-60 hover:opacity-100"><Icon.Pencil/></button>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                  <span className="px-2 py-0.5 rounded-full border border-white/10">{s.mode}</span>
                  <button onClick={(e)=>{e.stopPropagation(); deleteSession(s.id);}}
                          className="opacity-60 hover:opacity-100 text-rose-300 flex items-center gap-1">
                    <Icon.Trash/> delete
                  </button>
                </div>
              </div>
            ))}
            {sessions.length===0 && (<div className="text-xs text-slate-400">No chats yet — ask something to create a session.</div>)}
          </div>
        </aside>

        {/* CENTER: chat */}
        <section className="min-h-[60vh] flex flex-col rounded-2xl border border-white/10 bg-slate-900/40">
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
            {chatList}
            {status==="thinking" && (<ClaudeLoader statusLine={statusLine} plan={plan} progress={progress} />)}
          </div>

          {/* composer */}
          <div className="p-3 border-t border-white/10 bg-slate-900/60">
            <div className="max-w-4xl mx-auto flex flex-col gap-2">
              {/* Visible autocorrect pill if a correction was applied on send */}
              {ac && (
                <AutoCorrectPill
                  original={ac.original}
                  corrected={ac.corrected}
                  onUseOriginal={() => { setQuestion(ac.original); setAc(null); }}
                  onKeep={() => setAc(null)}
                />
              )}

              <div className="flex items-center gap-2">
                <textarea
                  value={question}
                  onChange={(e)=>{ const v=e.target.value; setQuestion(v); if(trim(v).length>=3) requestAutocorrect(trim(v)); else setSuggestion(""); }}
                  onKeyDown={(e)=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); } }}
                  placeholder="Ask anything…"
                  rows={1}
                  spellCheck={true}
                  autoCorrect="on"
                  autoCapitalize="sentences"
                  className="flex-1 resize-none rounded-xl p-3 bg-slate-800/70 border border-white/10 focus:ring-2 focus:ring-fuchsia-500 outline-none" />
                {status==="thinking" && (
                  <button onClick={stopRun}
                    className="px-4 py-2 rounded-xl border border-white/10 hover:border-rose-400/40 text-rose-300">
                    Stop
                  </button>
                )}
                <button onClick={send}
                  className="px-5 py-2 rounded-xl font-semibold bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 shadow-[0_0_18px] shadow-fuchsia-600/40 flex items-center gap-2">
                  <Icon.Send/> Send
                </button>
              </div>

              {/* “Did you mean” suggestion (from server) */}
              {(suggestion || suggestLoading) && (
                <div className="text-xs text-slate-300">
                  {suggestLoading ? (
                    <span className="opacity-80">Checking…</span>
                  ) : (
                    <>
                      <span className="mr-2 opacity-80">Did you mean:</span>
                      <button onClick={()=>setQuestion(suggestion)}
                              className="px-2 py-1 rounded-full border border-cyan-400/40 text-cyan-300 hover:border-cyan-300">
                        {suggestion}
                      </button>
                      <button onClick={()=>setSuggestion("")}
                              className="ml-2 px-2 py-1 rounded-full border border-white/10 hover:border-white/20">
                        Dismiss
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT: research feed */}
        <aside className={`lg:sticky lg:top-[64px] h-[calc(100vh-84px)] overflow-auto rounded-2xl border border-white/10 bg-slate-900/50 p-3 ${((current?.mode||mode)==="thorough" && showResearch)?"":"hidden lg:block lg:opacity-50 lg:pointer-events-none"}`}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-wider text-fuchsia-300">Research</div>
            <button onClick={()=>setShowResearch(s=>!s)} className="text-xs px-2 py-1 rounded-md border border-white/10 hover:border-fuchsia-400/40">
              {showResearch ? "Hide" : "Show"}
            </button>
          </div>
          <div className="space-y-3">
            {(!(current?.trace||[]).length && status!=="thinking") && (<div className="text-xs text-slate-400">No research yet.</div>)}
            {(current?.trace||[]).map((ev,i)=>(
              <div key={i} className="p-3 rounded-xl bg-slate-800/60 border border-white/10 text-sm">
                {ev.type==="plan" && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">Plan</div>
                    <ul className="list-disc ml-4">{(ev.data?.steps||[]).map((s,j)=><li key={j}>{s}</li>)}</ul>
                  </div>
                )}
                {ev.type==="queries" && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">Queries</div>
                    <ul className="list-disc ml-4">{(ev.data?.items||[]).map((q,j)=><li key={j}>{q}</li>)}</ul>
                  </div>
                )}
                {ev.type==="status" && <div>🔄 {ev.data?.state}</div>}
                {ev.type==="search" && (
                  <div>
                    <div className="font-semibold mb-1">🔍 {ev.data?.query}</div>
                    <ul className="list-disc ml-4">
                      {(ev.data?.results||[]).map((r,j)=>(
                        <li key={j}><a href={r.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{r.title}</a></li>
                      ))}
                    </ul>
                  </div>
                )}
                {ev.type==="extract" && (
                  <div>
                    <div className="text-xs text-slate-400 mb-1">Evidence</div>
                    <a href={ev.data?.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{ev.data?.url}</a>
                    <ul className="list-disc ml-4 mt-1">
                      {(ev.data?.snippets||[]).map((s,j)=><li key={j}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {ev.type==="read" && (
                  <div>
                    <a href={ev.data?.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">📖 {ev.data?.url}</a>
                    <div className="text-slate-400 text-xs mt-1 line-clamp-3">{ev.data?.excerpt}</div>
                  </div>
                )}
                {ev.type==="rationale" && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">Reasoning (summary)</div>
                    {Array.isArray(ev.data?.subgoals) && ev.data.subgoals.length > 0 && (
                      <div className="mb-2">
                        <div className="text-xs text-slate-400 mb-1">Subgoals</div>
                        <ul className="list-disc ml-4">{ev.data.subgoals.map((s,j)=><li key={j}>{s}</li>)}</ul>
                      </div>
                    )}
                    {Array.isArray(ev.data?.factors) && ev.data.factors.length > 0 && (
                      <div className="mb-2">
                        <div className="text-xs text-slate-400 mb-1">Key factors</div>
                        <ul className="list-disc ml-4">{ev.data.factors.map((s,j)=><li key={j}>{s}</li>)}</ul>
                      </div>
                    )}
                    {Array.isArray(ev.data?.risks) && ev.data.risks.length > 0 && (
                      <div className="mb-2">
                        <div className="text-xs text-slate-400 mb-1">Risks</div>
                        <ul className="list-disc ml-4">{ev.data.risks.map((s,j)=><li key={j}>{s}</li>)}</ul>
                      </div>
                    )}
                    {ev.data?.prelim_answer && (
                      <div className="text-sm">
                        <div className="text-xs text-slate-400 mb-1">Preliminary answer</div>
                        <div className="p-2 rounded-md bg-white/5 border border-white/10">{ev.data.prelim_answer}</div>
                      </div>
                    )}
                  </div>
                )}
                {ev.type==="error" && <div className="text-rose-400">⚠ {ev.data?.message}</div>}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
