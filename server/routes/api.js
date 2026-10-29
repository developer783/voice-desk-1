// JSON API used by the dashboard. All Sarvam / Twilio calls happen here, never in the browser.
const express = require('express');
const multer = require('multer');
const { state, save, id, now } = require('../db');
const catalog = require('../catalog');
const sarvam = require('../sarvam');
const telephony = require('../telephony');
const engine = require('../engine');
const { parseCsv, importRows, normalizePhone } = require('../csv');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const byNewest = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');

function need(item, what) {
  if (!item) throw fail(404, `${what} not found`);
  return item;
}

// ---------- Config & stats ----------

router.get('/config', (req, res) => {
  res.json({
    catalog,
    sarvamReady: Boolean(process.env.SARVAM_API_KEY),
    telephony: telephony.status(),
    maxConcurrent: Math.max(1, parseInt(process.env.MAX_CONCURRENT_CALLS, 10) || 2),
  });
});

router.get('/check-sarvam', ah(async (req, res) => res.json(await sarvam.check())));

router.get('/stats', (req, res) => {
  const ended = state.calls.filter((c) => c.endedAt);
  const today = new Date().toISOString().slice(0, 10);
  const outcomes = {};
  for (const c of ended) if (c.summary) outcomes[c.summary.outcome] = (outcomes[c.summary.outcome] || 0) + 1;
  res.json({
    contacts: state.contacts.length,
    agents: state.agents.length,
    calls: state.calls.length,
    live: state.calls.filter((c) => engine.ACTIVE_STATUSES.includes(c.status)).length,
    today: state.calls.filter((c) => (c.createdAt || '').startsWith(today)).length,
    conversations: ended.filter((c) => c.transcript.some((t) => t.role === 'user')).length,
    talkSeconds: ended.reduce((s, c) => s + (c.duration || 0), 0),
    outcomes,
    recent: [...state.calls].sort(byNewest).slice(0, 8).map(engine.publicCall),
  });
});

// ---------- Contacts ----------

router.get('/contacts', (req, res) => res.json([...state.contacts].sort(byNewest)));

router.get('/contacts/columns', (req, res) => {
  const cols = new Set();
  for (const c of state.contacts) Object.keys(c.fields || {}).forEach((k) => cols.add(k));
  res.json(['name', 'phone', ...cols]);
});

router.post('/contacts', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) throw fail(400, 'Enter a valid phone number');
  if (state.contacts.some((c) => c.phone === phone)) throw fail(409, 'A contact with this phone number already exists');
  const fields = {};
  for (const [k, v] of Object.entries(req.body.fields || {})) if (k && v) fields[String(k)] = String(v);
  const contact = { id: id(), name: String(req.body.name || '').trim() || phone, phone, fields, createdAt: now(), callCount: 0, lastCall: null };
  state.contacts.push(contact);
  save();
  res.json(contact);
});

router.post('/contacts/upload', upload.single('file'), (req, res) => {
  if (!req.file) throw fail(400, 'Choose a CSV file to upload');
  const result = importRows(parseCsv(req.file.buffer.toString('utf8')), { state, id, now });
  save();
  res.json(result);
});

router.get('/contacts/:id', (req, res) => {
  const contact = need(engine.findContact(req.params.id), 'Contact');
  const calls = state.calls.filter((c) => c.contactId === contact.id).sort(byNewest).map(engine.publicCall);
  res.json({ ...contact, calls });
});

router.post('/contacts/delete', (req, res) => {
  const ids = new Set(req.body.ids || []);
  state.contacts = state.contacts.filter((c) => !ids.has(c.id));
  save();
  res.json({ ok: true });
});

// ---------- Agents ----------

const AGENT_DEFAULTS = {
  name: 'New agent', agentName: 'Priya', language: 'hi-IN',
  ttsModel: 'bulbul:v3', speaker: 'priya', pace: 1,
  llmModel: 'sarvam-105b-conversations', temperature: 0.4, reasoning: 'low', maxTurns: 20,
  sttAutoDetect: false, memoryOpening: true,
  purpose: '', company: '', tone: 'friendly', details: '',
  systemPrompt: '', openingLine: '', silencePrompt: '', goodbyeLine: '',
};

