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
        width: 262px; padding: 9px 11px; border-radius: 8px;
        background: #11161c; color: #e8edf2;
        font: 500 11px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
      }
      .prog-head { display: flex; justify-content: space-between; gap: 8px; }
      .prog-pct { color: #7cc5e0; font-variant-numeric: tabular-nums; }
      .prog-detail {
        margin-top: 3px; color: #9aa6b3; font-weight: 400;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .prog-track {
        height: 4px; margin-top: 7px; border-radius: 2px;
        background: #27333d; overflow: hidden;
      }
      .prog-fill {
        height: 100%; width: 0%; background: #11698e;
        transition: width .35s ease;
      }
      .prog.done .prog-fill { background: #3f9e68; }
      .prog.err .prog-fill { background: #d3524b; }

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
      <div class="prog-head"><span id="progLabel">Working</span><span id="progPct">0%</span></div>
      <div class="prog-detail" id="progDetail"></div>
      <div class="prog-track"><div class="prog-fill" id="progFill"></div></div>
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
    let summary = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "job-progress" });
      summary = res && res.summary;
    } catch {
      return; // worker restarting; try again next tick
    }

    if (!summary) {
      prog.classList.add("hidden");
      return;
    }

    prog.classList.remove("hidden");
    prog.classList.toggle("done", summary.status === "done" && !summary.failed);
    prog.classList.toggle("err", summary.failed > 0);
    shadow.getElementById("progLabel").textContent =
      `${summary.label} ${summary.done}/${summary.total}` +
      (summary.failed ? ` · ${summary.failed} failed` : "");
    shadow.getElementById("progPct").textContent = `${summary.percent}%`;

    const bits = [];
    if (summary.detail) bits.push(summary.detail);
    if (summary.status === "running" && summary.etaSeconds != null) {
      bits.push(`~${fmtEta(summary.etaSeconds)} left`);
    } else if (summary.status !== "running") {
      bits.push(summary.status);
    }
    // a frozen segment counter is otherwise indistinguishable from "slow"
    if (summary.stalledFor != null && summary.stalledFor > 45) {
      bits.push(`no progress for ${fmtEta(summary.stalledFor)}`);
    }
    shadow.getElementById("progDetail").textContent = bits.join(" · ");
    shadow.getElementById("progFill").style.width = `${summary.percent}%`;

    // stop polling a while after work finishes, but leave the result visible
    if (summary.status === "running") {
      idleRounds = 0;
    } else if (++idleRounds > 8) {
      stopPolling();
    }
  }

  function startPolling() {
    idleRounds = 0;
    poll();
    if (!pollTimer) pollTimer = setInterval(poll, 1500);
  }

  function stopPolling() {
    clearInterval(pollTimer);
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
      say(describe(res.job, infoOnly), "ok", infoOnly ? 0 : 6000);
      if (!infoOnly) startPolling();
    } catch (err) {
      say(err.message || String(err), "err");
    } finally {
      bar.classList.remove("busy");
    }
  }

  toast.addEventListener("click", () => toast.classList.add("hidden"));
  shadow.getElementById("dl").addEventListener("click", () => queue(false));
  shadow.getElementById("info").addEventListener("click", () => queue(true));
  shadow.getElementById("close").addEventListener("click", () => {
    stopPolling();
    host.remove();
  });

  // a job may already be running from a previous page load
  startPolling();
})();
