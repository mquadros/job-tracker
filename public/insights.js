// ---- Boot ----
let allJobs = [];
let currentVisible = [];

function renderAll() {
  currentVisible = filterJobs(allJobs, filterState);
  document.getElementById('filter-summary').textContent =
    `Showing: ${describeFilterState(filterState)} (${currentVisible.length} of ${allJobs.length} applications)`;
  renderDailyChart(currentVisible);
  renderFunnelChart(currentVisible);
  renderDonutChart(currentVisible);
}

// Seeded from the dashboard's URL params on first load, then live-editable via the same
// filter bar as the other pages (initFilterBar), not just a one-time inherited snapshot.
let filterState = { filterSelections: new Set(), dateFilter: { preset: 'all', from: '', to: '' }, searchQuery: '' };

(async () => {
  const meRes = await fetch('/api/auth/me');
  if (meRes.status === 401) { window.location.href = '/login.html'; return; }

  document.getElementById('btn-logout').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  };

  const jobsRes = await fetch('/api/jobs');
  allJobs = await jobsRes.json();

  const inherited = filterStateFromParams(new URLSearchParams(window.location.search));
  filterState.filterSelections = inherited.filterSelections;
  filterState.dateFilter = inherited.dateFilter;
  filterState.searchQuery = inherited.searchQuery;

  initFilterBar(filterState, renderAll);
  renderAll();

  document.querySelectorAll('#donut-dimension-row button').forEach(btn => {
    btn.onclick = () => {
      donutDimension = btn.dataset.dim;
      document.querySelectorAll('#donut-dimension-row button').forEach(b => b.classList.toggle('active', b === btn));
      renderDonutChart(currentVisible);
    };
  });
})();

