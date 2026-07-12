// Shared filter logic + URL state (de)serialization + filter-bar UI, used by the dashboard
// (app.js), Insights (insights.js), and Kanban (kanban.js) pages so all three filter
// identically instead of drifting apart with three hand-rolled copies.

const STAGE_OPTIONS = ['Not applied','Applied','Recruiter screen','Interview','Final round'];
const OUTCOME_OPTIONS = ['Offer','Rejected','Withdrawn'];
// Referral/recruiter-contact are booleans on the job, not a single-valued field like
// stage/outcome, but they're exposed as ordinary filter chips alongside them — see
// matchesStageOutcome below for how a boolean field maps onto the same flat chip set.
const FLAG_CHIPS = ['Referral', 'Recruiter contact'];

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function badge(text, bg, color) {
  return `<span style="font-size:11px;padding:3px 9px;border-radius:6px;font-weight:500;background:${bg};color:${color}">${text}</span>`;
}

function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parses a 'YYYY-MM-DD' string as a local-midnight Date. Using `new Date(str)` directly
// parses it as UTC midnight, which shifts to the previous day once read back with local
// getters (getDate/getMonth/etc.) in any timezone behind UTC — this avoids that trap.
function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function presetDateRange(preset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // Monday = 0

  switch (preset) {
    case 'today':
      return { from: fmtLocalDate(today), to: fmtLocalDate(today) };
    case 'this-week': {
      const monday = new Date(today); monday.setDate(today.getDate() - dow);
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      return { from: fmtLocalDate(monday), to: fmtLocalDate(sunday) };
    }
    case 'last-week': {
      const thisMonday = new Date(today); thisMonday.setDate(today.getDate() - dow);
      const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
      const lastSunday = new Date(lastMonday); lastSunday.setDate(lastMonday.getDate() + 6);
      return { from: fmtLocalDate(lastMonday), to: fmtLocalDate(lastSunday) };
    }
    case 'this-month': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: fmtLocalDate(first), to: fmtLocalDate(last) };
    }
    case 'last-month': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: fmtLocalDate(first), to: fmtLocalDate(last) };
    }
    case 'this-year': {
      const first = new Date(today.getFullYear(), 0, 1);
      const last = new Date(today.getFullYear(), 11, 31);
      return { from: fmtLocalDate(first), to: fmtLocalDate(last) };
    }
    default:
      return null; // 'all'
  }
}

function matchesDateFilter(appliedDate, dateFilter) {
  if (!dateFilter || dateFilter.preset === 'all') return true;
  const range = dateFilter.preset === 'custom'
    ? { from: dateFilter.from, to: dateFilter.to }
    : presetDateRange(dateFilter.preset);
  if (!range || (!range.from && !range.to)) return true;
  if (!appliedDate) return false; // no applied date recorded — excluded once a date filter is active
  if (range.from && appliedDate < range.from) return false;
  if (range.to && appliedDate > range.to) return false;
  return true;
}

function matchesStageOutcome(job, filterSelections) {
  if (!filterSelections || filterSelections.size === 0) return true;
  if (filterSelections.has(job.stage) || filterSelections.has(job.outcome)) return true;
  if (filterSelections.has('Referral') && job.has_referral) return true;
  if (filterSelections.has('Recruiter contact') && job.recruiter_contact) return true;
  return false;
}

function matchesSearch(job, searchQuery) {
  if (!searchQuery) return true;
  return `${job.company} ${job.title}`.toLowerCase().includes(searchQuery.toLowerCase());
}

function filterJobs(jobsList, state) {
  return jobsList.filter(j =>
    matchesStageOutcome(j, state.filterSelections) &&
    matchesDateFilter(j.applied_date, state.dateFilter) &&
    matchesSearch(j, state.searchQuery)
  );
}

// ---- URL <-> filter state, so the Insights page can inherit the dashboard's filters ----
function filterStateToParams(state) {
  const params = new URLSearchParams();
  if (state.filterSelections && state.filterSelections.size) {
    params.set('sel', Array.from(state.filterSelections).join(','));
  }
  if (state.dateFilter && state.dateFilter.preset !== 'all') {
    params.set('preset', state.dateFilter.preset);
    if (state.dateFilter.preset === 'custom') {
      if (state.dateFilter.from) params.set('from', state.dateFilter.from);
      if (state.dateFilter.to) params.set('to', state.dateFilter.to);
    }
  }
  if (state.searchQuery) params.set('q', state.searchQuery);
  return params;
}

