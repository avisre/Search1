# backend/server.py
import os, re, json, time, html, asyncio
from typing import Any, Dict, List, AsyncGenerator, Tuple

import httpx
import trafilatura
from ddgs import DDGS
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from ollama import chat as ollama_chat

# =========================================================
# CONFIG
# =========================================================
# Models
FAST_MODEL = "qwen2.5:1.5b"      # Fast mode (keep whatever you already use)
THOROUGH_MODEL = "llama3.1:8b"   # Ultra-Thorough (router+planner+synth)

# CORS (front-end dev)
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
     # ⬅️ add this
    # or your custom domain if you have one:
    # "https://app.yourdomain.com",
]
# Ultra-Thorough budgets (5 minutes)
TARGET_BUDGET = 300.0   # soft
HARD_BUDGET   = 330.0   # hard cutoff

# Ultra-Thorough knobs
PLANNER_QUERIES_STAGE1 = 6
PLANNER_QUERIES_STAGE2 = 5
PER_QUERY_RESULTS = 10
FETCH_CONCURRENCY = 10
MAX_PER_HOST = 2
MAX_DOCS_STAGE1 = 12
MAX_DOCS_TOTAL  = 24
EXTRACT_CHARS_HTML = 3000
PDF_PAGE_MAX = 12
BYTES_CAP = 2_000_000
SYNTH_TEMP = 0.25
RETRIEVE_GATE_TAU = 0.45   # avg(freshness, uncertainty)

# Caching & “learning” (tiny domain prior)
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".nebula_cache")
os.makedirs(CACHE_DIR, exist_ok=True)
DOMAIN_PRIOR_FILE = os.path.join(CACHE_DIR, "domain_prior.json")
SEARCH_CACHE_FILE = os.path.join(CACHE_DIR, "search_cache.json")

# =========================================================
# APP
# =========================================================
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================================================
# PERSISTENT STATE
# =========================================================
try:
    with open(DOMAIN_PRIOR_FILE, "r") as f:
        DOMAIN_PRIOR: Dict[str, float] = json.load(f)
except Exception:
    DOMAIN_PRIOR = {}

try:
    with open(SEARCH_CACHE_FILE, "r") as f:
        SEARCH_CACHE: Dict[str, List[Dict[str, str]]] = json.load(f)
except Exception:
    SEARCH_CACHE = {}

DOC_CACHE: Dict[str, str] = {}  # in-memory per-process

def _save_domain_prior():
    try:
        with open(DOMAIN_PRIOR_FILE, "w") as f:
            json.dump(DOMAIN_PRIOR, f)
    except Exception:
        pass

def _save_search_cache():
    try:
        with open(SEARCH_CACHE_FILE, "w") as f:
            json.dump(SEARCH_CACHE, f)
    except Exception:
        pass

# =========================================================
# UTILITIES
# =========================================================
def now() -> float:
    return time.monotonic()

def host_of(url: str) -> str:
    m = re.search(r"https?://([^/]+)", url, re.I)
    if not m: return ""
    h = m.group(1).lower()
    return h[4:] if h.startswith("www.") else h

def score_domain(host: str) -> float:
    # 0..1 prior with a mild floor so unseen hosts aren't zeroed
    return min(1.0, max(0.15, DOMAIN_PRIOR.get(host, 0.25)))

def bump_domain(host: str, delta: float):
    if not host: return
    DOMAIN_PRIOR[host] = max(0.0, min(1.0, DOMAIN_PRIOR.get(host, 0.25) + delta))

def llm(model: str, messages: List[Dict[str, str]], temperature: float = 0.25) -> str:
    out = ollama_chat(model=model, messages=messages, options={"temperature": temperature})
    return out["message"]["content"]

def llm_json(model: str, messages: List[Dict[str, str]], temperature: float = 0.1) -> Dict[str, Any]:
    raw = llm(model, messages, temperature=temperature).strip()
    s, e = raw.find("{"), raw.rfind("}")
    if s != -1 and e != -1 and e > s:
        raw = raw[s:e+1]
    try:
        return json.loads(raw)
    except Exception:
        return {}

def ddg_search(query: str, k: int) -> List[Dict[str, str]]:
    if query in SEARCH_CACHE:
        return SEARCH_CACHE[query]
    out: List[Dict[str, str]] = []
    with DDGS(timeout=25) as ddgs:
        for r in ddgs.text(query, region="wt-wt", max_results=k):
            u = r.get("href") or r.get("url") or ""
            t = r.get("title") or ""
            if u and t:
                out.append({"title": t, "url": u})
    SEARCH_CACHE[query] = out
    _save_search_cache()
    return out

