/**
 * Single-file live dashboard for observing an agent team.
 *
 * Served verbatim as the body of GET /dashboard. Everything is inline: no
 * build step, no CDN, no external font or image request. The page reads the
 * two read-only endpoints in hub-http.ts and then follows the SSE stream at
 * /events.
 *
 * Live strategy: hub events trigger a debounced re-fetch of the workspace
 * snapshot, so every storage-backed panel (agents, problems, proposals,
 * consensus, channels) always renders authoritative state rather than state
 * reconstructed from event payloads. Thought events have no snapshot source,
 * so the thought ticker is the one panel accumulated purely in memory from
 * the stream.
 *
 * Colors follow the validated categorical palette (slots 1-3) plus the
 * reserved status palette; every status color is paired with a text label so
 * nothing is carried by hue alone.
 */
export const DASHBOARD_HTML: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Team Hub — live</title>
<style>
  :root {
    color-scheme: light;
    --plane:          #f9f9f7;
    --surface-1:      #fcfcfb;
    --text-primary:   #0b0b0b;
    --text-secondary: #52514e;
    --text-muted:     #898781;
    --hairline:       #e1e0d9;
    --border:         rgba(11, 11, 11, 0.10);
    --series-1:       #2a78d6;
    --series-2:       #eb6834;
    --series-3:       #1baf7a;
    --status-good:    #0ca30c;
    --status-warning: #fab219;
    --status-critical:#d03b3b;
    --wash:           rgba(11, 11, 11, 0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --plane:          #0d0d0d;
      --surface-1:      #1a1a19;
      --text-primary:   #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted:     #898781;
      --hairline:       #2c2c2a;
      --border:         rgba(255, 255, 255, 0.10);
      --series-1:       #3987e5;
      --series-2:       #d95926;
      --series-3:       #199e70;
      --wash:           rgba(255, 255, 255, 0.05);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --plane:          #0d0d0d;
    --surface-1:      #1a1a19;
    --text-primary:   #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted:     #898781;
    --hairline:       #2c2c2a;
    --border:         rgba(255, 255, 255, 0.10);
    --series-1:       #3987e5;
    --series-2:       #d95926;
    --series-3:       #199e70;
    --wash:           rgba(255, 255, 255, 0.05);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--plane);
    color: var(--text-primary);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 20px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--hairline);
    background: var(--surface-1);
    position: sticky;
    top: 0;
    z-index: 2;
  }
  header h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .ws-id {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .spacer { flex: 1 1 auto; }

  select {
    font: inherit;
    color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
    max-width: 260px;
  }

  .conn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex: none;
  }
  .dot.good     { background: var(--status-good); }
  .dot.warning  { background: var(--status-warning); }
  .dot.critical { background: var(--status-critical); }

  main {
    padding: 20px;
    display: grid;
    gap: 16px;
    max-width: 1500px;
    margin: 0 auto;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
  }
  .tile {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .tile .label {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .tile .value {
    font-size: 30px;
    font-weight: 600;
    line-height: 1.15;
    margin-top: 2px;
  }
  .tile .sub {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .cols {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  }

  section.card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  section.card > h2 {
    margin: 0;
    padding: 12px 14px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--hairline);
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  section.card > h2 .count {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .body { padding: 12px 14px; }
  .scroll {
    overflow-y: auto;
    overflow-x: auto;
    max-height: 340px;
  }

  .empty {
    color: var(--text-muted);
    font-size: 13px;
    padding: 6px 0;
  }

  .board {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    padding: 12px 14px;
  }
  .board .col { min-width: 0; }
  .board .col h3 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex: none;
  }
  .swatch.s1 { background: var(--series-1); }
  .swatch.s2 { background: var(--series-2); }
  .swatch.s3 { background: var(--series-3); }

  .item {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 10px;
    margin-bottom: 8px;
    background: var(--plane);
  }
  .item:last-child { margin-bottom: 0; }
  .item .title {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .item .meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 3px;
    overflow-wrap: anywhere;
  }
  .item.s1 { border-left: 3px solid var(--series-1); }
  .item.s2 { border-left: 3px solid var(--series-2); }
  .item.s3 { border-left: 3px solid var(--series-3); }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 7px;
    margin-right: 6px;
    white-space: nowrap;
  }

  .agent {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .agent:last-child { border-bottom: none; }
  .agent .name { font-size: 13px; font-weight: 500; }
  .agent .who { font-size: 12px; color: var(--text-muted); }
  .agent .state {
    margin-left: auto;
    font-size: 12px;
    color: var(--text-secondary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .msg {
    padding: 6px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .msg:last-child { border-bottom: none; }
  .msg .head {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .msg .head .who { color: var(--text-secondary); font-weight: 500; }
  .msg .content {
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin-top: 2px;
  }

  .thought {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 0;
    border-bottom: 1px solid var(--hairline);
    font-size: 12px;
    color: var(--text-muted);
  }
  .thought:last-child { border-bottom: none; }
  .thought .kind {
    color: var(--text-secondary);
    border: 1px solid var(--border);
    background: var(--wash);
    border-radius: 999px;
    padding: 1px 7px;
    white-space: nowrap;
  }
  .thought .n { font-variant-numeric: tabular-nums; }
  .thought .when { margin-left: auto; white-space: nowrap; }

  .note {
    font-size: 12px;
    color: var(--text-muted);
    padding: 0 20px 20px;
    max-width: 1500px;
    margin: 0 auto;
  }
</style>
</head>
<body>
<header>
  <h1>Team Hub</h1>
  <select id="ws-select" aria-label="Workspace"></select>
  <span class="ws-id" id="ws-id"></span>
  <span class="spacer"></span>
  <span class="conn"><span class="dot" id="conn-dot"></span><span id="conn-text">connecting</span></span>
</header>

<main>
  <div class="tiles" id="tiles"></div>

  <section class="card">
    <h2>Problems <span class="count" id="problems-count"></span></h2>
    <div class="board" id="board"></div>
  </section>

  <div class="cols">
    <section class="card">
      <h2>Agents <span class="count" id="agents-count"></span></h2>
      <div class="body scroll" id="agents"></div>
    </section>
    <section class="card">
      <h2>Proposals <span class="count" id="proposals-count"></span></h2>
      <div class="body scroll" id="proposals"></div>
    </section>
  </div>

  <div class="cols">
    <section class="card">
      <h2>Channel feed <span class="count" id="messages-count"></span></h2>
      <div class="body scroll" id="feed"></div>
    </section>
    <section class="card">
      <h2>Consensus <span class="count" id="consensus-count"></span></h2>
      <div class="body scroll" id="consensus"></div>
    </section>
  </div>

  <section class="card">
    <h2>Thoughts <span class="count" id="thoughts-count"></span></h2>
    <div class="body scroll" id="thoughts"></div>
  </section>
</main>

<p class="note" id="note"></p>

<script>
(function () {
  "use strict";

  var THOUGHT_LIMIT = 100;

  var state = {
    workspaces: [],
    workspaceId: null,
    snapshot: null,
    thoughts: [],
    eventCount: 0,
    lastEventAt: null,
    loadToken: 0
  };

  var source = null;
  var refreshTimer = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function empty(node, message) {
    clear(node);
    node.appendChild(el("p", "empty", message));
  }

  function shortTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function str(value, fallback) {
    return typeof value === "string" && value.length > 0 ? value : fallback;
  }

  // ---- connection indicator -------------------------------------------------

  function setConnection(kind, text) {
    var dot = $("conn-dot");
    dot.className = "dot" + (kind ? " " + kind : "");
    $("conn-text").textContent = text;
  }

  // ---- rendering ------------------------------------------------------------

  function renderTiles() {
    var host = $("tiles");
    clear(host);
    var snap = state.snapshot;
    if (!snap) return;

    var agents = snap.agents || [];
    var problems = snap.problems || [];
    var proposals = snap.proposals || [];
    var consensus = snap.consensus || [];
    var channels = snap.channels || [];

    var online = agents.filter(function (a) { return a.status === "online"; }).length;
    var openProblems = problems.filter(function (p) { return p.status === "open"; }).length;
    var activeProblems = problems.filter(function (p) { return p.status === "in-progress"; }).length;
    var merged = proposals.filter(function (p) { return p.status === "merged"; }).length;
    var messages = channels.reduce(function (sum, c) {
      return sum + ((c.messages && c.messages.length) || 0);
    }, 0);

    var tiles = [
      ["Agents online", online, "of " + agents.length + " in workspace"],
      ["Problems open", openProblems, activeProblems + " in progress"],
      ["Proposals", proposals.length, merged + " merged"],
      ["Consensus markers", consensus.length, consensus.length === 1 ? "1 agreement" : "agreements recorded"],
      ["Channel messages", messages, channels.length + " channels"],
      ["Events this session", state.eventCount,
        state.lastEventAt ? "last at " + shortTime(state.lastEventAt) : "none yet"]
    ];

    tiles.forEach(function (t) {
      var tile = el("div", "tile");
      tile.appendChild(el("div", "label", t[0]));
      tile.appendChild(el("div", "value", t[1]));
      tile.appendChild(el("div", "sub", t[2]));
      host.appendChild(tile);
    });
  }

  function renderAgents() {
    var host = $("agents");
    var agents = (state.snapshot && state.snapshot.agents) || [];
    $("agents-count").textContent = agents.length ? String(agents.length) : "";

    if (!agents.length) {
      empty(host, "No agents have joined this workspace yet.");
      return;
    }

    clear(host);
    agents.forEach(function (agent) {
      var row = el("div", "agent");
      row.appendChild(el("span", "name", str(agent.name, agent.agentId)));

      var who = agent.role;
      if (agent.profile) who += " · " + agent.profile;
      if (agent.currentWork) who += " · on " + agent.currentWork;
      row.appendChild(el("span", "who", who));

      var stateEl = el("span", "state");
      stateEl.appendChild(el("span", "dot" + (agent.status === "online" ? " good" : "")));
      stateEl.appendChild(el("span", null, str(agent.status, "unknown")));
      row.appendChild(stateEl);

      host.appendChild(row);
    });
  }

  var COLUMNS = [
    { key: "s1", title: "Open", statuses: ["open"] },
    { key: "s2", title: "In progress", statuses: ["in-progress"] },
    { key: "s3", title: "Resolved or closed", statuses: ["resolved", "closed"] }
  ];

  function renderBoard() {
    var host = $("board");
    var problems = (state.snapshot && state.snapshot.problems) || [];
    $("problems-count").textContent = problems.length ? String(problems.length) : "";

    clear(host);

    COLUMNS.forEach(function (column) {
      var inColumn = problems.filter(function (p) {
        return column.statuses.indexOf(p.status) !== -1;
      });

      var col = el("div", "col");
      var heading = el("h3");
      heading.appendChild(el("span", "swatch " + column.key));
      heading.appendChild(el("span", null, column.title + " (" + inColumn.length + ")"));
      col.appendChild(heading);

      if (!inColumn.length) {
        col.appendChild(el("p", "empty", "None"));
      } else {
        inColumn.forEach(function (problem) {
          var card = el("div", "item " + column.key);
          card.appendChild(el("div", "title", str(problem.title, problem.id)));

          var meta = problem.id;
          if (problem.assignedTo) meta += " · claimed by " + problem.assignedTo;
          else if (problem.createdBy) meta += " · by " + problem.createdBy;
          var comments = (problem.comments && problem.comments.length) || 0;
          if (comments) meta += " · " + comments + (comments === 1 ? " comment" : " comments");
          if (problem.dependsOn && problem.dependsOn.length) {
            meta += " · blocked on " + problem.dependsOn.length;
          }
          card.appendChild(el("div", "meta", meta));
          col.appendChild(card);
        });
      }

      host.appendChild(col);
    });
  }

  function renderProposals() {
    var host = $("proposals");
    var proposals = (state.snapshot && state.snapshot.proposals) || [];
    $("proposals-count").textContent = proposals.length ? String(proposals.length) : "";

    if (!proposals.length) {
      empty(host, "No proposals yet.");
      return;
    }

    clear(host);
    proposals.forEach(function (proposal) {
      var card = el("div", "item");
      card.appendChild(el("div", "title", str(proposal.title, proposal.id)));

      var badges = el("div", "meta");
      badges.appendChild(el("span", "badge", "status: " + str(proposal.status, "unknown")));

      var reviews = proposal.reviews || [];
      if (reviews.length) {
        var approvals = reviews.filter(function (r) { return r.verdict === "approve"; }).length;
        var changes = reviews.filter(function (r) { return r.verdict === "request-changes"; }).length;
        badges.appendChild(el("span", "badge",
          reviews.length + (reviews.length === 1 ? " review" : " reviews")));
        if (approvals) badges.appendChild(el("span", "badge", approvals + " approve"));
        if (changes) badges.appendChild(el("span", "badge", changes + " changes requested"));
      } else {
        badges.appendChild(el("span", "badge", "no reviews"));
      }

      if (typeof proposal.mergeThoughtNumber === "number") {
        badges.appendChild(el("span", "badge", "merged at thought " + proposal.mergeThoughtNumber));
      }
      card.appendChild(badges);

      var meta = str(proposal.createdBy, "unknown author");
      if (proposal.sourceBranch) meta += " · " + proposal.sourceBranch;
      if (proposal.problemId) meta += " · " + proposal.problemId;
      card.appendChild(el("div", "meta", meta));

      host.appendChild(card);
    });
  }

  function renderConsensus() {
    var host = $("consensus");
    var markers = (state.snapshot && state.snapshot.consensus) || [];
    $("consensus-count").textContent = markers.length ? String(markers.length) : "";

    if (!markers.length) {
      empty(host, "No consensus markers yet.");
      return;
    }

    clear(host);
    markers.forEach(function (marker) {
      var card = el("div", "item");
      card.appendChild(el("div", "title", str(marker.name, marker.id)));
      if (marker.description) card.appendChild(el("div", "meta", marker.description));

      var agreed = (marker.agreedBy || []).length;
      var meta = agreed + (agreed === 1 ? " agent agreed" : " agents agreed");
      if (typeof marker.thoughtRef === "number") meta += " · thought " + marker.thoughtRef;
      meta += " · " + shortTime(marker.createdAt);
      card.appendChild(el("div", "meta", meta));

      host.appendChild(card);
    });
  }

  function renderFeed() {
    var host = $("feed");
    var channels = (state.snapshot && state.snapshot.channels) || [];

    var messages = [];
    channels.forEach(function (channel) {
      (channel.messages || []).forEach(function (message) {
        messages.push({ problemId: channel.problemId, message: message });
      });
    });
    messages.sort(function (a, b) {
      return String(a.message.timestamp).localeCompare(String(b.message.timestamp));
    });

    $("messages-count").textContent = messages.length ? String(messages.length) : "";

    if (!messages.length) {
      empty(host, "No messages posted yet.");
      return;
    }

    var nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;

    clear(host);
    messages.forEach(function (entry) {
      var row = el("div", "msg");
      var head = el("div", "head");
      head.appendChild(el("span", "who", str(entry.message.agentId, "unknown")));
      head.appendChild(el("span", null, entry.problemId));
      head.appendChild(el("span", null, shortTime(entry.message.timestamp)));
      row.appendChild(head);
      row.appendChild(el("div", "content", str(entry.message.content, "")));
      host.appendChild(row);
    });

    if (nearBottom) host.scrollTop = host.scrollHeight;
  }

  function renderThoughts() {
    var host = $("thoughts");
    $("thoughts-count").textContent = state.thoughts.length ? String(state.thoughts.length) : "";

    if (!state.thoughts.length) {
      empty(host, "No thoughts recorded for this workspace since the page loaded.");
      return;
    }

    var nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;

    clear(host);
    state.thoughts.forEach(function (thought) {
      var row = el("div", "thought");
      row.appendChild(el("span", "kind", thought.kind));
      if (thought.session) row.appendChild(el("span", null, thought.session));
      if (thought.number !== null) row.appendChild(el("span", "n", "#" + thought.number));
      row.appendChild(el("span", "when", shortTime(thought.timestamp)));
      host.appendChild(row);
    });

    if (nearBottom) host.scrollTop = host.scrollHeight;
  }

  function render() {
    renderTiles();
    renderAgents();
    renderBoard();
    renderProposals();
    renderConsensus();
    renderFeed();
    renderThoughts();
  }

  function setNote(text) {
    $("note").textContent = text;
  }

  // ---- data -----------------------------------------------------------------

  function loadWorkspaces() {
    return fetch("/hub/workspaces")
      .then(function (response) {
        if (!response.ok) throw new Error("GET /hub/workspaces returned " + response.status);
        return response.json();
      })
      .then(function (body) {
        state.workspaces = body.workspaces || [];
        var select = $("ws-select");
        clear(select);

        if (!state.workspaces.length) {
          select.appendChild(el("option", null, "no workspaces"));
          select.disabled = true;
          setNote("No workspaces exist yet. Create one through the hub and this page will pick it up on reload.");
          return null;
        }

        select.disabled = false;
        state.workspaces.forEach(function (workspace) {
          var option = el("option", null, str(workspace.name, workspace.id));
          option.value = workspace.id;
          select.appendChild(option);
        });

        var stillPresent = state.workspaces.some(function (w) { return w.id === state.workspaceId; });
        var next = stillPresent ? state.workspaceId : state.workspaces[0].id;
        select.value = next;
        return next;
      });
  }

  function loadSnapshot(workspaceId) {
    var token = ++state.loadToken;
    return fetch("/hub/workspaces/" + encodeURIComponent(workspaceId) + "/snapshot")
      .then(function (response) {
        if (response.status === 404) throw new Error("Workspace " + workspaceId + " no longer exists.");
        if (!response.ok) throw new Error("Snapshot request returned " + response.status);
        return response.json();
      })
      .then(function (snapshot) {
        if (token !== state.loadToken) return;
        state.snapshot = snapshot;
        setNote("");
        render();
      })
      .catch(function (error) {
        if (token !== state.loadToken) return;
        setNote(String(error.message || error));
      });
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (state.workspaceId) loadSnapshot(state.workspaceId);
    }, 250);
  }

  // ---- event stream ---------------------------------------------------------

  function onEvent(event) {
    var parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    state.eventCount += 1;
    state.lastEventAt = parsed.timestamp || new Date().toISOString();

    if (parsed.type === "thought_recorded") {
      var data = parsed.data || {};
      state.thoughts.push({
        kind: str(data.thoughtType, "reasoning"),
        session: typeof data.sessionId === "string" ? data.sessionId.slice(0, 8) : "",
        number: typeof data.thoughtNumber === "number" ? data.thoughtNumber : null,
        timestamp: parsed.timestamp
      });
      if (state.thoughts.length > THOUGHT_LIMIT) {
        state.thoughts = state.thoughts.slice(-THOUGHT_LIMIT);
      }
      renderThoughts();
      renderTiles();
      return;
    }

    // Every other event type mutates hub storage, so re-read the snapshot
    // rather than patching panels from the payload. Agent-scoped events
    // (agent_registered) arrive with workspaceId '*' regardless of the
    // stream filter; they still change the joined agent list, so they
    // refresh too.
    renderTiles();
    scheduleRefresh();
  }

  function connect(workspaceId) {
    if (source) source.close();

    source = new EventSource("/events?workspace_id=" + encodeURIComponent(workspaceId));

    source.onopen = function () {
      setConnection("good", "live");
    };
    source.onmessage = onEvent;
    source.onerror = function () {
      if (source && source.readyState === 2) setConnection("critical", "disconnected");
      else setConnection("warning", "reconnecting");
    };
  }

  function select(workspaceId) {
    state.workspaceId = workspaceId;
    state.snapshot = null;
    // The ticker is stream-only with no snapshot to correct it, so it has to
    // be dropped on a workspace switch or it would show another team's thoughts.
    state.thoughts = [];
    $("ws-id").textContent = workspaceId;
    render();
    loadSnapshot(workspaceId);
    connect(workspaceId);
  }

  $("ws-select").addEventListener("change", function (event) {
    select(event.target.value);
  });

  setConnection("", "connecting");
  render();

  loadWorkspaces()
    .then(function (workspaceId) {
      if (workspaceId) select(workspaceId);
      else setConnection("", "idle");
    })
    .catch(function (error) {
      setNote("Could not reach the hub: " + String(error.message || error));
      setConnection("critical", "unavailable");
    });
})();
</script>
</body>
</html>
`;
