/* Voice Desk dashboard. Talks only to this app's own /api; no API keys ever reach the browser. */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');

const S = { config: null, timer: null, audio: null, previewCache: new Map(), testCall: null };

// ---------- Helpers ----------

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch('/api' + path, opts);
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please sign in'); }
  if (raw && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}
const fail = (err) => toast(err.message || String(err), 'error');

function openModal(html, cls = '') {
  $('#modal-card').className = `modal-card ${cls}`;
  $('#modal-card').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${btn.dataset.busy || 'Working…'}`;
  try { return await fn(); } catch (err) { fail(err); } finally { btn.disabled = false; btn.innerHTML = label; }
}

function playUrl(url) {
  if (S.audio) S.audio.pause();
  S.audio = new Audio(url);
  return new Promise((resolve) => {
    S.audio.onended = resolve;
    S.audio.onerror = resolve;
    S.audio.play().catch(resolve);
  });
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : '—');
const langName = (code) => S.config.catalog.languages.find((l) => l.code === code)?.name || code;
const pretty = (s) => String(s || '').replace(/_/g, ' ');

function statusBadge(status) {
  const map = { completed: 'green', 'in-progress': 'indigo', ringing: 'indigo', dialing: 'indigo', queued: 'amber', failed: 'red', busy: 'amber', 'no-answer': 'amber', canceled: '' };
  return `<span class="badge ${map[status] ?? ''}">${esc(pretty(status))}</span>`;
}
function outcomeBadge(outcome) {
  if (!outcome) return '<span class="muted">—</span>';
  const map = { interested: 'green', converted: 'green', callback_requested: 'indigo', not_interested: 'red', wrong_number: 'red', no_response: 'amber', incomplete: 'amber' };
  return `<span class="badge ${map[outcome] || ''}">${esc(pretty(outcome))}</span>`;
}

// ---------- Auth & boot ----------

function showLogin() {
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    $('#login').classList.add('hidden');
    boot();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }); location.reload(); });

async function boot() {
  const session = await api('/session');
  if (!session.authed) return showLogin();
  $('#logout').classList.toggle('hidden', !session.authRequired);
  S.config = await api('/config');
  const t = S.config.telephony;
  $('#status-pills').innerHTML = `
    <div class="pill-status"><span class="dot ${S.config.sarvamReady ? 'ok' : 'warn'}"></span>Sarvam AI ${S.config.sarvamReady ? 'connected' : 'not configured'}</div>
    <div class="pill-status"><span class="dot ${t.ready ? 'ok' : 'warn'}"></span>${t.ready ? `Phone line ${esc(t.from)}` : 'Phone line not set up'}</div>`;
  $('#shell').classList.remove('hidden');
  route();
}

window.addEventListener('hashchange', route);

function route() {
  clearInterval(S.timer);
  if (S.audio) S.audio.pause();
  if (S.testCall?.id) {
    // Leaving the page hangs up the browser test call so it still gets summarised.
    api(`/calls/${S.testCall.id}/end`, { method: 'POST' }).catch(() => {});
    S.testCall.id = null;
  }
  if (S.testCall?.recorder?.state === 'recording') S.testCall.recorder.stop();
  const [page = 'dashboard', param] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  const pages = { dashboard: renderDashboard, contacts: renderContacts, agents: param ? () => renderAgentEditor(param) : renderAgents, calls: renderCalls, test: renderTest };
  (pages[page] || renderDashboard)().catch(fail);
}

const query = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ---------- Dashboard ----------

async function renderDashboard() {
  const s = await api('/stats');
  const totalOutcomes = Object.values(s.outcomes).reduce((a, b) => a + b, 0) || 1;
  const setup = [];
  if (!S.config.sarvamReady) setup.push('Add <b>SARVAM_API_KEY</b> to the server <code>.env</code> file (on Render: the Environment tab), then restart.');
  if (!S.config.telephony.ready) setup.push(`Real phone calls need Twilio settings on the server (missing: ${S.config.telephony.missing.join(', ')}). Browser test calls work already.`);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="muted">Your calling activity at a glance</p></div>
      <div class="row"><button class="btn" id="check-sarvam" data-busy="Checking…">⚡ Test Sarvam connection</button><a class="btn" href="#/contacts">Upload contacts</a><a class="btn primary" href="#/agents/new">+ New agent</a></div>
    </div>
    <div id="check-result"></div>
    ${setup.map((m) => `<div class="banner warn">⚠ <span>${m}</span></div>`).join('')}
    <div class="grid cols-4">
      ${[['Contacts', s.contacts], ['Agents', s.agents], ['Calls today', s.today], ['Live now', s.live]].map(([l, v]) => `
        <div class="card stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('')}
    </div>
    <div class="grid side" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h2>Recent calls</h2><a href="#/calls">View all →</a></div>
        ${callTable(s.recent, true)}
      </div>
      <div class="card">
        <h2>Outcomes</h2>
        <p class="muted small" style="margin-top:-6px">${s.conversations} conversations · ${fmtDur(s.talkSeconds)} total talk time</p>
        <div class="bars">
          ${Object.keys(s.outcomes).length ? Object.entries(s.outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
            <div class="bar-row"><span>${esc(pretty(k))}</span><div class="bar"><div style="width:${(v / totalOutcomes) * 100}%"></div></div><b>${v}</b></div>`).join('')
          : '<p class="muted">Outcomes appear here after your first calls.</p>'}
        </div>
      </div>
    </div>`;
  bindCallRows();
  $('#check-sarvam').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const r = await api('/check-sarvam');
    const line = (name, x) => (x ? `<div>${x.ok ? '✅' : '❌'} <b>${name}</b> ${x.ok ? `working (${x.ms} ms)` : esc(x.error)}</div>` : '');
    $('#check-result').innerHTML = `<div class="banner ${r.ok ? '' : 'warn'}" style="${r.ok ? 'background:var(--green-soft);color:var(--green);border:1px solid #cdebd9' : ''};flex-direction:column;align-items:flex-start">
      ${r.error ? `❌ ${esc(r.error)}` : line('Voice (Bulbul)', r.voice) + line('Language model', r.llm)}</div>`;
  }));
  if (s.live) S.timer = setInterval(() => location.hash.startsWith('#/dashboard') || !location.hash ? renderDashboard().catch(() => {}) : null, 5000);
}