function filterStateFromParams(params) {
  const sel = params.get('sel');
  const filterSelections = new Set(sel ? sel.split(',').filter(Boolean) : []);
  const dateFilter = {
    preset: params.get('preset') || 'all',
    from: params.get('from') || '',
    to: params.get('to') || ''
  };
  const searchQuery = params.get('q') || '';
  return { filterSelections, dateFilter, searchQuery };
}

function describeFilterState(state) {
  const parts = [];
  if (state.filterSelections && state.filterSelections.size) {
    parts.push(Array.from(state.filterSelections).join(', '));
  }
  if (state.dateFilter && state.dateFilter.preset !== 'all') {
    if (state.dateFilter.preset === 'custom') {
      const f = state.dateFilter.from || '…', t = state.dateFilter.to || '…';
      parts.push(`applied ${f} to ${t}`);
    } else {
      parts.push('applied ' + state.dateFilter.preset.replace('-', ' '));
    }
  }
  if (state.searchQuery) parts.push(`matching "${state.searchQuery}"`);
  return parts.length ? parts.join(' · ') : 'All applications';
}

// ---- Shared filter-bar UI ----
// Wires up a filter bar against whatever's present in the host page's DOM: #search-input,
// #btn-filters-toggle + #filters-panel, #filter-row (chips), and #date-preset/#custom-date-range/
// #date-from/#date-to. Any of these can be absent (e.g. a page that only wants chips) — each
// piece no-ops if its elements aren't found. Mutates `state` {filterSelections, dateFilter,
// searchQuery} in place and calls onChange() after every change so the host page can re-render
// its own content (dashboard cards, Insights charts, Kanban columns) with the shared filterJobs().
function renderFilterChips(state, onChange) {
  const row = document.getElementById('filter-row');
  if (!row) return;
  const chips = ['all', ...STAGE_OPTIONS, ...OUTCOME_OPTIONS, ...FLAG_CHIPS];
  row.innerHTML = chips.map(s => {
    const isActive = s === 'all' ? state.filterSelections.size === 0 : state.filterSelections.has(s);
    return `<button type="button" class="filter-btn ${isActive ? 'active' : ''}" data-chip="${esc(s)}">${s === 'all' ? 'All' : esc(s)}</button>`;
  }).join('');
  row.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const s = btn.dataset.chip;
      if (s === 'all') state.filterSelections.clear();
      else if (state.filterSelections.has(s)) state.filterSelections.delete(s);
      else state.filterSelections.add(s);
      renderFilterChips(state, onChange);
      updateFilterToggleLabel(state);
      onChange();
    };
  });
}

function updateFilterToggleLabel(state) {
  const btn = document.getElementById('btn-filters-toggle');
  if (!btn) return;
  const activeCount = state.filterSelections.size + (state.dateFilter.preset !== 'all' ? 1 : 0);
  btn.textContent = activeCount ? `Filters (${activeCount}) ▾` : 'Filters ▾';
}

function initFilterBar(state, onChange) {
  renderFilterChips(state, onChange);
  updateFilterToggleLabel(state);

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = state.searchQuery || '';
    searchInput.oninput = e => { state.searchQuery = e.target.value; onChange(); };
  }

  const toggleBtn = document.getElementById('btn-filters-toggle');
  const panel = document.getElementById('filters-panel');
  if (toggleBtn && panel) {
    toggleBtn.onclick = () => { panel.hidden = !panel.hidden; };
  }

  const presetSel = document.getElementById('date-preset');
  const customRange = document.getElementById('custom-date-range');
  const fromInput = document.getElementById('date-from');
  const toInput = document.getElementById('date-to');
  if (presetSel) {
    presetSel.value = state.dateFilter.preset;
    if (customRange) customRange.hidden = state.dateFilter.preset !== 'custom';
    if (fromInput) fromInput.value = state.dateFilter.from || '';
    if (toInput) toInput.value = state.dateFilter.to || '';
    presetSel.onchange = e => {
      state.dateFilter.preset = e.target.value;
      if (customRange) customRange.hidden = state.dateFilter.preset !== 'custom';
      updateFilterToggleLabel(state);
      onChange();
    };
    if (fromInput) fromInput.onchange = e => { state.dateFilter.from = e.target.value; onChange(); };
    if (toInput) toInput.onchange = e => { state.dateFilter.to = e.target.value; onChange(); };
  }
}
