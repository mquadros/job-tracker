// ---- Presentation (kept local — dashboard-specific palettes live in app.js, not filters.js) ----
const FIT_COLORS = {
  strong: { bg: '#EAF3DE', color: '#3B6D11', label: 'Strong fit' },
  good:   { bg: '#E6F1FB', color: '#185FA5', label: 'Good fit' },
  stretch:{ bg: '#FAEEDA', color: '#854F0B', label: 'Stretch fit' }
};
const LOC_COLORS = {
  remote: { bg: '#E1F5EE', color: '#0F6E56' },
  hybrid: { bg: '#E6F1FB', color: '#185FA5' },
  onsite: { bg: '#FAEEDA', color: '#854F0B' }
};
const OUTCOME_BADGE_COLORS = {
  Offer: { bg: '#E1F5EE', color: '#0F6E56' },
  Rejected: { bg: '#FBE2E2', color: '#A32D2D' },
  Withdrawn: { bg: '#FBE2E2', color: '#A32D2D' }
};
const FLAG_COLORS = {
  Referral: { bg: '#F3E8FF', color: '#7C3AED' },
  Recruiter: { bg: '#FEF3C7', color: '#92400E' }
};

// ---- State ----
let allJobs = [];
let filterState = { filterSelections: new Set(), dateFilter: { preset: 'all', from: '', to: '' }, searchQuery: '' };

// ---- API ----
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { window.location.href = '/login.html'; return null; }
  return res.json();
}

// ---- Render ----
function renderBoard() {
  const visible = filterJobs(allJobs, filterState);
  const board = document.getElementById('kanban-board');
  board.innerHTML = STAGE_OPTIONS.map(stage => {
    const stageJobs = visible.filter(j => j.stage === stage);
    return `
    <div class="kanban-column">
      <div class="kanban-column-header">
        <span>${esc(stage)}</span>
        <span class="kanban-count">${stageJobs.length}</span>
      </div>
      <div class="kanban-column-body" data-stage="${esc(stage)}">
        ${stageJobs.map(kanbanCard).join('') || '<p class="chart-empty" style="padding:.5rem 0;">No jobs</p>'}
      </div>
    </div>`;
  }).join('');

  wireDragAndDrop();
}

function kanbanCard(j) {
  const fit = FIT_COLORS[j.fit] || FIT_COLORS.good;
  const loc = LOC_COLORS[j.location_type] || LOC_COLORS.remote;
  const outcomeBadge = j.outcome && OUTCOME_BADGE_COLORS[j.outcome];
  return `
    <div class="kanban-card" draggable="true" data-id="${j.id}">
      <p class="kanban-card-title">${esc(j.title)}</p>
      <p class="kanban-card-company">${esc(j.company)}</p>
      <div class="kanban-card-tags">
        ${badge(j.location_type, loc.bg, loc.color)}
        ${badge(fit.label, fit.bg, fit.color)}
        ${outcomeBadge ? badge(j.outcome, outcomeBadge.bg, outcomeBadge.color) : ''}
        ${j.has_referral ? badge('Referral', FLAG_COLORS.Referral.bg, FLAG_COLORS.Referral.color) : ''}
        ${j.recruiter_contact ? badge('Recruiter', FLAG_COLORS.Recruiter.bg, FLAG_COLORS.Recruiter.color) : ''}
      </div>
    </div>`;
}

function wireDragAndDrop() {
  document.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  document.querySelectorAll('.kanban-column-body').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const jobId = Number(e.dataTransfer.getData('text/plain'));
      const newStage = col.dataset.stage;
      const job = allJobs.find(j => j.id === jobId);
      if (!job || job.stage === newStage) return;

      const prevStage = job.stage;
      job.stage = newStage; // optimistic update — feels instant, reconciled below
      renderBoard();

      const updated = await api('PATCH', `/api/jobs/${jobId}`, { stage: newStage });
      if (!updated || updated.error) {
        job.stage = prevStage; // revert on failure (e.g. a stale/invalid state)
        renderBoard();
      }
    });
  });
}

// ---- Boot ----
(async () => {
  const meRes = await fetch('/api/auth/me');
  if (meRes.status === 401) { window.location.href = '/login.html'; return; }

  document.getElementById('btn-logout').onclick = async () => {
    await api('POST', '/api/auth/logout');
    window.location.href = '/login.html';
  };

  const jobsRes = await fetch('/api/jobs');
  allJobs = await jobsRes.json();

  const inherited = filterStateFromParams(new URLSearchParams(window.location.search));
  filterState.filterSelections = inherited.filterSelections;
  filterState.dateFilter = inherited.dateFilter;
  filterState.searchQuery = inherited.searchQuery;

  initFilterBar(filterState, renderBoard);
  renderBoard();
})();