async def fetch_many(urls: List[str], client: httpx.AsyncClient) -> Dict[str, Tuple[str, str]]:
    """
    Return {url: (mime, text)} where text is extracted main content (HTML) or PDF text if possible.
    """
    sem = asyncio.Semaphore(FETCH_CONCURRENCY)
    results: Dict[str, Tuple[str, str]] = {}

    async def _one(u: str):
        if u in DOC_CACHE:
            results[u] = ("text/plain", DOC_CACHE[u])
            return
        if not re.match(r"^https?://", u, re.I):
            return
        async with sem:
            try:
                r = await client.get(u, timeout=20.0, follow_redirects=True)
                if r.status_code != 200:
                    return
                ctype = (r.headers.get("content-type") or "").lower()
                content = r.content[:BYTES_CAP]
                text = ""
                if "pdf" in ctype or u.lower().endswith(".pdf"):
                    # Optional: pdfminer.six (if installed)
                    try:
                        from pdfminer.high_level import extract_text_to_fp
                        import io
                        bio = io.BytesIO(content)
                        out = io.StringIO()
                        extract_text_to_fp(bio, out, maxpages=PDF_PAGE_MAX)
                        text = out.getvalue()
                    except Exception:
                        text = ""
                else:
                    try:
                        text = trafilatura.extract(content.decode(errors="ignore")) or ""
                    except Exception:
                        text = ""
                text = (text or "")[:EXTRACT_CHARS_HTML]
                if text:
                    DOC_CACHE[u] = text
                    results[u] = (ctype or "text/plain", text)
            except Exception:
                return

    await asyncio.gather(*[_one(u) for u in urls])
    return results

# Ranking & compression
EVIDENCE_PATTERNS = [
    r"\bEPS\b", r"\bYoY\b", r"\bfree cash flow\b", r"\bguidance\b",
    r"\bmoat\b", r"\bmarket share\b", r"\bforecast\b", r"\bresult(s)?\b",
    r"\bregulat(?:ion|ory)\b", r"\bquarter\b", r"\bFY20(24|25)\b",
]

def composite_score(question: str, text: str, url: str) -> float:
    q_terms = set(re.findall(r"[a-z0-9]{3,}", question.lower()))
    t_terms = set(re.findall(r"[a-z0-9]{3,}", text.lower()))
    if not t_terms: return 0.0
    overlap = len(q_terms & t_terms) / (len(q_terms) or 1)
    relevance = min(1.0, 1.5 * overlap)
    recency = 1.0 if re.search(r"\b(2024|2025|latest|recent|q[1-4])\b", question.lower()) else 0.4
    trust = score_domain(host_of(url))
    structure = 0.6 if len(text) > 800 else 0.2
    return 0.40*relevance + 0.30*recency + 0.20*trust + 0.10*structure

def extract_snippets(text: str, max_snippets: int = 8) -> List[str]:
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    pat = re.compile("|".join(EVIDENCE_PATTERNS), re.I)
    hits = []
    for ln in lines:
        if pat.search(ln):
            hits.append(ln[:280])
        if len(hits) >= max_snippets:
            break
    if not hits:
        hits = [ln[:280] for ln in lines[:max_snippets]]
    return hits

def near_duplicate(a: str, b: str) -> bool:
    ta = set(re.findall(r"[a-z0-9]{3,}", a.lower()))
    tb = set(re.findall(r"[a-z0-9]{3,}", b.lower()))
    if not ta or not tb: return False
    j = len(ta & tb) / len(ta | tb)
    return j > 0.8

