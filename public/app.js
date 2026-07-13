// ---- Auth guard ----
async function getUser() {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  return res.json();
}

// ---- Helpers ----
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
const STAGE_COLORS = {
  'Applied':         '#185FA5',
  'Recruiter screen':'#854F0B',
  'Interview':       '#3B6D11',
  'Final round':     '#3B6D11'
};
const OUTCOME_COLORS = {
  'Offer':     '#0F6E56',
  'Rejected':  '#A32D2D',
  'Withdrawn': '#A32D2D'
};
const FLAG_COLORS = {
  Referral: { bg: '#F3E8FF', color: '#7C3AED' },
  Recruiter: { bg: '#FEF3C7', color: '#92400E' }
};

// ---- State ----
let jobs = [];
// Shared with filters.js's initFilterBar/filterJobs — see that file for the filter-bar UI
// wiring used identically by this page, Insights, and Kanban.
let filterState = { filterSelections: new Set(), dateFilter: { preset: 'all', from: '', to: '' }, searchQuery: '' };
let expanded = {};
let editingId = null;
let currentUser = {};

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

async function loadJobs() {
  jobs = await api('GET', '/api/jobs') || [];
  render();
}

// ---- Render ----
function renderCards(visible) {
  const container = document.getElementById('cards-container');
  if (!visible.length) {
    container.innerHTML = `<p style="color:#888;font-size:14px;padding:1rem 0;">No applications match this filter.</p>`;
    return;
  }
  container.innerHTML = visible.map(j => {
    const fit = FIT_COLORS[j.fit] || FIT_COLORS.good;
    const loc = LOC_COLORS[j.location_type] || LOC_COLORS.remote;
    const isExp = expanded[j.id];
    const stageColor = STAGE_COLORS[j.stage] || '#888';
    const outcomeColor = OUTCOME_COLORS[j.outcome] || '#888';
    return `
    <div class="job-card" id="card-${j.id}">
      <div class="job-card-header">
        <div style="flex:1;min-width:0;">
          ${j.job_url
            ? `<a href="${esc(j.job_url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;">
                 <p class="job-title">${esc(j.title)}</p>
                 <span class="job-company">${esc(j.company)}${j.location ? ' &middot; ' + esc(j.location) : ''}</span>
               </a>`
            : `<p class="job-title">${esc(j.title)}</p>
               <span class="job-company">${esc(j.company)}${j.location ? ' &middot; ' + esc(j.location) : ''}</span>`}
          ${j.applied_date ? `<div style="font-size:11px;color:#aaa;margin-top:2px;">Applied ${esc(j.applied_date)}</div>` : ''}
        </div>
        <div class="job-card-actions">
          <div style="display:flex;align-items:center;gap:8px;">
            <select class="status-select" onchange="updateStage(${j.id}, this.value)" style="color:${stageColor}">
              ${STAGE_OPTIONS.map(o => `<option${j.stage===o?' selected':''}>${o}</option>`).join('')}
            </select>
            <select class="status-select" onchange="updateOutcome(${j.id}, this.value)" style="color:${outcomeColor}">
              <option value=""${!j.outcome?' selected':''}>In Progress</option>
              ${OUTCOME_OPTIONS.map(o => `<option${j.outcome===o?' selected':''}>${o}</option>`).join('')}
            </select>
            <button class="btn-icon" title="Edit" onclick="openEdit(${j.id})">✎</button>
            <button class="btn-icon btn-danger" title="Delete" onclick="deleteJob(${j.id})">✕</button>
          </div>
          <div class="job-card-files">
            ${j.resume_file ? `<span class="file-link-row"><a href="/api/jobs/${j.id}/files/resume" download>${esc(j.resume_file)}</a><button type="button" class="file-remove-btn" title="Remove resume" onclick="removeJobFile(${j.id},'resume')">✕</button></span>` : ''}
            ${j.cover_letter_file ? `<span class="file-link-row"><a href="/api/jobs/${j.id}/files/cover-letter" download>${esc(j.cover_letter_file)}</a><button type="button" class="file-remove-btn" title="Remove cover letter" onclick="removeJobFile(${j.id},'cover-letter')">✕</button></span>` : ''}
          </div>
        </div>
      </div>
      <div class="job-meta">
        ${badge(j.location_type, loc.bg, loc.color)}
        ${badge(fit.label, fit.bg, fit.color)}
        ${j.has_referral ? badge('Referral', FLAG_COLORS.Referral.bg, FLAG_COLORS.Referral.color) : ''}
        ${j.recruiter_contact ? badge('Recruiter', FLAG_COLORS.Recruiter.bg, FLAG_COLORS.Recruiter.color) : ''}
      </div>
      <button class="expand-btn" onclick="toggleExpand(${j.id})">${isExp?'▲':'▼'} Notes</button>
      ${isExp ? `
        ${j.gap ? `<div class="gap-tag">${esc(j.gap)}</div>` : ''}
        ${j.notes ? `<div class="notes-display">${esc(j.notes)}</div>` : '<div class="notes-display" style="color:#aaa;font-style:italic;">No notes yet.</div>'}
      ` : ''}
    </div>`;
  }).join('');
}

