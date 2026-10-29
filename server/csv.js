// CSV import for contact lists. Needs a phone column; everything else becomes a template variable.
const NAME_COLS = ['name', 'full_name', 'customer_name', 'contact_name', 'client_name', 'first_name'];
const PHONE_COLS = ['phone', 'phone_number', 'mobile', 'mobile_number', 'number', 'contact', 'contact_number',
  'phone_no', 'mobile_no', 'whatsapp', 'cell'];

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function normalizePhone(raw) {
  const cc = process.env.DEFAULT_COUNTRY_CODE || '+91';
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    if (p.length === 10) p = cc + p;
    else if (p.length === 11 && p.startsWith('0')) p = cc + p.slice(1);
    else p = '+' + p;
  }
  return /^\+\d{8,15}$/.test(p) ? p : '';
}

function importRows(rows, { state, id, now }) {
  if (rows.length < 2) throw Object.assign(new Error('The file has no data rows'), { status: 400 });
  const header = rows[0].map(slug);
  const phoneIdx = header.findIndex((h) => PHONE_COLS.includes(h));
  if (phoneIdx < 0) throw Object.assign(new Error('No phone column found. Name one of your columns "phone".'), { status: 400 });
  const nameIdx = header.findIndex((h) => NAME_COLS.includes(h));

  const result = { created: 0, updated: 0, skipped: 0, columns: header.filter((_, i) => i !== phoneIdx && i !== nameIdx) };
  for (const cells of rows.slice(1)) {
    const phone = normalizePhone(cells[phoneIdx]);
    if (!phone) { result.skipped++; continue; }
    const fields = {};
    header.forEach((h, i) => {
      if (i !== phoneIdx && i !== nameIdx && h && cells[i] != null && cells[i].trim()) fields[h] = cells[i].trim();
    });
    const name = nameIdx >= 0 ? (cells[nameIdx] || '').trim() : '';
    const existing = state.contacts.find((c) => c.phone === phone);
    if (existing) {
      if (name) existing.name = name;
      existing.fields = { ...existing.fields, ...fields };
      result.updated++;
    } else {
      state.contacts.push({ id: id(), name: name || phone, phone, fields, createdAt: now(), callCount: 0, lastCall: null });
      result.created++;
    }
  }
  return result;
}

module.exports = { parseCsv, importRows, normalizePhone };