def compress_docs_to_factlets(docs: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    factlets: List[Dict[str, Any]] = []
    for i, d in enumerate(docs, start=1):
        snips = extract_snippets(d["text"], max_snippets=8)
        for s in snips[:10]:
            factlets.append({
                "doc": i,
                "url": d["url"],
                "host": host_of(d["url"]),
                "text": s
            })
    keep: List[Dict[str, Any]] = []
    for f in factlets:
        if any(near_duplicate(f["text"], g["text"]) for g in keep):
            continue
        keep.append(f)
        if len(keep) >= 600:
            break
    return keep

# Verification
def split_sentences(md: str) -> List[str]:
    parts = re.split(r'(?<=[.!?])\s+|\n+', md.strip())
    return [p.strip() for p in parts if p.strip()]

def sentence_supported(sent: str, evidence_blob: str) -> bool:
    a = set(re.findall(r"[a-z0-9]{3,}", sent.lower()))
    b = set(re.findall(r"[a-z0-9]{3,}", evidence_blob.lower()))
    if not a or not b: return False
    overlap = len(a & b) / len(a)
    return overlap >= 0.45

def validate_citations(answer: str, docs: List[Dict[str, str]]) -> List[str]:
    indices = set(int(m.group(1)) for m in re.finditer(r"\[(\d+)\]", answer))
    urls = []
    for idx in sorted(indices):
        if 1 <= idx <= len(docs):
            urls.append(docs[idx-1]["url"])
    distinct_hosts = set(host_of(u) for u in urls)
    if len(distinct_hosts) < 3 and len(docs) >= 3:
        for i, d in enumerate(docs, start=1):
            h = host_of(d["url"])
            if h not in distinct_hosts:
                urls.append(d["url"])
                distinct_hosts.add(h)
            if len(distinct_hosts) >= 3:
                break
    return urls[:12]

# =========================================================
# FAST MODE STREAM
# =========================================================
async def fast_stream(question: str) -> AsyncGenerator[Dict[str, Any], None]:
    # light plan
    yield {"type": "plan", "data": {"intent": "fast", "steps": ["Answer directly", "Self-check"]}}
    yield {"type": "status", "data": {"state": "Answering (fast)"}}
    yield {"type": "progress", "data": {"pct": 10}}

    content = llm(
        FAST_MODEL,
        [
            {"role": "system", "content": "Be helpful, brief, and accurate. If unsure, say so."},
            {"role": "user", "content": question},
        ],
        temperature=0.6,
    )
    yield {"type": "progress", "data": {"pct": 95}}
    yield {"type": "final", "data": {"answer": content, "citations": []}}
    yield {"type": "progress", "data": {"pct": 100}}

# =========================================================
# ULTRA-THOROUGH (5-MIN) STREAM
# =========================================================
ROUTER_SYS = (
    "You are planning a deep research run. Return STRICT JSON only, no commentary.\n"
    "Fields:\n"
    "- needs_retrieval: boolean\n"
    "- freshness_required: number 0..1 (how much recency matters)\n"
    "- uncertainty: number 0..1 (how unclear the answer is without searching)\n"
    "- queries: array of diversified global web queries (no more than 8 now)\n"
    "- site_biases: array of {host}\n"
    "- budgets: { seconds, per_query_results }\n"
)

def router_plan(question: str, max_queries: int, per_query_results: int) -> Dict[str, Any]:
    user = (
        "Question:\n" + question + "\n\n"
        f"Return at most {max_queries} queries, GLOBAL scope (neutral region), add years (2024/2025) if helpful, "
        "exclude junk (e.g., -minecraft, -mod). "
        f"Set budgets.per_query_results={per_query_results}.\n"
        "Output JSON now."
    )
    js = llm_json(
        THOROUGH_MODEL,
        [{"role": "system", "content": ROUTER_SYS}, {"role": "user", "content": user}],
        temperature=0.15,
    )
    if "needs_retrieval" not in js:
        js["needs_retrieval"] = True
    js["freshness_required"] = float(js.get("freshness_required", 0.6))
    js["uncertainty"] = float(js.get("uncertainty", 0.5))
    qs = js.get("queries") or []
    js["queries"] = [q for q in qs[:max_queries] if isinstance(q, str) and q.strip()]
    js.setdefault("site_biases", [])
    js.setdefault("budgets", {"seconds": TARGET_BUDGET, "per_query_results": per_query_results})
    return js

async def thorough_stream(question: str) -> AsyncGenerator[Dict[str, Any], None]:
    t0 = now()
    def elapsed() -> float: return now() - t0

    # Plan pass 1
    plan1 = router_plan(question, PLANNER_QUERIES_STAGE1, PER_QUERY_RESULTS)
    need = plan1.get("needs_retrieval", True)
    gate = (plan1["freshness_required"] + plan1["uncertainty"]) / 2.0
    route_retrieve = need or (gate > RETRIEVE_GATE_TAU)

    yield {"type": "plan", "data": {
        "intent": "ultra-thorough",
        "steps": [
            "Plan queries (pass 1)",
            "Search & dedupe (pass 1)",
            "Fetch & extract (pass 1)",
            "Plan gaps (pass 2)",
            "Fetch & extract (pass 2)",
            "Synthesize (evidence-only)",
            "Verify (claims & citations)",
        ],
    }}
    yield {"type": "status", "data": {"state": "Planning queries (pass 1)" }}
    yield {"type": "queries", "data": {"items": plan1["queries"]}}
    yield {"type": "progress", "data": {"pct": 5}}

    if not route_retrieve:
        yield {"type": "status", "data": {"state": "Direct answer (no retrieval required)" }}
        content = llm(
            THOROUGH_MODEL,
            [{"role": "system", "content": "Be accurate and concise. If unsure, say so."},
             {"role": "user", "content": question}],
            temperature=0.3,
        )
        yield {"type": "final", "data": {"answer": content, "citations": []}}
        yield {"type": "progress", "data": {"pct": 100}}
        return

    # Discover pass 1
    yield {"type": "status", "data": {"state": "Searching the web (pass 1)" }}
    results1: List[Dict[str, str]] = []
    for q in plan1["queries"]:
        if elapsed() > HARD_BUDGET: break
        res = ddg_search(q, plan1["budgets"]["per_query_results"])
        results1.extend([{"query": q, **r} for r in res])
        yield {"type": "search", "data": {"query": q, "results": res}}
    yield {"type": "progress", "data": {"pct": 15}}

    # Dedupe + per-host cap (stage 1)
    seen_urls = set()
    per_host: Dict[str, int] = {}
    deduped1: List[Dict[str, str]] = []
    for r in results1:
        u = r["url"]; h = host_of(u)
        if not re.match(r"^https?://", u, re.I): continue
        if u in seen_urls: continue
        if per_host.get(h, 0) >= MAX_PER_HOST: continue
        seen_urls.add(u); per_host[h] = per_host.get(h, 0) + 1
        deduped1.append(r)
    urls_stage1 = [r["url"] for r in deduped1[:MAX_DOCS_STAGE1]]

    # Digest pass 1
    yield {"type": "status", "data": {"state": "Fetching & extracting (pass 1)"}}
    async with httpx.AsyncClient() as client:
        fetched1 = await fetch_many(urls_stage1, client)
    docs1: List[Dict[str, str]] = []
    for u in urls_stage1:
        if u in fetched1 and fetched1[u][1]:
            txt = fetched1[u][1]
            docs1.append({"url": u, "text": txt})
            yield {"type": "read", "data": {"url": u, "excerpt": txt[:600]}}
            yield {"type": "extract", "data": {"url": u, "snippets": extract_snippets(txt)}}
            bump_domain(host_of(u), +0.05)
        else:
            bump_domain(host_of(u), -0.02)
    _save_domain_prior()
    yield {"type": "progress", "data": {"pct": 35}}

    # Plan pass 2 (gaps)
    plan2 = router_plan(
        f"{question}\n\nAlready reviewed URLs:\n" + "\n".join(d["url"] for d in docs1),
        PLANNER_QUERIES_STAGE2,
        PER_QUERY_RESULTS
    )
    yield {"type": "status", "data": {"state": "Planning targeted follow-ups (pass 2)"}}
    yield {"type": "queries", "data": {"items": plan2["queries"]}}
    yield {"type": "progress", "data": {"pct": 40}}

    # Discover pass 2
    yield {"type": "status", "data": {"state": "Searching the web (pass 2)"}}
    results2: List[Dict[str, str]] = []
    for q in plan2["queries"]:
        if elapsed() > HARD_BUDGET: break
        res = ddg_search(q, plan2["budgets"]["per_query_results"])
        results2.extend([{"query": q, **r} for r in res])
        yield {"type": "search", "data": {"query": q, "results": res}}
    yield {"type": "progress", "data": {"pct": 50}}

    # Dedupe + per-host cap across both passes
    seen_urls = set(d["url"] for d in docs1)
    per_host = {}
    for d in docs1:
        h = host_of(d["url"])
        per_host[h] = per_host.get(h, 0) + 1

    deduped2: List[Dict[str, str]] = []
    for r in results2:
        u = r["url"]; h = host_of(u)
        if not re.match(r"^https?://", u, re.I): continue
        if u in seen_urls: continue
        if per_host.get(h, 0) >= MAX_PER_HOST: continue
        seen_urls.add(u); per_host[h] = per_host.get(h, 0) + 1
        deduped2.append(r)

    remaining_slots = max(0, MAX_DOCS_TOTAL - len(docs1))
    urls_stage2 = [r["url"] for r in deduped2[:remaining_slots]]

    # Digest pass 2
    yield {"type": "status", "data": {"state": "Fetching & extracting (pass 2)"}}
    async with httpx.AsyncClient() as client:
        fetched2 = await fetch_many(urls_stage2, client)
    docs2: List[Dict[str, str]] = []
    for u in urls_stage2:
        if u in fetched2 and fetched2[u][1]:
            txt = fetched2[u][1]
            docs2.append({"url": u, "text": txt})
            yield {"type": "read", "data": {"url": u, "excerpt": txt[:600]}}
            yield {"type": "extract", "data": {"url": u, "snippets": extract_snippets(txt)}}
            bump_domain(host_of(u), +0.05)
        else:
            bump_domain(host_of(u), -0.02)
    _save_domain_prior()

    # Rank evidence
    all_docs = docs1 + docs2
    ranked = sorted(all_docs, key=lambda d: composite_score(question, d["text"], d["url"]), reverse=True)
    kept: List[Dict[str, str]] = []
    host_count: Dict[str, int] = {}
    for d in ranked:
        h = host_of(d["url"])
        if host_count.get(h, 0) >= MAX_PER_HOST:
            continue
        host_count[h] = host_count.get(h, 0) + 1
        kept.append(d)
        if len(kept) >= MAX_DOCS_TOTAL:
            break

    yield {"type": "progress", "data": {"pct": 70}}
    yield {"type": "status", "data": {"state": "Compressing evidence"}}

    # Compress → factlets
    factlets = compress_docs_to_factlets(kept)
    evidence_lines = []
    for i, d in enumerate(kept, start=1):
        evidence_lines.append(f"[{i}] {d['url']}")
        for fl in factlets:
            if fl["doc"] == i:
                evidence_lines.append(f"- {fl['text']}")
    evidence_blob = "\n".join(evidence_lines)[:120_000]

    # Synthesize (evidence-only)
    yield {"type": "status", "data": {"state": "Synthesizing (evidence-only)"}}
    yield {"type": "progress", "data": {"pct": 85}}

    synth_sys = (
        "You are a truth-seeking research summarizer.\n"
        "RULES:\n"
        "1) Use ONLY the evidence provided. If a detail is not supported, say 'not supported by the provided sources'.\n"
        "2) Include explicit dates (e.g., 'As of 2025-08-24').\n"
        "3) Cite with bracket numbers [n] that correspond to the evidence list.\n"
        "4) Prefer the 5–12 most load-bearing sources from at least 3 distinct hosts.\n"
        "5) Surface disagreements and limits. Be concise and structured."
    )
    synth_user = (
        f"Question:\n{question}\n\nEvidence list (map [n] -> URL and bullet factlets):\n{evidence_blob}\n\n"
        "Write the final answer now."
    )
    draft = llm(
        THOROUGH_MODEL,
        [{"role": "system", "content": synth_sys}, {"role": "user", "content": synth_user}],
        temperature=SYNTH_TEMP,
    )

    # Verify: unsupported-claim filter + citation validation
    yield {"type": "status", "data": {"state": "Verifying claims & citations"}}
    yield {"type": "progress", "data": {"pct": 92}}

    sentences = split_sentences(draft)
    ev_blob_min = "\n".join(d["text"] for d in kept)[:200_000]
    checked: List[str] = []
    for s in sentences:
        if re.match(r"^\s*\[[0-9]+\]\s*$", s):
            continue
        if sentence_supported(s, ev_blob_min):
            checked.append(s)
        else:
            checked.append(s + " _(not supported by the provided sources)_")
    checked_answer = " ".join(checked)

    final_citations = validate_citations(checked_answer, kept)

    # Domain prior bumps for cited hosts
    cited_hosts = set(host_of(u) for u in final_citations)
    for h in cited_hosts:
        bump_domain(h, +0.1)
    _save_domain_prior()

    yield {"type": "final", "data": {"answer": checked_answer, "citations": final_citations}}
    yield {"type": "progress", "data": {"pct": 100}}

# =========================================================
# API
# =========================================================
@app.get("/api/stream_chat")
async def api_stream_chat(request: Request, question: str, mode: str = "fast"):
    """
    Server-Sent Events stream.
    mode = "fast" | "thorough"
    """
    async def event_gen():
        try:
            if mode == "fast":
                async for ev in fast_stream(question):
                    yield f"event: {ev['type']}\ndata: {json.dumps(ev['data'])}\n\n"
            else:
                # Ultra-Thorough 5-min pipeline
                async for ev in thorough_stream(question):
                    # stop gracefully if client disconnected
                    if await request.is_disconnected():
                        break
                    yield f"event: {ev['type']}\ndata: {json.dumps(ev['data'])}\n\n"
        except asyncio.CancelledError:
            # client aborted
            return
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")