function cleanAgent(body, base = AGENT_DEFAULTS) {
  const a = { ...base };
  for (const key of Object.keys(AGENT_DEFAULTS)) if (body[key] !== undefined) a[key] = body[key];
  const lang = catalog.languages.find((l) => l.code === a.language);
  const model = catalog.ttsModels.find((m) => m.id === a.ttsModel);
  if (!lang) throw fail(400, 'Unknown language');
  if (!model) throw fail(400, 'Unknown voice model');
  if (!catalog.llmModels.some((m) => m.id === a.llmModel)) throw fail(400, 'Unknown LLM model');
  if (model.speakers && !model.speakers.includes(a.speaker)) a.speaker = model.speakers[0];
  if (!model.speakers && !a.speaker) a.speaker = model.defaultSpeaker;
  a.pace = Math.min(model.pace[1], Math.max(model.pace[0], Number(a.pace) || 1));
  a.temperature = Math.min(2, Math.max(0, Number(a.temperature) || 0));
  a.maxTurns = Math.max(0, parseInt(a.maxTurns, 10) || 0);
  a.sttAutoDetect = Boolean(a.sttAutoDetect);
  a.memoryOpening = Boolean(a.memoryOpening);
  return a;
}

router.get('/agents', (req, res) => res.json([...state.agents].sort(byNewest)));
router.get('/agents/:id', (req, res) => res.json(need(engine.findAgent(req.params.id), 'Agent')));

router.post('/agents', (req, res) => {
  const agent = { id: id(), createdAt: now(), ...cleanAgent(req.body) };
  state.agents.push(agent);
  save();
  res.json(agent);
});

router.put('/agents/:id', (req, res) => {
  const agent = need(engine.findAgent(req.params.id), 'Agent');
  Object.assign(agent, cleanAgent(req.body, agent), { updatedAt: now() });
  save();
  res.json(agent);
});

router.delete('/agents/:id', (req, res) => {
  state.agents = state.agents.filter((a) => a.id !== req.params.id);
  save();
  res.json({ ok: true });
});

router.post('/agents/generate-script', ah(async (req, res) => {
  const { purpose, company, agentName, language, tone, details, columns = [] } = req.body;
  if (!purpose?.trim()) throw fail(400, 'Describe the purpose of the call first');
  const lang = catalog.languageName(language);
  const prompt = `You design scripts for AI voice agents that make outbound phone calls in India.

Call purpose: ${purpose}
Company / brand: ${company || 'not specified'}
Agent's name: ${agentName || 'Priya'}
Spoken language: ${lang}
Tone: ${tone || 'friendly'}
Extra details, offers, FAQs: ${details || 'none'}
Data available for each contact (usable as {{variable}}): ${columns.map((c) => `{{${c}}}`).join(', ') || '{{name}}'}

The lines are spoken aloud by a text-to-speech voice, so never write alternatives with slashes (like रहा/रही or he/she).
Pick one gendered form for the agent and use it consistently, or phrase the sentence neutrally.

Return ONLY a JSON object with these keys:
{"system_prompt": "Instructions for the agent, written in English. Cover: role and goal, a step-by-step call flow, information to collect, how to handle common objections, FAQs with answers, and rules (be brief, respect a 'no', never invent facts). Use {{variables}} where helpful. 200-400 words.",
 "opening_line": "First thing the agent says when the call connects, in ${lang}${language === 'en-IN' ? '' : ' (native script)'}. Greet {{name}}, introduce the agent and company, state the reason, ask permission to continue. 1-2 sentences.",
 "silence_prompt": "What to say if the person goes quiet, in ${lang}. 1 short sentence.",
 "goodbye_line": "Polite closing line, in ${lang}. 1 sentence."}`;
  const s = await sarvam.chatJson([{ role: 'user', content: prompt }], { model: catalog.DEFAULT_LLM, temperature: 0.5, maxTokens: 4096, reasoning: 'low' });
  res.json({
    systemPrompt: String(s.system_prompt || ''),
    openingLine: String(s.opening_line || ''),
    silencePrompt: String(s.silence_prompt || ''),
    goodbyeLine: String(s.goodbye_line || ''),
  });
}));

router.post('/tts/preview', ah(async (req, res) => {
  const { text, language, ttsModel, speaker, pace } = req.body;
  if (!text?.trim()) throw fail(400, 'Nothing to speak');
  const audio = await sarvam.tts({ text, languageCode: language, model: ttsModel, speaker, pace });
  res.type('audio/wav').send(audio);
}));

// ---------- Calls ----------

