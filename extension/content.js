// Injected on Udemy course pages. Talks to the service worker only -- it never
// touches the API directly, so the token stays out of the page context.

(() => {
  if (document.getElementById("udbridge-root")) return;

  const host = document.createElement("div");
  host.id = "udbridge-root";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
        display: flex; align-items: stretch; gap: 1px;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        border-radius: 8px; overflow: hidden;
        box-shadow: 0 4px 16px rgba(0,0,0,.28);
        transition: opacity .15s ease;
      }
      .bar.busy { opacity: .6; pointer-events: none; }
      button {
        border: 0; cursor: pointer; font: inherit; padding: 10px 14px;
        background: #11698e; color: #fff; display: flex; align-items: center; gap: 7px;
      }
      button:hover { background: #0d5673; }
      button.alt { background: #27333d; padding: 10px 11px; font-size: 12px; }
      button.alt:hover { background: #333f4a; }
      button.close { background: #27333d; padding: 10px 10px; color: #9aa6b3; }
      button.close:hover { color: #fff; }
      button:focus-visible { outline: 2px solid #7cc5e0; outline-offset: -3px; }

      .prog {
        position: fixed; right: 18px; bottom: 64px; z-index: 2147483000;
        width: 320px; padding: 10px 11px; border-radius: 8px;
        background: #11161c; color: #e8edf2;
        font: 500 11px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
      }
      .prog-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 7px; cursor: pointer; user-select: none; }
      .prog-head-right { display: flex; gap: 8px; align-items: center; }
      #progPct { color: #7cc5e0; font-variant-numeric: tabular-nums; }
      #progCaret { color: #9aa6b3; transition: transform .15s ease; }
      .prog.collapsed #progCaret { transform: rotate(-90deg); }
      .prog.collapsed .stack { display: none; }
      .prog.collapsed { margin-bottom: 0; }
      .stack { max-height: 48vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; scrollbar-width: none; -ms-overflow-style: none; }
      .stack::-webkit-scrollbar { width: 0; height: 0; display: none; }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; }
      .row .t {
        grid-column: 1; min-width: 0; color: #e8edf2; font-weight: 500;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .row .s { grid-column: 2; color: #9aa6b3; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .row .s .k {
        display: inline-block; margin-right: 5px; padding: 1px 5px; border-radius: 3px;
        background: #27333d; color: #7cc5e0; font-size: 9px; vertical-align: 1px;
      }
      .mini { grid-column: 1 / -1; height: 3px; border-radius: 2px; background: #27333d; overflow: hidden; }
      .mini-fill { height: 100%; width: 0%; background: #11698e; transition: width .35s ease; }
      .row.done .mini-fill { background: #3f9e68; }
      .row.failed .mini-fill, .row.skipped .mini-fill { background: #d3524b; }
      .row.done .s, .row.failed .s { color: #c7d0d9; }
      .stack-empty { color: #9aa6b3; font-weight: 400; }
      .ghead {
        display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
        padding: 4px 0 3px; border-top: 1px solid #1c2530; margin-top: 2px;
      }
      .ghead:first-child { border-top: 0; margin-top: 0; }
      .gname { flex: 1; min-width: 0; color: #cfe3ee; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gcount { color: #9aa6b3; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .gcaret { color: #9aa6b3; transition: transform .15s ease; }
      .ghead.collapsed .gcaret { transform: rotate(-90deg); }
      .row.nested { padding-left: 12px; }
      .gbar { height: 3px; border-radius: 2px; background: #27333d; overflow: hidden; margin: 1px 0 3px; }
      .gbar-fill { height: 100%; width: 0%; background: #11698e; transition: width .35s ease; }

      .toast {
        position: fixed; right: 18px; bottom: 124px; z-index: 2147483000;
        max-width: 330px; padding: 11px 14px; border-radius: 8px;
        background: #11161c; color: #e8edf2;
        font: 400 12.5px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
        border-left: 3px solid #11698e;
        white-space: pre-line;
        cursor: pointer;
        max-height: 60vh;
        overflow-y: auto;
      }
      .toast.err { border-left-color: #d3524b; }
      .toast.ok { border-left-color: #3f9e68; }
      .hidden { display: none; }
      @media (prefers-reduced-motion: reduce) {
        .bar, .prog-fill { transition: none; }
      }
    </style>
    <div class="bar" part="bar">
      <button id="dl" title="Queue this course in udemy-downloader">
        <span aria-hidden="true">⤓</span><span>Download course</span>
      </button>
      <button id="info" class="alt" title="List the curriculum without downloading">Info</button>
      <button id="close" class="close" title="Hide until reload" aria-label="Hide">×</button>
    </div>
    <div id="prog" class="prog hidden" role="status" aria-live="polite">
      <div class="prog-head" id="progHead" title="Click to collapse">
        <span id="progLabel">Downloads</span>
        <span class="prog-head-right"><span id="progPct"></span><span id="progCaret">▾</span></span>
      </div>
      <div class="stack" id="stack"></div>
    </div>
    <div id="toast" class="toast hidden" role="status"></div>
  `;

  document.documentElement.append(host);

  const bar = shadow.querySelector(".bar");
  const toast = shadow.getElementById("toast");
  const prog = shadow.getElementById("prog");
  let hideTimer = null;
  let pollTimer = null;
  let idleRounds = 0;
  const collapsed = new Set(); // course names currently collapsed in the stack
  const seenCourses = new Set(); // courses start collapsed (one line per course)
  let lastSig = null; // last rendered signature — skip identical redraws (no blink)

  // ms = 0 keeps it up until clicked: info results carry data worth reading,
  // and a 6s auto-hide threw it away before it could be read.
  function say(message, kind, ms = 6000) {
    toast.textContent = message;
    toast.className = `toast ${kind || ""}`;
    clearTimeout(hideTimer);
    if (ms > 0) hideTimer = setTimeout(() => toast.classList.add("hidden"), ms);
  }

  function describe(job, infoOnly) {
    if (!job) return "No result returned.";
    if (job.mode === "container") {
      return `Job ${job.id} queued on the container. Open the popup for the live log.`;
    }
    if (infoOnly) {
      const s = job.plan || {};
      const h = job.hls;
      let hls = "HLS: not probed (no sample lecture found).";
      if (h && h.error) {
        hls = `HLS probe failed: ${h.error}`;
      } else if (h) {
        hls =
          `HLS: ${h.bestHeight}p, ${h.segmentKind}, ` +
          `${h.separateAudio ? "separate" : "muxed"} audio, ${h.segmentCount} segments\n` +
          (h.concatenable
            ? "=> concatenable as-is"
            : "=> needs transmuxing (handled by 1080p mode)");
      }
      return (
        `${job.courseTitle}\n` +
        `${s.chapters} chapters · ${s.downloadable} downloadable · ` +
        `${s.drm} DRM-only · progressive max ${s.maxHeight}p\n${hls}\n\n(click to dismiss)`
      );
    }
    if (job.mode === "local-hd") {
      return `Queued ${job.entries.length} lectures at 1080p. Progress is shown below.`;
    }
    return (
      `Queued ${job.entries ? job.entries.length : 0} files to your downloads folder.\n` +
      `Per-file progress: brave://downloads`
    );
  }

  function fmtEta(seconds) {
    if (seconds < 90) return `${seconds}s`;
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }

  async function poll() {
    let items = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "job-stack" });
      items = res && res.items;
    } catch {
      return; // worker restarting; try again next tick
    }

    if (!items || !items.length) {
      prog.classList.add("hidden");
      return;
    }

    prog.classList.remove("hidden");
    const done = items.filter((i) => i.status === "done").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const running = items.filter((i) => i.status === "running").length;

    // Track activity for the poll rate. Don't stop — keep a slow heartbeat so
    // clears/removals elsewhere (popup "Clear finished") are reflected here.
    if (running || items.some((i) => i.status === "queued")) idleRounds = 0;
    else idleRounds += 1;

    // Only touch the DOM when something actually changed, else the per-poll
    // rebuild makes the whole list blink.
    const sig = JSON.stringify(items.map((i) => [i.course, i.title, i.status, i.percent]))
      + "|" + [...collapsed].sort().join(",");
    if (sig === lastSig) return;
    lastSig = sig;

    shadow.getElementById("progLabel").textContent =
      `Downloads ${done}/${items.length}` + (failed ? ` · ${failed} failed` : "");
    shadow.getElementById("progPct").textContent = running ? `${running} active` : "";

    // group by course, preserving first-seen order
    const groups = new Map();
    for (const it of items) {
      const key = it.course || "Downloads";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }

    const stack = shadow.getElementById("stack");
    stack.textContent = "";
    for (const [course, rows] of groups) {
      if (!seenCourses.has(course)) { seenCourses.add(course); collapsed.add(course); } // default collapsed
      const gDone = rows.filter((i) => i.status === "done").length;
      const gFail = rows.filter((i) => i.status === "failed").length;
      const gPct = Math.round(rows.reduce((a, i) => a + (i.status === "done" ? 100 : (i.percent || 0)), 0) / rows.length);
      // one collapsible line per course — DRM + 1080p + files nest under it
      const head = document.createElement("div");
      head.className = "ghead" + (collapsed.has(course) ? " collapsed" : "");
      const nm = document.createElement("span");
      nm.className = "gname"; nm.textContent = course; nm.title = course;
      const ct = document.createElement("span");
      ct.className = "gcount"; ct.textContent = `${gDone}/${rows.length}` + (gFail ? ` · ${gFail}✕` : "");
      const car = document.createElement("span");
      car.className = "gcaret"; car.textContent = "▾";
      head.append(car, nm, ct);
      head.addEventListener("click", () => {
        if (collapsed.has(course)) collapsed.delete(course); else collapsed.add(course);
        poll();
      });
      stack.appendChild(head);
      // aggregate progress bar so the collapsed course line still shows movement
      const gbar = document.createElement("div"); gbar.className = "gbar";
      const gfill = document.createElement("div"); gfill.className = "gbar-fill"; gfill.style.width = `${gPct}%`;
      gbar.appendChild(gfill); stack.appendChild(gbar);
      if (collapsed.has(course)) continue;
      for (const it of rows) {
        const row = document.createElement("div");
        row.className = `row ${it.status} nested`;
        const pct = Math.max(0, Math.min(100, it.percent || 0));
        const t = document.createElement("div");
        t.className = "t"; t.textContent = it.title; t.title = it.error ? `${it.title}\n${it.error}` : it.title;
        const s = document.createElement("div");
        s.className = "s";
        const k = document.createElement("span");
        k.className = "k"; k.textContent = it.kind;
        s.append(k, document.createTextNode(it.status === "running" ? `${pct}%` : it.status));
        const mini = document.createElement("div");
        mini.className = "mini";
        const fill = document.createElement("div");
        fill.className = "mini-fill";
        fill.style.width = `${it.status === "done" ? 100 : pct}%`;
        mini.appendChild(fill);
        row.append(t, s, mini);
        stack.appendChild(row);
      }
    }
  }

  // Self-scheduling loop: 1.5s while anything is active, 5s when idle. It never
  // stops (cheap — redraws are skipped unless the data changed), so a clear in
  // the popup is reflected here within a few seconds instead of lingering.
  function loop() {
    poll().finally(() => {
      const rate = idleRounds > 8 ? 5000 : 1500;
      pollTimer = setTimeout(loop, rate);
    });
  }
  function startPolling() {
    idleRounds = 0;
    if (!pollTimer) loop();
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function queue(infoOnly) {
    bar.classList.add("busy");
    say(infoOnly ? "Fetching curriculum…" : "Queueing download…");
    try {
      const res = await chrome.runtime.sendMessage({
        type: "queue-course",
        url: location.href,
        infoOnly,
      });
      if (!res) throw new Error("No response from the extension.");
      if (res.error) throw new Error(res.error);
      let msg = describe(res.job, infoOnly);
      if (!infoOnly && res.drm) {
        if (res.drm.error) msg += `\nDRM: ${res.drm.error}`;
        else if (res.drm.queued != null) {
          msg += `\nDRM: ${res.drm.queued} queued` + (res.drm.skipped ? `, ${res.drm.skipped} already downloaded` : "") + ".";
        }
      }
      say(msg, "ok", infoOnly ? 0 : 6000);
      if (!infoOnly) startPolling();
    } catch (err) {
      say(err.message || String(err), "err");
    } finally {
      bar.classList.remove("busy");
    }
  }

  toast.addEventListener("click", () => toast.classList.add("hidden"));
  shadow.getElementById("progHead").addEventListener("click", () => {
    const collapsed = prog.classList.toggle("collapsed");
    shadow.getElementById("progHead").title = collapsed ? "Click to expand" : "Click to collapse";
  });
  shadow.getElementById("dl").addEventListener("click", () => queue(false));
  shadow.getElementById("info").addEventListener("click", () => queue(true));
  shadow.getElementById("close").addEventListener("click", () => {
    stopPolling();
    host.remove();
  });

  // a job may already be running from a previous page load
  startPolling();
})();