function render() {
  const visible = filterJobs(jobs, filterState);
  renderCards(visible);
}

// ---- Actions ----
window.toggleExpand = function(id) { expanded[id] = !expanded[id]; render(); };

// ---- CSV export (currently filtered jobs, opens natively in Excel) ----
function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

document.getElementById('btn-export').onclick = () => {
  const visible = filterJobs(jobs, filterState);
  const cols = [
    ['Company', 'company'], ['Title', 'title'], ['Location', 'location'], ['Location type', 'location_type'],
    ['Fit', 'fit_label'], ['Stage', 'stage'], ['Outcome', 'outcome'], ['Applied date', 'applied_date'],
    ['Job URL', 'job_url'], ['Referral', j => j.has_referral ? 'Yes' : 'No'],
    ['Recruiter contact', j => j.recruiter_contact ? 'Yes' : 'No'],
    ['Resume', 'resume_file'], ['Cover letter', 'cover_letter_file'], ['Notes', 'notes'], ['Created', 'created_at']
  ];
  const header = cols.map(([label]) => csvField(label)).join(',');
  const rows = visible.map(j => cols.map(([, key]) => csvField(typeof key === 'function' ? key(j) : j[key])).join(','));
  const csv = [header, ...rows].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `job-applications-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

window.updateStage = async function(id, stage) {
  const updated = await api('PATCH', `/api/jobs/${id}`, { stage });
  if (updated) { jobs = jobs.map(j => j.id === id ? updated : j); render(); }
};

window.updateOutcome = async function(id, outcome) {
  const updated = await api('PATCH', `/api/jobs/${id}`, { outcome });
  if (updated) { jobs = jobs.map(j => j.id === id ? updated : j); render(); }
};

window.deleteJob = async function(id) {
  if (!confirm('Delete this application?')) return;
  await api('DELETE', `/api/jobs/${id}`);
  jobs = jobs.filter(j => j.id !== id);
  render();
};

window.openEdit = function(id) {
  const j = jobs.find(j => j.id === id);
  if (!j) return;
  closeAllModals();
  editingId = id;
  document.getElementById('modal-title').textContent = 'Edit job';
  fillForm(j);
  document.getElementById('job-modal').hidden = false;
};

function fillForm(j) {
  const f = document.getElementById('job-form');
  ['company','title','location','location_type','fit','stage','outcome','notes','applied_date','job_url'].forEach(k => {
    const el = f.elements[k];
    if (el) el.value = j[k] || '';
  });
  f.elements.has_referral.checked = !!j.has_referral;
  f.elements.recruiter_contact.checked = !!j.recruiter_contact;
  renderFileCurrent('resume-current', j.id, 'resume', j.resume_file);
  renderFileCurrent('cover-letter-current', j.id, 'cover-letter', j.cover_letter_file);
}

function renderFileCurrent(elId, jobId, type, filename) {
  const el = document.getElementById(elId);
  el.innerHTML = filename
    ? `Currently: <a href="/api/jobs/${jobId}/files/${type}" download>${esc(filename)}</a> &middot; <button type="button" class="expand-btn" onclick="removeJobFile(${jobId},'${type}','${elId}')">remove</button>`
    : '';
}

window.removeJobFile = async function(jobId, type, elId) {
  const label = type === 'resume' ? 'resume' : 'cover letter';
  if (!confirm(`Remove the attached ${label}?`)) return;
  await api('DELETE', `/api/jobs/${jobId}/files/${type}`);
  const field = type === 'resume' ? 'resume_file' : 'cover_letter_file';
  jobs = jobs.map(j => j.id === jobId ? { ...j, [field]: '' } : j);
  if (elId) renderFileCurrent(elId, jobId, type, '');
  render();
};

async function uploadJobFile(jobId, type, file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`/api/jobs/${jobId}/files/${type}`, { method: 'POST', body: formData });
  if (res.status === 401) { window.location.href = '/login.html'; return null; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// ---- Modal logic ----
function closeAllModals() {
  document.getElementById('job-modal').hidden = true;
  document.getElementById('profile-modal').hidden = true;
}

function openAddModal() {
  closeAllModals();
  editingId = null;
  document.getElementById('modal-title').textContent = 'Add job';
  document.getElementById('job-form').reset();
  document.getElementById('job-form-error').hidden = true;
  renderFileCurrent('resume-current', null, 'resume', '');
  renderFileCurrent('cover-letter-current', null, 'cover-letter', '');
  document.getElementById('job-modal').hidden = false;
}

function closeModal() { document.getElementById('job-modal').hidden = true; }

document.getElementById('btn-add-job').onclick = openAddModal;
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-cancel').onclick = closeModal;
document.getElementById('job-modal').onclick = e => { if (e.target === e.currentTarget) closeModal(); };

document.getElementById('job-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const errEl = document.getElementById('job-form-error');
  errEl.hidden = true;
  const fit = f.elements.fit.value;
  const fitLabels = { strong: 'Strong', good: 'Good', stretch: 'Stretch' };
  const payload = {
    company: f.elements.company.value,
    title: f.elements.title.value,
    location: f.elements.location.value,
    location_type: f.elements.location_type.value,
    fit,
    fit_label: fitLabels[fit],
    stage: f.elements.stage.value,
    outcome: f.elements.outcome.value,
    applied_date: f.elements.applied_date.value,
    job_url: f.elements.job_url.value,
    has_referral: f.elements.has_referral.checked,
    recruiter_contact: f.elements.recruiter_contact.checked,
    notes: f.elements.notes.value
  };

  let result;
  if (editingId) {
    result = await api('PATCH', `/api/jobs/${editingId}`, payload);
    if (result?.error) { errEl.textContent = result.error; errEl.hidden = false; return; }
    if (result) jobs = jobs.map(j => j.id === editingId ? result : j);
  } else {
    result = await api('POST', '/api/jobs', payload);
    if (result?.error) { errEl.textContent = result.error; errEl.hidden = false; return; }
    if (result) jobs.push(result);
  }
  if (!result) return;

  const jobId = result.id;
  const resumeFile = f.elements.resume_upload.files[0];
  const coverLetterFile = f.elements.cover_letter_upload.files[0];
  try {
    if (resumeFile) await uploadJobFile(jobId, 'resume', resumeFile);
    if (coverLetterFile) await uploadJobFile(jobId, 'cover-letter', coverLetterFile);
  } catch (uploadErr) {
    errEl.textContent = uploadErr.message;
    errEl.hidden = false;
    await loadJobs();
    return;
  }

  closeModal();
  await loadJobs();
};

// ---- Admin section (inside the Profile modal) ----
async function refreshUserList() {
  const users = await api('GET', '/api/auth/users') || [];
  document.getElementById('user-list').innerHTML = `
    <table class="user-table">
      <thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td>${esc(u.username)}</td>
          <td>${esc(u.role)}</td>
          <td>${u.created_at?.slice(0,10)}</td>
          <td>${u.id !== currentUser.id ? `<button class="btn-danger-sm" onclick="deleteUser(${u.id})">Remove</button>` : '<span style="color:#aaa">you</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

window.deleteUser = async function(id) {
  if (!confirm('Remove this user?')) return;
  await api('DELETE', `/api/auth/users/${id}`);
  await refreshUserList();
};

document.getElementById('create-user-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('user-error');
  err.hidden = true;
  const res = await api('POST', '/api/auth/users', {
    username: f.elements.username.value,
    password: f.elements.password.value,
    role: f.elements.role.value
  });
  if (res?.error) { err.textContent = res.error; err.hidden = false; }
  else { f.reset(); await refreshUserList(); }
};

// ---- Profile modal ----
document.getElementById('btn-profile').onclick = openProfileModal;
document.getElementById('profile-close').onclick = () => { document.getElementById('profile-modal').hidden = true; };
document.getElementById('profile-modal').onclick = e => { if (e.target === e.currentTarget) document.getElementById('profile-modal').hidden = true; };

async function openProfileModal() {
  closeAllModals();
  document.getElementById('profile-modal').hidden = false;
  document.getElementById('dark-mode-toggle').checked = document.documentElement.getAttribute('data-theme') === 'dark';
  document.getElementById('api-token-display').hidden = true;

  const me = await api('GET', '/api/auth/me');
  if (!me) return;
  document.getElementById('profile-info').innerHTML = `
    <div><strong style="color:var(--text);">${esc(me.username)}</strong></div>
    <div>Role: ${esc(me.role)}</div>
    <div>Member since: ${esc((me.created_at || '').slice(0, 10))}</div>`;

  renderApiTokenStatus(me);

  const adminSection = document.getElementById('admin-section');
  if (me.role === 'admin') {
    adminSection.hidden = false;
    await refreshUserList();
  } else {
    adminSection.hidden = true;
  }
}

function renderApiTokenStatus(me) {
  const status = document.getElementById('api-token-status');
  const revokeBtn = document.getElementById('btn-revoke-token');
  if (me.has_api_token) {
    status.textContent = `Enabled — generated ${(me.api_token_created_at || '').slice(0, 10)}`;
    revokeBtn.hidden = false;
  } else {
    status.textContent = 'No token generated yet.';
    revokeBtn.hidden = true;
  }
}

document.getElementById('btn-generate-token').onclick = async () => {
  if (document.getElementById('btn-revoke-token').hidden === false &&
      !confirm('Generating a new token invalidates the current one. Continue?')) return;
  const res = await api('POST', '/api/auth/api-token');
  if (res?.error) return;
  const display = document.getElementById('api-token-display');
  display.hidden = false;
  display.innerHTML = `<strong style="color:var(--text);">${esc(res.token)}</strong><br>Copy this now — it won't be shown again.`;
  const me = await api('GET', '/api/auth/me');
  if (me) renderApiTokenStatus(me);
};

document.getElementById('btn-revoke-token').onclick = async () => {
  if (!confirm('Revoke the API token? Anything using it (e.g. the job-tracker skill) will stop working until a new one is generated.')) return;
  await api('DELETE', '/api/auth/api-token');
  document.getElementById('api-token-display').hidden = true;
  const me = await api('GET', '/api/auth/me');
  if (me) renderApiTokenStatus(me);
};

document.getElementById('dark-mode-toggle').onchange = e => {
  if (e.target.checked) {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  }
};

document.getElementById('profile-pw-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('profile-pw-error');
  const ok = document.getElementById('profile-pw-ok');
  err.hidden = true; ok.hidden = true;
  const res = await api('POST', '/api/auth/change-password', {
    current: f.elements.current.value,
    next: f.elements.next.value
  });
  if (res?.error) { err.textContent = res.error; err.hidden = false; }
  else { f.reset(); ok.hidden = false; }
};

// ---- Insights / Kanban ----
document.getElementById('btn-insights').onclick = () => {
  window.location.href = 'insights.html?' + filterStateToParams(filterState).toString();
};
document.getElementById('btn-kanban').onclick = () => {
  window.location.href = 'kanban.html?' + filterStateToParams(filterState).toString();
};

// ---- Logout ----
document.getElementById('btn-logout').onclick = async () => {
  await api('POST', '/api/auth/logout');
  sessionStorage.removeItem('user');
  window.location.href = '/login.html';
};

// ---- Boot ----
(async () => {
  currentUser = await getUser();
  if (!currentUser) return;
  document.getElementById('nav-user').textContent = currentUser.username || '';
  initFilterBar(filterState, render);
  await loadJobs();
})();
