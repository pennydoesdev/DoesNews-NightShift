// ─── Night Shift dashboard HTML ──────────────────────────────────────────────
// Served at GET / — lets you trigger generation and watch live status.

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Night Shift — Does News</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#080c14;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px}
    h1{font-size:1.8rem;font-weight:700;color:#fff;letter-spacing:-0.02em}
    .sub{color:#475569;font-size:0.85rem;margin-top:5px}
    .card{background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:28px 32px;width:100%;max-width:660px;margin-top:28px}
    .card-title{font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#475569;margin-bottom:18px}
    .stage{font-size:0.9rem;color:#94a3b8;margin-bottom:10px;min-height:20px}
    .track{background:#1e293b;border-radius:999px;height:6px;overflow:hidden}
    .fill{background:linear-gradient(90deg,#3b82f6,#06b6d4);height:100%;border-radius:999px;transition:width 0.6s ease;width:0%}
    .badge{display:inline-flex;align-items:center;gap:7px;padding:5px 13px;border-radius:999px;font-size:0.78rem;font-weight:500;margin-top:14px;border:1px solid transparent}
    .idle{background:#111827;color:#475569;border-color:#1e293b}
    .running{background:#0c1f3d;color:#60a5fa;border-color:#1e3a5f}
    .done{background:#052e16;color:#4ade80;border-color:#14532d}
    .failed{background:#2d0a0a;color:#f87171;border-color:#450a0a}
    .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
    .pulse{animation:p 1.4s infinite}
    @keyframes p{0%,100%{opacity:1}50%{opacity:0.2}}
    .btn{padding:10px 22px;border:none;border-radius:8px;font-size:0.88rem;font-weight:500;cursor:pointer;transition:background 0.15s}
    .btn-primary{background:#2563eb;color:#fff}
    .btn-primary:hover{background:#1d4ed8}
    .btn-primary:disabled{background:#1e3a5f;color:#3b82f6;cursor:not-allowed}
    .btn-green{background:#16a34a;color:#fff}
    .btn-green:hover{background:#15803d}
    .btn-slate{background:#1e293b;color:#94a3b8}
    .btn-slate:hover{background:#273548}
    .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
    .meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
    .chip{background:#1e293b;border-radius:8px;padding:8px 14px;font-size:0.78rem;color:#64748b}
    .chip span{color:#e2e8f0;font-weight:500}
    .scriptbox{background:#060b14;border:1px solid #1e293b;border-radius:8px;padding:18px;margin-top:18px;max-height:380px;overflow-y:auto;font-family:Georgia,serif;font-size:0.87rem;line-height:1.75;color:#cbd5e1;white-space:pre-wrap}
    .err{color:#f87171;font-size:0.82rem;margin-top:10px;min-height:16px}
    #script-card{display:none}
  </style>
</head>
<body>
  <h1>🌙 Night Shift</h1>
  <div class="sub">Does News &mdash; Script Generator</div>

  <div class="card">
    <div class="card-title">Generation Status</div>
    <div class="stage" id="stage">Ready to generate</div>
    <div class="track"><div class="fill" id="bar"></div></div>
    <div><span class="badge idle" id="badge"><span class="dot" id="dot"></span><span id="badge-text">Idle</span></span></div>
    <div class="err" id="err"></div>
    <div class="row">
      <button class="btn btn-primary" id="gen-btn" onclick="generate()">Generate Tonight&apos;s Script</button>
    </div>
  </div>

  <div class="card" id="script-card">
    <div class="card-title">Script Ready</div>
    <div class="meta" id="meta"></div>
    <div class="row">
      <button class="btn btn-green" onclick="dl()">Download .txt</button>
      <button class="btn btn-slate" onclick="cp()">Copy to Clipboard</button>
    </div>
    <div class="scriptbox" id="scriptbox"></div>
  </div>

  <script>
    const KEY = new URLSearchParams(location.search).get('key') || '';
    let poll = null, scriptText = '', scriptDate = '';

    const stages = {
      started:    ['Starting...', 5],
      weather:    ['Fetching weather forecasts (Tomorrow.io)...', 18],
      news:       ['Fetching today\\'s headlines (NewsAPI.org)...', 33],
      generating: ['AI writing script — gpt-5.5 + live web search (2-4 min)...', 50],
      extending1: ['Script short — auto-extending, pass 1...', 72],
      extending2: ['Auto-extending, pass 2...', 85],
      saving:     ['Saving to R2...', 95],
      done:       ['Script complete!', 100],
      error:      ['Generation failed', 0],
    };

    function setState(state, stage, err) {
      const [label, pct] = stages[stage] || [stage, 0];
      document.getElementById('stage').textContent = label;
      document.getElementById('bar').style.width = pct + '%';
      const b = document.getElementById('badge');
      b.className = 'badge ' + ({idle:'idle',running:'running',done:'done',error:'failed'}[state]||'idle');
      document.getElementById('dot').className = 'dot' + (state==='running'?' pulse':'');
      document.getElementById('badge-text').textContent = {idle:'Idle',running:'Running',done:'Complete',error:'Failed'}[state]||state;
      document.getElementById('err').textContent = err||'';
      document.getElementById('gen-btn').disabled = state === 'running';
    }

    async function generate() {
      document.getElementById('script-card').style.display = 'none';
      setState('running','started','');
      const r = await fetch('/generate?key='+KEY);
      if (r.status===401){setState('error','error','Wrong password.');return;}
      if (!r.ok){setState('error','error','Failed to start.');return;}
      startPoll();
    }

    function startPoll() {
      if (poll) clearInterval(poll);
      poll = setInterval(tick, 3500);
      tick();
    }

    async function tick() {
      try {
        const r = await fetch('/status?key='+KEY);
        if (!r.ok) return;
        const d = await r.json();
        setState(d.state, d.stage||d.state, d.error||'');
        if (d.state==='done') { clearInterval(poll); scriptDate=d.date; showScript(d); }
        else if (d.state==='error') clearInterval(poll);
      } catch(e){}
    }

    async function showScript(meta) {
      const r = await fetch('/script?key='+KEY+'&date='+meta.date);
      if (!r.ok) return;
      scriptText = await r.text();
      document.getElementById('script-card').style.display = 'block';
      document.getElementById('scriptbox').textContent = scriptText;
      document.getElementById('meta').innerHTML =
        '<div class="chip">Date <span>'+meta.date+'</span></div>'+
        '<div class="chip">Words <span>'+(meta.word_count||'—')+'</span></div>'+
        '<div class="chip">Runtime <span>~'+(meta.estimated_minutes||'—')+' min</span></div>';
    }

    function dl() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([scriptText],{type:'text/plain'}));
      a.download = 'Night Shift - '+(scriptDate||'script')+'.txt';
      a.click();
    }

    function cp() { navigator.clipboard.writeText(scriptText).then(()=>alert('Copied!')); }

    // On load: restore existing status
    (async()=>{
      try {
        const r = await fetch('/status?key='+KEY);
        if (!r.ok) return;
        const d = await r.json();
        if (d.state==='done') { setState('done','done',''); scriptDate=d.date; showScript(d); }
        else if (d.state==='running') { setState('running',d.stage||'generating',''); startPoll(); }
      } catch(e){}
    })();
  </script>
</body>
</html>`;