function callTable(calls, compact = false) {
  if (!calls.length) return '<div class="empty">No calls yet. Create an agent, then start a call from Contacts or try a test call.</div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Contact</th>${compact ? '' : '<th>Agent</th><th>Type</th>'}<th>Status</th>${compact ? '' : '<th>Duration</th>'}<th>Outcome</th>${compact ? '' : '<th>Summary</th>'}</tr></thead>
    <tbody>${calls.map((c) => `
      <tr class="clickable" data-call="${c.id}">
        <td class="muted">${fmtDate(c.createdAt)}</td>
        <td><b>${esc(c.contactName)}</b><div class="muted small">${esc(c.contactPhone)}</div></td>
        ${compact ? '' : `<td>${esc(c.agentName)}</td><td><span class="badge ${c.mode === 'phone' ? 'orange' : ''}">${c.mode === 'phone' ? 'Phone' : 'Browser'}</span></td>`}
        <td>${statusBadge(c.status)}</td>
        ${compact ? '' : `<td>${fmtDur(c.duration)}</td>`}
        <td>${c.summarizing ? '<span class="muted small"><span class="spinner"></span> summarising</span>' : outcomeBadge(c.summary?.outcome)}</td>
        ${compact ? '' : `<td><div class="clamp muted small">${esc(c.summary?.summary || c.error || '')}</div></td>`}
      </tr>`).join('')}</tbody></table></div>`;
}

function bindCallRows(root = view) {
  $$('[data-call]', root).forEach((row) => row.addEventListener('click', () => showCall(row.dataset.call)));
}

// ---------- Call detail ----------

async function showCall(id) {
  const c = await api(`/calls/${id}`).catch(fail);
  if (!c) return;
  const s = c.summary;
  const live = ['queued', 'dialing', 'ringing', 'in-progress'].includes(c.status);
  openModal(`
    <div class="card-head">
      <div><h2 style="margin:0">${esc(c.contactName)} <span class="muted" style="font-weight:400">${esc(c.contactPhone)}</span></h2>
      <div class="muted small">${fmtDate(c.createdAt)} · ${esc(c.agentName)} · ${c.mode === 'phone' ? 'Phone call' : 'Browser test'} · ${fmtDur(c.duration)}</div></div>
      <div class="row">${statusBadge(c.status)}<button class="btn ghost" data-close>✕</button></div>
    </div>
    ${c.error ? `<div class="banner warn">⚠ ${esc(c.error)}</div>` : ''}
    <div class="grid cols-2">
      <div>
        <h3>Summary</h3>
        <div class="summary-box">
          ${c.summarizing ? '<span class="spinner"></span> Generating summary…' : s ? `
            <div class="row" style="margin-bottom:8px">${outcomeBadge(s.outcome)} <span class="badge">${esc(s.sentiment)}</span></div>
            <p style="margin:0 0 10px">${esc(s.summary)}</p>
            ${s.key_points?.length ? `<b class="small">Key points</b><ul>${s.key_points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
            <dl class="kv" style="margin-top:12px">
              ${s.next_action ? `<dt>Next action</dt><dd>${esc(s.next_action)}</dd>` : ''}
              ${s.callback_time ? `<dt>Call back</dt><dd>${esc(s.callback_time)}</dd>` : ''}
              ${Object.entries(s.collected_data || {}).map(([k, v]) => `<dt>${esc(pretty(k))}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}
            </dl>` : '<span class="muted">The summary is written when the call ends.</span>'}
        </div>
        ${c.hasRecording ? `<h3 style="margin-top:16px">Recording</h3><audio controls preload="none" style="width:100%" src="/api/calls/${c.id}/recording"></audio>` : ''}
        <div class="row" style="margin-top:16px">
          ${live ? '<button class="btn danger" id="hangup">Hang up</button>' : ''}
          ${c.endedAt ? '<button class="btn" id="resum" data-busy="Summarising…">↻ Re-summarise</button>' : ''}
          ${c.contactId ? `<a class="btn" href="#/contacts" id="open-contact">Contact history</a>` : ''}
        </div>
      </div>
      <div>
        <h3>Transcript</h3>
        <div class="transcript">${transcriptHtml(c.transcript)}</div>
      </div>
    </div>`);
  $('#hangup')?.addEventListener('click', async () => { await api(`/calls/${id}/hangup`, { method: 'POST' }).catch(fail); toast('Hanging up…'); closeModal(); route(); });
  $('#resum')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await api(`/calls/${id}/resummarize`, { method: 'POST' }); showCall(id); }));
  $('#open-contact')?.addEventListener('click', (e) => { e.preventDefault(); showContact(c.contactId); });
}

function transcriptHtml(turns) {
  if (!turns?.length) return '<div class="bubble system">No conversation recorded.</div>';
  return turns.map((t) => `<div class="bubble ${t.role}"><div class="who">${t.role === 'agent' ? 'Agent' : 'Contact'}</div>${esc(t.text)}</div>`).join('');
}

// ---------- Contacts ----------

async function renderContacts() {
  const [contacts, agents] = await Promise.all([api('/contacts'), api('/agents')]);
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Contacts</h1><p class="muted">Upload the people to call. Every column becomes a variable you can use in scripts.</p></div>
      <button class="btn" id="add-contact">+ Add one</button>
    </div>
    <div class="card">
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".csv,text/csv" hidden>
        <div style="font-size:24px">⇪</div>
        <b>Drop a CSV file here or click to browse</b>
        <div class="muted small">Needs a <code>phone</code> column. <code>name</code> and any other columns (city, product, due_amount…) are optional.
        <a href="/sample-contacts.csv" download onclick="event.stopPropagation()">Download sample</a></div>
      </label>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>${contacts.length} contact${contacts.length === 1 ? '' : 's'}</h2>
        <div class="row">
          <input type="text" id="search" placeholder="Search name, phone, outcome…" style="width:220px">
          <select id="call-agent" style="width:200px">${agents.length ? agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('') : '<option value="">Create an agent first</option>'}</select>
          <button class="btn primary" id="call-selected" disabled data-busy="Queuing…">☏ Call selected</button>
          <button class="btn danger" id="delete-selected" disabled>Delete</button>
        </div>
      </div>
      ${contacts.length ? `<div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="all"></th><th>Name</th><th>Phone</th><th>Data</th><th>Calls</th><th>Last call (memory)</th><th></th></tr></thead>
        <tbody>${contacts.map((c) => `
          <tr data-row="${c.id}" data-search="${esc([c.name, c.phone, c.lastCall?.outcome, ...Object.values(c.fields || {})].join(' ').toLowerCase())}">
            <td><input type="checkbox" class="pick" value="${c.id}"></td>
            <td><a href="#" data-contact="${c.id}"><b>${esc(c.name)}</b></a></td>
            <td class="muted">${esc(c.phone)}</td>
            <td>${Object.entries(c.fields || {}).slice(0, 4).map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join('')}</td>
            <td>${c.callCount || 0}</td>
            <td>${c.lastCall ? `<div class="row" style="gap:6px">${outcomeBadge(c.lastCall.outcome)}<span class="muted small">${fmtDate(c.lastCall.at)}</span></div><div class="clamp muted small">${esc(c.lastCall.summary)}</div>` : '<span class="muted small">Never called</span>'}</td>
            <td><a class="btn small" href="#/test?contact=${c.id}">Test</a></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No contacts yet. Upload a CSV above.</div>'}
    </div>`;

  const drop = $('#drop');
  const doUpload = async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api('/contacts/upload', { method: 'POST', body: fd });
      toast(`Imported: ${r.created} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped (bad phone)` : ''}`);
      renderContacts();
    } catch (err) { fail(err); }
  };
  $('#file').addEventListener('change', (e) => doUpload(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); doUpload(e.dataTransfer.files[0]); });

  const picked = () => $$('.pick:checked').map((i) => i.value);
  const sync = () => { const n = picked().length; $('#call-selected').disabled = !n || !agents.length; $('#delete-selected').disabled = !n; $('#call-selected').innerHTML = `☏ Call selected${n ? ` (${n})` : ''}`; };
  $$('.pick').forEach((i) => i.addEventListener('change', sync));
  $('#all')?.addEventListener('change', (e) => { $$('tr[data-row]').forEach((r) => { if (!r.hidden) $('.pick', r).checked = e.target.checked; }); sync(); });
  $('#search').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('tr[data-row]').forEach((r) => { r.hidden = !r.dataset.search.includes(q); }); });
  $$('[data-contact]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showContact(a.dataset.contact); }));
  $('#add-contact').addEventListener('click', addContactModal);

  $('#call-selected').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const ids = picked();
    if (!confirm(`Place real phone calls to ${ids.length} contact(s)?`)) return;
    const r = await api('/calls/phone', { method: 'POST', body: { agentId: $('#call-agent').value, contactIds: ids } });
    toast(`${r.queued} call(s) queued. Up to ${S.config.maxConcurrent} run at once.`);
    location.hash = '#/calls';
  }));
  $('#delete-selected').addEventListener('click', async () => {
    const ids = picked();
    if (!confirm(`Delete ${ids.length} contact(s)? Their call logs are kept.`)) return;
    await api('/contacts/delete', { method: 'POST', body: { ids } }).catch(fail);
    renderContacts();
  });
}

function addContactModal() {
  openModal(`
    <div class="card-head"><h2>Add contact</h2><button class="btn ghost" data-close>✕</button></div>
    <form id="contact-form">
      <label class="field">Name<input type="text" name="name"></label>
      <label class="field">Phone<input type="tel" name="phone" placeholder="98765 43210" required></label>
      <label class="field">Extra data <span class="hint">One per line, like <code>city: Pune</code></span><textarea name="fields" placeholder="city: Pune&#10;product: Home loan"></textarea></label>
      <button class="btn primary" type="submit">Save contact</button>
    </form>`, 'narrow');
  $('#contact-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fields = {};
    f.fields.value.split('\n').forEach((line) => {
      const [k, ...v] = line.split(':');
      if (k.trim() && v.length) fields[k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')] = v.join(':').trim();
    });
    try {
      await api('/contacts', { method: 'POST', body: { name: f.name.value, phone: f.phone.value, fields } });
      closeModal();
      toast('Contact added');
      renderContacts();
    } catch (err) { fail(err); }
  });
}

async function showContact(id) {
  const c = await api(`/contacts/${id}`).catch(fail);
  if (!c) return;
  openModal(`
    <div class="card-head">
      <div><h2 style="margin:0">${esc(c.name)}</h2><div class="muted">${esc(c.phone)}</div></div>
      <div class="row"><a class="btn small" href="#/test?contact=${c.id}" data-close>Test call</a><button class="btn ghost" data-close>✕</button></div>
    </div>
    <div class="row" style="margin-bottom:14px">${Object.entries(c.fields || {}).map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join('') || '<span class="muted small">No extra data</span>'}</div>
    <h3>What the agent remembers</h3>
    <div class="summary-box" style="margin-bottom:16px">
      ${c.lastCall ? `<div class="row" style="margin-bottom:6px">${outcomeBadge(c.lastCall.outcome)}<span class="muted small">Last call ${fmtDate(c.lastCall.at)}</span></div>
        <p style="margin:0">${esc(c.lastCall.summary)}</p>${c.lastCall.nextAction ? `<p class="small" style="margin:8px 0 0"><b>Next:</b> ${esc(c.lastCall.nextAction)}</p>` : ''}`
      : '<span class="muted">Nothing yet. The next call will be the first one.</span>'}
    </div>
    <h3>Call history (${c.calls.length})</h3>
    ${callTable(c.calls)}`);
  bindCallRows($('#modal-card'));
}

// ---------- Agents list ----------

async function renderAgents() {
  const agents = await api('/agents');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Agents</h1><p class="muted">Each agent has its own language, voice, script and AI settings.</p></div>
      <a class="btn primary" href="#/agents/new">+ New agent</a>
    </div>
    ${agents.length ? `<div class="grid cols-2">${agents.map((a) => `
      <div class="card agent-card">
        <div class="card-head" style="margin:0"><h2>${esc(a.name)}</h2><span class="badge indigo">${esc(langName(a.language))}</span></div>
        <div class="meta"><span class="chip">🔊 ${esc(a.ttsModel)} · ${esc(a.speaker)}</span><span class="chip">🧠 ${esc(a.llmModel)}</span>${a.memoryOpening ? '<span class="chip">Remembers past calls</span>' : ''}</div>
        <p class="muted clamp" style="margin:0">${esc(a.purpose || a.openingLine || 'No script yet')}</p>
        <div class="row"><a class="btn" href="#/agents/${a.id}">Edit</a><a class="btn" href="#/test?agent=${a.id}">◎ Test call</a><button class="btn danger" data-del="${a.id}">Delete</button></div>
      </div>`).join('')}</div>`
    : '<div class="card empty">No agents yet. <a href="#/agents/new">Create your first agent →</a></div>'}`;
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this agent?')) return;
    await api(`/agents/${b.dataset.del}`, { method: 'DELETE' }).catch(fail);
    renderAgents();
  }));
}

// ---------- Agent editor ----------

async function renderAgentEditor(id) {
  const isNew = id === 'new';
  const [agent, columns] = await Promise.all([
    isNew ? Promise.resolve(null) : api(`/agents/${id}`),
    api('/contacts/columns'),
  ]);
  const cat = S.config.catalog;
  const d = agent ? { ...agent } : {
    name: '', agentName: 'Priya', language: 'hi-IN', ttsModel: 'bulbul:v3', speaker: 'priya', pace: 1,
    llmModel: 'sarvam-105b-conversations', temperature: 0.4, reasoning: 'low', maxTurns: 20, sttAutoDetect: false, memoryOpening: true,
    purpose: '', company: '', tone: 'friendly', details: '', systemPrompt: '', openingLine: '', silencePrompt: '', goodbyeLine: '',
  };
  const variables = [...new Set([...columns, 'last_call_summary', 'last_call_date', 'last_call_outcome'])];

  view.innerHTML = `
    <div class="page-head">
      <div><a href="#/agents" class="muted small">← Agents</a><h1>${isNew ? 'New agent' : esc(d.name)}</h1></div>
      <div class="row">${isNew ? '' : `<a class="btn" href="#/test?agent=${id}">◎ Test call</a>`}<button class="btn primary" id="save" data-busy="Saving…">Save agent</button></div>
    </div>
    <div class="grid side">
      <div>
        <div class="card">
          <h2><span class="step">1</span>Basics & language</h2>
          <div class="grid cols-2" style="gap:12px">
            <label class="field">Agent name (internal)<input type="text" data-f="name" value="${esc(d.name)}" placeholder="Loan follow-up – Hindi"></label>
            <label class="field">Name the agent introduces itself with<input type="text" data-f="agentName" value="${esc(d.agentName)}"></label>
          </div>
          <label class="field">Language the agent speaks
            <select data-f="language">${cat.languages.map((l) => `<option value="${l.code}" ${l.code === d.language ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
          </label>
          <label class="check"><input type="checkbox" data-f="sttAutoDetect" ${d.sttAutoDetect ? 'checked' : ''}><span>Auto-detect the caller's language<br><span class="muted small">Useful when callers mix languages. Otherwise speech is transcribed in the agent's language.</span></span></label>
        </div>

        <div class="card">
          <h2><span class="step">2</span>Script</h2>
          <div class="gen-box">
            <h3>✨ Generate with Sarvam AI</h3>
            <label class="field">What is the call for?<textarea data-f="purpose" placeholder="Remind customers about their EMI due on {{due_date}} and ask when they will pay. If they already paid, thank them.">${esc(d.purpose)}</textarea></label>
            <div class="grid cols-2" style="gap:12px">
              <label class="field">Company / brand<input type="text" data-f="company" value="${esc(d.company)}"></label>
              <label class="field">Tone<select data-f="tone">${['friendly', 'professional', 'warm and empathetic', 'energetic sales', 'formal'].map((t) => `<option ${t === d.tone ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            </div>
            <label class="field">Offers, FAQs, rules (optional)<textarea data-f="details" placeholder="Late fee is ₹500 after 5 days. Payment link is sent by SMS. Office hours 10am–6pm.">${esc(d.details)}</textarea></label>
            <button class="btn dark" id="generate" data-busy="Writing script…">✨ Generate script</button>
            <span class="muted small" style="margin-left:8px">Replaces the fields below.</span>
          </div>
          <div class="vars small muted" style="margin-bottom:10px">Variables (click to copy): ${variables.map((v) => `<code data-var="${esc(v)}">{{${esc(v)}}}</code>`).join('')}</div>
          <label class="field">Opening line <span class="hint">The first thing the agent says when the call connects.</span>
            <div class="row"><textarea data-f="openingLine" class="grow" style="min-height:60px">${esc(d.openingLine)}</textarea><button class="btn small" data-speak="openingLine">▶</button></div>
          </label>
          <label class="field">Agent instructions <span class="hint">How the agent should run the conversation, collect information and handle objections.</span>
            <textarea data-f="systemPrompt" class="tall">${esc(d.systemPrompt)}</textarea>
          </label>
          <div class="grid cols-2" style="gap:12px">
            <label class="field">If the caller is silent<div class="row"><input type="text" data-f="silencePrompt" class="grow" value="${esc(d.silencePrompt)}"><button class="btn small" data-speak="silencePrompt">▶</button></div></label>
            <label class="field">Goodbye line<div class="row"><input type="text" data-f="goodbyeLine" class="grow" value="${esc(d.goodbyeLine)}"><button class="btn small" data-speak="goodbyeLine">▶</button></div></label>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h2><span class="step">3</span>Voice</h2>
          <div class="seg" id="tts-models" style="margin-bottom:8px">${cat.ttsModels.map((m) => `<button data-model="${m.id}">${esc(m.label)}</button>`).join('')}</div>
          <p class="muted small" id="model-note"></p>
          <div id="speakers"></div>
          <label class="field" style="margin-top:14px">Speaking pace <span class="hint" id="pace-val"></span><input type="range" data-f="pace" step="0.05" value="${d.pace}"></label>
          <label class="field">Try the voice<textarea id="try-text" style="min-height:60px"></textarea></label>
          <button class="btn" id="try" data-busy="Generating…">▶ Play</button>
        </div>

        <div class="card">
          <h2><span class="step">4</span>Brain & memory</h2>
          <label class="field">Language model<select data-f="llmModel">${cat.llmModels.map((m) => `<option value="${m.id}" ${m.id === d.llmModel ? 'selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('')}</select></label>
          <label class="field">Thinking effort <span class="hint">Lower is faster, which matters on live calls.</span>
            <select data-f="reasoning">${cat.reasoningLevels.map((r) => `<option value="${r.id}" ${r.id === (d.reasoning || '') ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
          <div class="grid cols-2" style="gap:12px">
            <label class="field">Creativity <span class="hint" id="temp-val"></span><input type="range" data-f="temperature" min="0" max="1.2" step="0.05" value="${d.temperature}"></label>
            <label class="field">Max caller turns<input type="number" data-f="maxTurns" min="0" value="${d.maxTurns}"></label>
          </div>
          <label class="check"><input type="checkbox" data-f="memoryOpening" ${d.memoryOpening ? 'checked' : ''}><span>Open follow-up calls by recalling the last conversation<br><span class="muted small">The agent always gets the summaries of previous calls with the contact. With this on, its first sentence also refers back to them.</span></span></label>
        </div>
      </div>
    </div>`;

  const readField = (el) => (el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value);
  $$('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
    d[el.dataset.f] = readField(el);
    if (el.dataset.f === 'language') $('#try-text').value = sample();
    syncLabels();
  }));
  const setField = (key, value) => { d[key] = value; const el = $(`[data-f="${key}"]`); if (el) el.value = value; };

  const sample = () => cat.languages.find((l) => l.code === d.language)?.sample || 'Hello!';
  $('#try-text').value = d.openingLine || sample();

  function syncLabels() {
    $('#pace-val').textContent = `${Number(d.pace).toFixed(2)}×`;
    $('#temp-val').textContent = Number(d.temperature).toFixed(2);
  }

  function renderVoice() {
    const model = cat.ttsModels.find((m) => m.id === d.ttsModel);
    $$('#tts-models button').forEach((b) => b.classList.toggle('on', b.dataset.model === d.ttsModel));
    $('#model-note').textContent = model.note;
    const pace = $('[data-f="pace"]');
    pace.min = model.pace[0]; pace.max = model.pace[1];
    if (model.speakers) {
      if (!model.speakers.includes(d.speaker)) d.speaker = model.speakers[0];
      $('#speakers').innerHTML = `<div class="voices">${model.speakers.map((s) => `
        <div class="voice ${s === d.speaker ? 'selected' : ''}" data-speaker="${s}"><span>${s}</span><button class="play" data-preview="${s}" title="Preview">▶</button></div>`).join('')}</div>`;
    } else {
      if (!d.speaker || !d.speaker.includes('_')) d.speaker = model.defaultSpeaker;
      $('#speakers').innerHTML = `<label class="field">Persona ID<input type="text" id="persona" value="${esc(d.speaker)}" placeholder="${esc(model.defaultSpeaker)}"></label>`;
      $('#persona').addEventListener('input', (e) => { d.speaker = e.target.value.trim(); });
    }
    $$('[data-speaker]').forEach((el) => el.addEventListener('click', () => { d.speaker = el.dataset.speaker; renderVoice(); }));
    $$('[data-preview]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); preview(sample(), b.dataset.preview, b); }));
    syncLabels();
  }
  $$('#tts-models button').forEach((b) => b.addEventListener('click', () => { d.ttsModel = b.dataset.model; renderVoice(); }));
  renderVoice();

  async function preview(text, speaker = d.speaker, btn) {
    const key = [text, d.language, d.ttsModel, speaker, d.pace].join('|');
    const original = btn?.innerHTML;
    if (btn) btn.innerHTML = '<span class="spinner"></span>';
    try {
      let url = S.previewCache.get(key);
      if (!url) {
        const blob = await api('/tts/preview', { method: 'POST', raw: true, body: { text, language: d.language, ttsModel: d.ttsModel, speaker, pace: d.pace } });
        url = URL.createObjectURL(blob);
        S.previewCache.set(key, url);
      }
      if (btn) btn.innerHTML = original;
      await playUrl(url);
    } catch (err) { fail(err); if (btn) btn.innerHTML = original; }
  }

  // Preview script lines with the {{variables}} filled from a sample contact.
  const fillSample = (text) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k === 'name' ? 'Rahul' : ''));
  $('#try').addEventListener('click', (e) => busy(e.currentTarget, () => preview(fillSample($('#try-text').value))));
  $$('[data-speak]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); const t = d[b.dataset.speak]; if (t) preview(fillSample(t), d.speaker, b); }));
  $$('[data-var]').forEach((c) => c.addEventListener('click', () => { navigator.clipboard?.writeText(`{{${c.dataset.var}}}`); toast(`Copied {{${c.dataset.var}}}`); }));

  $('#generate').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const s = await api('/agents/generate-script', { method: 'POST', body: { ...d, columns } });
    for (const [k, v] of Object.entries(s)) if (v) setField(k, v);
    $('#try-text').value = d.openingLine;
    toast('Script generated. Review and edit it, then save.');
  }));

  $('#save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!d.name.trim()) d.name = `${langName(d.language)} agent`;
    if (!d.openingLine.trim() || !d.systemPrompt.trim()) throw new Error('Add an opening line and agent instructions (or generate them) before saving');
    const saved = await api(isNew ? '/agents' : `/agents/${id}`, { method: isNew ? 'POST' : 'PUT', body: d });
    toast('Agent saved');
    if (isNew) location.hash = `#/agents/${saved.id}`;
  }));
}

// ---------- Call logs ----------

async function renderCalls() {
  const calls = await api('/calls');
  const filter = query().get('status') || 'all';
  const shown = filter === 'all' ? calls : calls.filter((c) => (filter === 'live' ? ['queued', 'dialing', 'ringing', 'in-progress'].includes(c.status) : c.summary?.outcome === filter));
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Call logs</h1><p class="muted">Every call with its transcript, recording and AI summary.</p></div>
      <div class="seg">${['all', 'live', 'interested', 'callback_requested', 'not_interested', 'no_response'].map((f) => `<button class="${f === filter ? 'on' : ''}" data-filter="${f}">${esc(pretty(f))}</button>`).join('')}</div>
    </div>
    <div class="card">${callTable(shown)}</div>`;
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/calls?status=${b.dataset.filter}`; }));
  bindCallRows();
  if (calls.some((c) => ['queued', 'dialing', 'ringing', 'in-progress'].includes(c.status) || c.summarizing)) {
    S.timer = setInterval(() => { if ($('#modal').classList.contains('hidden')) renderCalls().catch(() => {}); }, 4000);
  }
}