// ---- Applications per day ----
function renderDailyChart(jobs) {
  const container = document.getElementById('daily-chart');
  const dated = jobs.filter(j => j.applied_date);
  if (!dated.length) {
    container.innerHTML = '<p class="chart-empty">No applications with an applied date in this filter.</p>';
    return;
  }

  const dateStrs = dated.map(j => j.applied_date).sort();
  const minDate = parseLocalDate(dateStrs[0]);
  const maxDate = parseLocalDate(dateStrs[dateStrs.length - 1]);
  const spanDays = Math.round((maxDate - minDate) / 86400000) + 1;
  const bucketByWeek = spanDays > 60;

  const counts = new Map();
  dated.forEach(j => {
    let key = j.applied_date;
    if (bucketByWeek) {
      const d = parseLocalDate(j.applied_date);
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow); // Monday of that week
      key = fmtLocalDate(d);
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  // Fill gaps for a continuous axis so quiet stretches are visible, not hidden.
  const allKeys = [];
  if (bucketByWeek) {
    const cursor = new Date(minDate);
    cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
    const end = new Date(maxDate);
    while (cursor <= end) { allKeys.push(fmtLocalDate(cursor)); cursor.setDate(cursor.getDate() + 7); }
  } else {
    const cursor = new Date(minDate);
    while (cursor <= maxDate) { allKeys.push(fmtLocalDate(cursor)); cursor.setDate(cursor.getDate() + 1); }
  }

  const data = allKeys.map(k => ({ key: k, count: counts.get(k) || 0 }));
  const maxCount = Math.max(...data.map(d => d.count), 1);

  const barW = 20, gap = 6, chartH = 200, labelPad = 44, topPad = 20;
  const w = data.length * (barW + gap) + gap;
  const h = chartH + labelPad + topPad;
  const showEveryNth = Math.max(1, Math.ceil(data.length / 20));

  let bars = '';
  data.forEach((d, i) => {
    const x = gap + i * (barW + gap);
    const barH = (d.count / maxCount) * chartH;
    const y = topPad + chartH - barH;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(barH,1)}" rx="3" style="fill:var(--primary)" opacity="${d.count ? 0.85 : 0.15}"><title>${esc(d.key)}: ${d.count}</title></rect>`;
    if (d.count) bars += `<text x="${x + barW/2}" y="${y - 4}" font-size="10" text-anchor="middle" style="fill:var(--text-muted)">${d.count}</text>`;
    if (i % showEveryNth === 0) {
      const labelY = topPad + chartH + 14;
      bars += `<text x="${x + barW/2}" y="${labelY}" font-size="9" text-anchor="end" style="fill:var(--text-muted)" transform="rotate(-40 ${x+barW/2} ${labelY})">${esc(d.key)}</text>`;
    }
  });

  container.innerHTML = `
    ${bucketByWeek ? '<p class="chart-note">Bucketed by week — date range exceeds 60 days (week shown is the Monday it starts)</p>' : ''}
    <svg viewBox="0 0 ${w} ${h}" width="${Math.min(w, 900)}" height="${h}">${bars}</svg>`;
}

// ---- Pipeline funnel (Sankey) ----
// Semantics: each job's *current* stage implies it passed through every earlier stage (stage
// is a linear progression), so the continue flow k->k+1 = jobs whose current stage index is
// >= k+1. A job's outcome exits into the column right after the stage it happened at — a
// rejection after "Recruiter screen" lands one column short of a rejection after "Interview".
// Node 0 is "Applications" (the grand total reached[0], not literally the Not-applied count).
//
// Layout: a lightweight d3-sankey-style pass. Nodes are placed in columns, then relaxed over
// several iterations toward the flow-weighted barycenter of the nodes they connect to (left
// pass aligns to sources, right pass aligns to targets), resolving overlaps after each pass.
// This is what makes the ribbons bend and settle organically instead of running dead-straight.
// Each link is filled with a source->target color gradient so every step reads as its own hue.
function renderFunnelChart(jobs) {
  const container = document.getElementById('funnel-chart');
  if (!jobs.length) {
    container.innerHTML = '<p class="chart-empty">No applications in this filter.</p>';
    return;
  }

  // "In Progress" is a synthetic branch, not a real `job.outcome` value — it's whatever's left
  // at a stage with no outcome recorded yet (still active, no verdict). Treated as just another
  // exit-style branch here so it renders exactly like Offer/Rejected/Withdrawn, one per stage
  // it occurs at.
  const OUTCOME_KEYS = ['Offer', 'Rejected', 'Withdrawn', 'In Progress'];
  const stageIdx = s => STAGE_OPTIONS.indexOf(s);
  const numStages = STAGE_OPTIONS.length;
  const reached = STAGE_OPTIONS.map((s, i) => jobs.filter(j => stageIdx(j.stage) >= i).length);
  const exits = STAGE_OPTIONS.map((s, i) => {
    const bucket = { Offer: 0, Rejected: 0, Withdrawn: 0, 'In Progress': 0 };
    jobs.forEach(j => {
      if (stageIdx(j.stage) !== i) return;
      bucket[j.outcome || 'In Progress']++;
    });
    return bucket;
  });

  // Per-step palette: a cool blue->teal->green progression along the success spine, warm hues
  // for exits, neutral slate for still-active. Each node carries its own color; links blend
  // from source hue to target hue.
  const STAGE_COLOR = ['#7E8AA6', '#4E79E0', '#2E9FD4', '#1FB5B0', '#35BE83'];
  const OUTCOME_COLOR = { Offer: '#2FA84F', Rejected: '#E05A54', Withdrawn: '#E6A23C', 'In Progress': '#8B96A8' };

  // ---- build node/link graph ----
  const nodes = [];
  const byId = {};
  const addNode = (id, col, value, label, color, isOutcome) => {
    const n = { id, col, value, label, color, isOutcome, inLinks: [], outLinks: [] };
    nodes.push(n); byId[id] = n; return n;
  };
  const links = [];
  const addLink = (sId, tId, value) => {
    const l = { s: byId[sId], t: byId[tId], value };
    links.push(l); byId[sId].outLinks.push(l); byId[tId].inLinks.push(l);
  };

  for (let i = 0; i < numStages; i++) {
    if (i > 0 && reached[i] <= 0) break;
    addNode('stage' + i, i, reached[i], i === 0 ? 'Applications' : STAGE_OPTIONS[i], STAGE_COLOR[i], false);
  }
  for (let i = 0; i < numStages; i++) {
    if (!byId['stage' + i]) continue;
    if (byId['stage' + (i + 1)] && reached[i + 1] > 0) addLink('stage' + i, 'stage' + (i + 1), reached[i + 1]);
    OUTCOME_KEYS.forEach(o => {
      if (exits[i][o] > 0) {
        addNode('out' + i + o, i + 1, exits[i][o], o, OUTCOME_COLOR[o], true);
        addLink('stage' + i, 'out' + i + o, exits[i][o]);
      }
    });
  }

  // ---- geometry: rising success spine, exits fanning to the bottom ----
  // The success chain leaves the TOP of each node, and each successive stage is lifted by
  // `riseStep`, so the spine climbs toward the top-right (culminating in the Offer node).
  // Outcome exits leave below the continue slice and are dropped by `exitDrop` into the lower
  // band, so attrition fans downward — the read an exec audience expects: success up, failures
  // down. (A pure barycenter auto-layout let the majority "continue" flow sag downward; this
  // deterministic bias guarantees the intended direction regardless of where the volume sits.)
  const nodeW = 13, colGap = 165, nodePad = 34, leftMargin = 104, bottomPad = 44;
  const scale = 190 / Math.max(...nodes.map(n => n.value), 1); // tallest node ~190px tall
  const minH = 4, riseStep = 40, exitDrop = 96;
  const colX = i => leftMargin + i * (nodeW + colGap);
  nodes.forEach(n => { n.h = Math.max(n.value * scale, minH); n.x0 = colX(n.col); n.x1 = n.x0 + nodeW; });

  const stageNode = i => byId['stage' + i];
  for (let i = 0; i < numStages; i++) { const n = stageNode(i); if (n) n.y0 = -i * riseStep; }

  // Outflows tile each source top-to-bottom (continue first, then exits); each exit node is
  // dropped exitDrop below where its band leaves the spine, stacked with a gap if a column has
  // more than one. A terminal success (Offer, no continuing stage after it) stays level with
  // the spine so it reads as the top-right cap of the success path rather than an exit.
  for (let i = 0; i < numStages; i++) {
    const src = stageNode(i);
    if (!src) continue;
    const cont = stageNode(i + 1);
    let srcCursor = src.y0 + ((cont && reached[i + 1] > 0) ? Math.max(reached[i + 1] * scale, minH) : 0);
    let exitTop = srcCursor + exitDrop;
    OUTCOME_KEYS.forEach(o => {
      const on = byId['out' + i + o];
      if (!on) return;
      on.y0 = cont ? exitTop : src.y0;
      exitTop += on.h + nodePad;
      srcCursor += on.h;
    });
  }

  // recenter the whole composition vertically (all positions above were relative)
  const allTop = Math.min(...nodes.map(n => n.y0));
  const offset = 56 - allTop;
  nodes.forEach(n => { n.y0 += offset; });

  const cy = n => n.y0 + n.h / 2;

  // ---- allocate link endpoints along each node's edge (continue up top, exits below) ----
  nodes.forEach(n => {
    n.outLinks.sort((a, b) => cy(a.t) - cy(b.t));
    let y = n.y0;
    n.outLinks.forEach(l => { l.w = Math.max(l.value * scale, minH); l.sy0 = y; y += l.w; });
    n.inLinks.sort((a, b) => cy(a.s) - cy(b.s));
    let ty = n.y0;
    n.inLinks.forEach(l => { l.ty0 = ty; ty += Math.max(l.value * scale, minH); });
  });

  // ---- render ----
  let defs = '', linkSvg = '';
  links.forEach((l, i) => {
    const gid = 'sankey-lg-' + i;
    defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0" stop-color="${l.s.color}"/><stop offset="1" stop-color="${l.t.color}"/></linearGradient>`;
    const x0 = l.s.x1, x1 = l.t.x0, xm = (x0 + x1) / 2;
    const sy0 = l.sy0, sy1 = l.sy0 + l.w, ty0 = l.ty0, ty1 = l.ty0 + l.w;
    linkSvg += `<path d="M ${x0},${sy0} C ${xm},${sy0} ${xm},${ty0} ${x1},${ty0} L ${x1},${ty1} C ${xm},${ty1} ${xm},${sy1} ${x0},${sy1} Z" fill="url(#${gid})" opacity="0.62"/>`;
  });

  let nodeSvg = '';
  nodes.forEach(n => {
    const midY = cy(n);
    nodeSvg += `<rect x="${n.x0}" y="${n.y0}" width="${nodeW}" height="${n.h}" rx="2.5" fill="${n.color}"/>`;
    if (n.col === 0) { // leftmost — label to the left
      nodeSvg += `<text x="${n.x0 - 12}" y="${midY - 2}" font-size="15" font-weight="700" text-anchor="end" style="fill:var(--text)">${n.value}</text>`;
      nodeSvg += `<text x="${n.x0 - 12}" y="${midY + 14}" font-size="11" text-anchor="end" style="fill:var(--text-muted)">${esc(n.label)}</text>`;
    } else if (!n.outLinks.length) { // terminal — label to the right
      nodeSvg += `<text x="${n.x1 + 12}" y="${midY - 2}" font-size="15" font-weight="700" text-anchor="start" style="fill:var(--text)">${n.value}</text>`;
      nodeSvg += `<text x="${n.x1 + 12}" y="${midY + 14}" font-size="11" text-anchor="start" style="fill:var(--text-muted)">${esc(n.label)}</text>`;
    } else { // mid-flow — label above
      nodeSvg += `<text x="${n.x0 + nodeW / 2}" y="${n.y0 - 21}" font-size="15" font-weight="700" text-anchor="middle" style="fill:var(--text)">${n.value}</text>`;
      nodeSvg += `<text x="${n.x0 + nodeW / 2}" y="${n.y0 - 7}" font-size="11" text-anchor="middle" style="fill:var(--text-muted)">${esc(n.label)}</text>`;
    }
  });

  const w = Math.max(...nodes.map(n => n.x1)) + 130;
  const h = Math.max(...nodes.map(n => n.y0 + n.h)) + bottomPad;
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${Math.min(w, 980)}" height="${h}"><defs>${defs}</defs>${linkSvg}${nodeSvg}</svg>`;
}

// ---- Breakdown donut ----
let donutDimension = 'stage';

const DONUT_STAGE_COLORS = { 'Not applied': '#7E8AA6', 'Applied': '#4E79E0', 'Recruiter screen': '#2E9FD4', 'Interview': '#1FB5B0', 'Final round': '#35BE83' };
const DONUT_OUTCOME_COLORS = { Offer: '#2FA84F', Rejected: '#E05A54', Withdrawn: '#E6A23C', 'In Progress': '#8B96A8' };
const DONUT_FIT_COLORS = { strong: '#3B6D11', good: '#185FA5', stretch: '#854F0B' };
const DONUT_LOC_TYPE_COLORS = { remote: '#0F6E56', hybrid: '#185FA5', onsite: '#854F0B' };
const DONUT_GENERIC_COLORS = ['#4E79E0', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', '#EDC949', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'];
const DONUT_FIT_LABELS = { strong: 'Strong', good: 'Good', stretch: 'Stretch' };

function donutKeyFor(job, dimension) {
  if (dimension === 'outcome') return job.outcome || 'In Progress';
  if (dimension === 'location') return job.location || 'Unspecified';
  return job[dimension];
}

function donutColorFor(dimension, key, idx) {
  if (dimension === 'stage') return DONUT_STAGE_COLORS[key] || '#888';
  if (dimension === 'outcome') return DONUT_OUTCOME_COLORS[key] || '#888';
  if (dimension === 'fit') return DONUT_FIT_COLORS[key] || '#888';
  if (dimension === 'location_type') return DONUT_LOC_TYPE_COLORS[key] || '#888';
  return DONUT_GENERIC_COLORS[idx % DONUT_GENERIC_COLORS.length];
}

function donutLabelFor(dimension, key) {
  if (dimension === 'fit') return DONUT_FIT_LABELS[key] || key;
  if (dimension === 'location_type') return key.charAt(0).toUpperCase() + key.slice(1);
  return key;
}

function renderDonutChart(jobs) {
  const container = document.getElementById('donut-chart');
  if (!jobs.length) {
    container.innerHTML = '<p class="chart-empty">No applications in this filter.</p>';
    return;
  }

  const counts = new Map();
  jobs.forEach(j => {
    const key = donutKeyFor(j, donutDimension);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const total = jobs.length;

  // A count buried at 13px in muted gray is the classic "chart nobody can read from across
  // the room" mistake — the percentage is the headline number here, so it gets top billing:
  // large, bold, and colored to match its slice (ties the legend row back to the donut
  // without needing to cross-reference a key). Count is demoted to a small caption under it.
  const size = 240, radius = 84, strokeW = 36, cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * radius;

  let cursor = 0, segments = '', legend = '';
  entries.forEach(([key, count], idx) => {
    const pct = count / total;
    const pctLabel = Math.round(pct * 100);
    const dash = pct * circumference;
    const color = donutColorFor(donutDimension, key, idx);
    const label = donutLabelFor(donutDimension, key);
    segments += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeW}" ` +
      `stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-cursor}" transform="rotate(-90 ${cx} ${cy})">` +
      `<title>${esc(label)}: ${count} (${pctLabel}%)</title></circle>`;
    cursor += dash;
    legend += `<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">` +
      `<span style="width:13px;height:13px;border-radius:50%;background:${color};flex-shrink:0;"></span>` +
      `<span style="font-size:26px;font-weight:800;color:${color};min-width:64px;letter-spacing:-0.02em;line-height:1;">${pctLabel}%</span>` +
      `<span style="flex:1;min-width:0;">` +
        `<div style="color:var(--text);font-size:14px;font-weight:600;">${esc(label)}</div>` +
        `<div style="color:var(--text-muted);font-size:12px;">${count} application${count === 1 ? '' : 's'}</div>` +
      `</span></div>`;
  });

  container.innerHTML = `
    <div style="display:flex;gap:2.5rem;flex-wrap:wrap;align-items:center;">
      <svg viewBox="0 0 ${size} ${size}" width="240" height="240" style="flex-shrink:0;">
        ${segments}
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="34" font-weight="800" style="fill:var(--text)">${total}</text>
        <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="12" style="fill:var(--text-muted)">applications</text>
      </svg>
      <div style="min-width:200px;flex:1;">${legend}</div>
    </div>`;
}