router.get('/calls', (req, res) => {
  let calls = [...state.calls].sort(byNewest);
  if (req.query.contactId) calls = calls.filter((c) => c.contactId === req.query.contactId);
  res.json(calls.slice(0, 500).map(engine.publicCall));
});

router.get('/calls/:id', (req, res) => {
  const call = need(engine.findCall(req.params.id), 'Call');
  const contact = engine.findContact(call.contactId);
  res.json({ ...engine.publicCall(call), contact: contact || null });
});

router.post('/calls/phone', (req, res) => {
  const agent = need(engine.findAgent(req.body.agentId), 'Agent');
  const tel = telephony.status();
  if (!tel.ready) throw fail(400, `Phone calling is not set up on the server (missing ${tel.missing.join(', ')}). Use a browser test call meanwhile.`);
  const contacts = (req.body.contactIds || []).map(engine.findContact).filter(Boolean);
  if (!contacts.length) throw fail(400, 'Select at least one contact');
  const calls = contacts.map((c) => engine.createCall({ agentId: agent.id, contactId: c.id, mode: 'phone' }));
  engine.enqueue(calls.map((c) => c.id));
  res.json({ queued: calls.length });
});

router.post('/calls/:id/hangup', ah(async (req, res) => {
  const call = need(engine.findCall(req.params.id), 'Call');
  if (call.endedAt) return res.json(engine.publicCall(call));
  if (call.mode === 'phone' && call.twilioSid) {
    await telephony.hangup(call.twilioSid);
  } else {
    await engine.finalizeCall(call, call.mode === 'phone' ? 'canceled' : 'completed');
  }
  res.json(engine.publicCall(call));
}));

router.post('/calls/:id/resummarize', ah(async (req, res) => {
  const call = need(engine.findCall(req.params.id), 'Call');
  if (!call.endedAt) throw fail(400, 'The call is still running');
  await engine.writeSummary(call);
  res.json(engine.publicCall(call));
}));

router.get('/calls/:id/recording', ah(async (req, res) => {
  const call = need(engine.findCall(req.params.id), 'Call');
  if (!call.recording?.url) throw fail(404, 'No recording for this call');
  const { buffer } = await telephony.fetchRecording(call.recording.url, '.mp3');
  res.type('audio/mpeg').send(buffer);
}));

// Browser test calls: the dashboard plays the agent and records your microphone.
router.post('/calls/browser', ah(async (req, res) => {
  const agent = need(engine.findAgent(req.body.agentId), 'Agent');
  if (req.body.contactId) need(engine.findContact(req.body.contactId), 'Contact');
  const call = engine.createCall({ agentId: agent.id, contactId: req.body.contactId, mode: 'browser' });
  try {
    const opening = await engine.buildOpening(call, { phone: false });
    call.transcript.push({ role: 'agent', text: opening.text, at: now() });
    save();
    res.json({ call: engine.publicCall(call), text: opening.text, audio: `/media/${opening.audio}` });
  } catch (err) {
    call.error = err.message;
    engine.finalizeCall(call, 'failed');
    throw err;
  }
}));

router.post('/calls/:id/browser-turn', upload.single('audio'), ah(async (req, res) => {
  const call = need(engine.findCall(req.params.id), 'Call');
  if (call.endedAt) throw fail(400, 'This call has ended');
  const agent = need(engine.findAgent(call.agentId), 'Agent');

  let userText = String(req.body.text || '').trim();
  if (req.file) {
    const ext = (req.file.mimetype.match(/audio\/(\w+)/) || [])[1] || 'webm';
    const { transcript } = await sarvam.stt(req.file.buffer, {
      filename: `turn.${ext === 'mpeg' ? 'mp3' : ext}`,
      mimeType: req.file.mimetype.split(';')[0],
      languageCode: agent.sttAutoDetect ? 'unknown' : agent.language,
    });
    userText = transcript;
  }

  let reply;
  if (!userText) reply = engine.silenceLine(call);
  else { call.silenceCount = 0; reply = await engine.agentReply(call, userText); }
  const file = await engine.speak(agent, reply.text, { phone: false });
  res.json({ userText, text: reply.text, audio: `/media/${file}`, end: reply.end });
}));

router.post('/calls/:id/end', ah(async (req, res) => {
  const call = need(engine.findCall(req.params.id), 'Call');
  await engine.finalizeCall(call, 'completed');
  res.json(engine.publicCall(call));
}));

module.exports = router;