// ---------- Browser test call ----------

async function renderTest() {
  const [agents, contacts] = await Promise.all([api('/agents'), api('/contacts')]);
  const q = query();
  if (!agents.length) {
    view.innerHTML = '<div class="page-head"><h1>Test call</h1></div><div class="card empty">Create an agent first. <a href="#/agents/new">New agent →</a></div>';
    return;
  }
  view.innerHTML = `
    <div class="page-head"><div><h1>Test call</h1><p class="muted">Talk to your agent through the browser microphone. It uses the same memory and summaries as real calls.</p></div></div>
    <div class="grid side">
      <div class="card">
        <div class="row" style="margin-bottom:6px">
          <label class="field grow" style="margin:0">Agent<select id="t-agent">${agents.map((a) => `<option value="${a.id}" ${a.id === q.get('agent') ? 'selected' : ''}>${esc(a.name)} · ${esc(langName(a.language))}</option>`).join('')}</select></label>
          <label class="field grow" style="margin:0">Pretend to be<select id="t-contact"><option value="">Guest (no memory)</option>${contacts.map((c) => `<option value="${c.id}" ${c.id === q.get('contact') ? 'selected' : ''}>${esc(c.name)} · ${esc(c.phone)}${c.callCount ? ` · ${c.callCount} past call(s)` : ''}</option>`).join('')}</select></label>
        </div>
        <div class="phone-stage">
          <button class="mic" id="mic" disabled title="Tap to talk, tap again to send">🎙</button>
          <p class="muted" id="t-status">Press <b>Start call</b> to begin.</p>
          <div class="row" style="justify-content:center">
            <button class="btn primary" id="t-start" data-busy="Connecting…">☏ Start call</button>
            <button class="btn danger hidden" id="t-end" data-busy="Ending…">End call</button>
          </div>
        </div>
        <form class="row" id="t-type"><input type="text" class="grow" id="t-text" placeholder="…or type what the caller says" disabled><button class="btn" id="t-send" disabled>Send</button></form>
      </div>
      <div class="card">
        <h2>Conversation</h2>
        <div class="transcript" id="t-log"><div class="bubble system">The conversation appears here.</div></div>
        <div id="t-summary"></div>
      </div>
    </div>`;

  const T = (S.testCall = { id: null, recorder: null, busy: false });
  const status = (html) => { $('#t-status').innerHTML = html; };
  const log = (role, text) => {
    const box = $('#t-log');
    if ($('.bubble.system', box)) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', `<div class="bubble ${role}"><div class="who">${role === 'agent' ? 'Agent' : 'You'}</div>${esc(text)}</div>`);
    box.scrollTop = box.scrollHeight;
  };
  const setLive = (live) => {
    $('#mic').disabled = !live; $('#t-text').disabled = !live; $('#t-send').disabled = !live;
    $('#t-start').classList.toggle('hidden', live); $('#t-end').classList.toggle('hidden', !live);
    $('#t-agent').disabled = live; $('#t-contact').disabled = live;
  };

  async function agentSays(text, audio) {
    log('agent', text);
    status('Agent is speaking…');
    await playUrl(audio);
    if (T.id) status('Your turn: tap the mic and speak, then tap again to send.');
  }

  async function sendTurn(body) {
    T.busy = true;
    $('#mic').disabled = true;
    status('<span class="spinner"></span> Agent is thinking…');
    try {
      const r = await api(`/calls/${T.id}/browser-turn`, { method: 'POST', body });
      if (r.userText) log('user', r.userText);
      await agentSays(r.text, r.audio);
      if (r.end) await endCall();
    } catch (err) { fail(err); status('Something went wrong. Try again.'); }
    T.busy = false;
    if (T.id) $('#mic').disabled = false;
  }

  async function endCall() {
    if (!T.id) return;
    const callId = T.id;
    T.id = null;
    setLive(false);
    status('<span class="spinner"></span> Call ended. Writing summary…');
    try {
      const c = await api(`/calls/${callId}/end`, { method: 'POST' });
      const s = c.summary;
      $('#t-summary').innerHTML = `<h3 style="margin-top:16px">Call summary</h3><div class="summary-box">
        <div class="row" style="margin-bottom:6px">${outcomeBadge(s.outcome)}<span class="badge">${esc(s.sentiment)}</span></div>
        <p style="margin:0">${esc(s.summary)}</p>${s.next_action ? `<p class="small" style="margin:8px 0 0"><b>Next:</b> ${esc(s.next_action)}</p>` : ''}</div>`;
      status($('#t-contact').value ? 'Saved. The agent will remember this on the next call with this contact.' : 'Saved to call logs.');
    } catch (err) { fail(err); }
  }

  $('#t-start').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    $('#t-log').innerHTML = '<div class="bubble system">Connecting…</div>';
    $('#t-summary').innerHTML = '';
    const r = await api('/calls/browser', { method: 'POST', body: { agentId: $('#t-agent').value, contactId: $('#t-contact').value || null } });
    T.id = r.call.id;
    setLive(true);
    await agentSays(r.text, r.audio);
  }));
  $('#t-end').addEventListener('click', (e) => busy(e.currentTarget, endCall));

  $('#t-type').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#t-text').value.trim();
    if (!text || T.busy || !T.id) return;
    $('#t-text').value = '';
    log('user', text);
    sendTurn({ text });
  });

  $('#mic').addEventListener('click', async () => {
    if (T.recorder?.state === 'recording') { T.recorder.stop(); return; }
    if (S.audio) S.audio.pause();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return fail(new Error('Microphone access was blocked')); }
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => window.MediaRecorder?.isTypeSupported(m)) || '';
    const rec = (T.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined));
    const chunks = [];
    rec.ondataavailable = (ev) => chunks.push(ev.data);
    rec.onstop = () => {
      clearTimeout(T.limit);
      stream.getTracks().forEach((t) => t.stop());
      $('#mic').classList.remove('recording');
      if (!T.id) return;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const fd = new FormData();
      fd.append('audio', blob, `turn.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`);
      sendTurn(fd);
    };
    rec.start();
    T.limit = setTimeout(() => rec.state === 'recording' && rec.stop(), 28000);
    $('#mic').classList.add('recording');
    status('Listening… tap again when you finish speaking.');
  });
}

boot().catch(fail);
