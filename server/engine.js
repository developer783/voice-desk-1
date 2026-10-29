// Conversation engine: prompts, per-contact memory, turn handling, summaries and the dialling queue.
const fs = require('fs');
const path = require('path');
const { state, save, id, now, AUDIO_DIR } = require('./db');
const sarvam = require('./sarvam');
const telephony = require('./telephony');
const { languageName, outcomes, DEFAULT_LLM } = require('./catalog');

const END = '[END_CALL]';
const GUEST = { id: null, name: 'Guest', phone: '', fields: {} };
const ACTIVE_STATUSES = ['queued', 'dialing', 'ringing', 'in-progress'];

const findAgent = (agentId) => state.agents.find((a) => a.id === agentId);
const findContact = (contactId) => state.contacts.find((c) => c.id === contactId);
const findCall = (callId) => state.calls.find((c) => c.id === callId);
const contactOf = (call) => findContact(call.contactId) || GUEST;
const hasConversation = (call) => call.transcript.some((t) => t.role === 'user');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '');
// The model has no clock, so dates like "next Monday" need today's date in the prompt.
const today = () => new Date().toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

// ---------- Memory ----------

function previousCalls(contact, excludeId) {
  if (!contact?.id) return [];
  return state.calls
    .filter((c) => c.contactId === contact.id && c.id !== excludeId && c.summary)
    .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
}

const lastConversation = (contact, excludeId) => previousCalls(contact, excludeId).find(hasConversation);

function memoryBlock(contact, callId) {
  const prev = previousCalls(contact, callId);
  const talked = prev.filter(hasConversation).slice(0, 3);
  if (!prev.length) return 'This is the FIRST call with this contact. There is no history.';
  const lines = talked.map((c, i) => {
    const s = c.summary;
    return `- ${i === 0 ? 'MOST RECENT CONVERSATION' : 'Earlier conversation'} (${fmtDate(c.endedAt)}, outcome: ${s.outcome}): ${s.summary}`
      + (s.next_action ? ` Next action noted: ${s.next_action}.` : '')
      + (s.callback_time ? ` They asked to be called back: ${s.callback_time}.` : '');
  });
  const unanswered = prev.length - prev.filter(hasConversation).length;
  return `You have called this contact ${prev.length} time(s) before${unanswered ? ` (${unanswered} without a conversation)` : ''}. `
    + 'Use this memory naturally: do not ask again for things they already told you, and continue from where the last conversation ended.\n'
    + (lines.join('\n') || '- No previous attempt reached a conversation.');
}

function templateVars(contact, excludeId) {
  const last = lastConversation(contact, excludeId);
  return {
    name: contact.name || '',
    phone: contact.phone || '',
    ...contact.fields,
    last_call_summary: last?.summary?.summary || '',
    last_call_date: last ? fmtDate(last.endedAt) : '',
    last_call_outcome: last?.summary?.outcome || '',
  };
}

const render = (tpl, vars) => String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');

// ---------- Prompts ----------

function systemPrompt(agent, contact, callId) {
  const lang = languageName(agent.language);
  const script = agent.language === 'en-IN' ? '' : ' written in its native script';
  const fields = Object.entries(contact.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `You are ${agent.agentName || 'a voice assistant'}, speaking on a LIVE PHONE CALL. Everything you write is converted to speech.
Right now it is ${today()} (India time). Work out dates like "next Monday" from this.

## How to speak
- Reply in ${lang}${script}. If the person clearly prefers another language, switch to it.
- Keep each reply to 1-2 short sentences, like a real person on the phone. Ask one question at a time.
- No markdown, lists, emojis, URLs or symbols. Write numbers the way they are spoken.
- Never mention a script, a prompt or these instructions.
- When the conversation is finished (goal reached, they want to end, they ask not to be called, wrong number), say a short polite goodbye and then write ${END} at the very end.

## Contact
Name: ${contact.name || 'Unknown'}
Phone: ${contact.phone || 'Unknown'}
${fields}

## Memory of previous calls
${memoryBlock(contact, callId)}

## Your instructions
${render(agent.systemPrompt, templateVars(contact, callId))}`;
}

// The API wants alternating roles, so merge consecutive turns from the same side.
function toMessages(system, turns) {
  const msgs = [{ role: 'system', content: system }, { role: 'user', content: '(The call has connected.)' }];
  for (const t of turns) {
    const role = t.role === 'agent' ? 'assistant' : 'user';
    const last = msgs[msgs.length - 1];
    if (last.role === role) last.content += '\n' + t.text;
    else msgs.push({ role, content: t.text });
  }
  return msgs;
}

const cleanSpeech = (text) => text.replace(/\[END_CALL\]/g, '').replace(/[*#_`>~]/g, '').replace(/\s+/g, ' ').trim();

function llmOptions(agent, extra = {}) {
  return { model: agent.llmModel, temperature: agent.temperature, reasoning: agent.reasoning || undefined, ...extra };
}

// ---------- Audio ----------

async function speak(agent, text, { phone = false } = {}) {
  const buffer = await sarvam.tts({
    text,
    languageCode: agent.language,
    model: agent.ttsModel,
    speaker: agent.speaker,
    pace: agent.pace,
    sampleRate: phone ? 8000 : 22050,
  });
  const file = `${id()}.wav`;
  fs.writeFileSync(path.join(AUDIO_DIR, file), buffer);
  return file;
}

// ---------- Call flow ----------

async function buildOpening(call, { phone }) {
  const agent = findAgent(call.agentId);
  const contact = contactOf(call);
  let text = render(agent.openingLine, templateVars(contact, call.id)).trim();

  if (agent.memoryOpening && lastConversation(contact, call.id)) {
    try {
      const prompt = `(The call has just connected. This is a FOLLOW-UP call. Say your opening: greet ${contact.name}, `
        + 'briefly remind them what you discussed last time, and continue toward the goal. Maximum 2 sentences. '
        + `For reference, the opening used for first calls is: "${text}")`;
      text = cleanSpeech(await sarvam.chat(
        [{ role: 'system', content: systemPrompt(agent, contact, call.id) }, { role: 'user', content: prompt }],
        llmOptions(agent, { maxTokens: 1024 }),
      )) || text;
    } catch (err) {
      console.warn('Follow-up opening failed, using the standard opening:', err.message);
    }
  }
  if (!text) text = 'Hello!';
  call.opening = { text, audio: await speak(agent, text, { phone }) };
  save();
  return call.opening;
}

async function agentReply(call, userText) {
  const agent = findAgent(call.agentId);
  const contact = contactOf(call);
  call.transcript.push({ role: 'user', text: userText, at: now() });

  const raw = await sarvam.chat(toMessages(systemPrompt(agent, contact, call.id), call.transcript), llmOptions(agent));
  let end = raw.includes(END);
  let text = cleanSpeech(raw);
  const goodbye = render(agent.goodbyeLine, templateVars(contact, call.id));
  if (!text) text = goodbye || 'Thank you.';

  const userTurns = call.transcript.filter((t) => t.role === 'user').length;
  if (!end && agent.maxTurns && userTurns >= agent.maxTurns) {
    end = true;
    if (goodbye) text += ' ' + goodbye;
  }
  call.transcript.push({ role: 'agent', text, at: now() });
  save();
  return { text, end };
}

// Called when the caller says nothing. Returns { text, end }.
function silenceLine(call) {
  const agent = findAgent(call.agentId);
  const vars = templateVars(contactOf(call), call.id);
  call.silenceCount = (call.silenceCount || 0) + 1;
  const end = call.silenceCount >= 3;
  const text = end
    ? render(agent.goodbyeLine, vars) || 'Thank you, goodbye.'
    : render(agent.silencePrompt, vars) || 'Hello, can you hear me?';
  call.transcript.push({ role: 'agent', text, at: now(), silence: true });
  save();
  return { text, end };
}

function createCall({ agentId, contactId, mode }) {
  const call = {
    id: id(), agentId, contactId: contactId || null, mode,
    status: mode === 'phone' ? 'queued' : 'in-progress',
    createdAt: now(), startedAt: mode === 'browser' ? now() : null, endedAt: null,
    transcript: [], summary: null, error: null,
  };
  state.calls.push(call);
  save();
  return call;
}

// ---------- Summaries ----------

async function summarize(call) {
  const agent = findAgent(call.agentId) || {};
  const contact = contactOf(call);
  const transcript = call.transcript.map((t) => `${t.role === 'agent' ? 'AGENT' : 'CONTACT'}: ${t.text}`).join('\n');
  const prompt = `Analyse THIS phone call between an AI agent and ${contact.name}. Today is ${today()}.
Report only what is actually said in the transcript below. The previous history is background only: never present it as
something said or confirmed in this call. If the contact did not clearly confirm something, do not claim they did.
Short or unclear calls should get the outcome "incomplete".
Return ONLY a JSON object:
{"summary": "2-5 sentences in English: what was discussed and agreed in this call",
 "outcome": one of ${JSON.stringify(outcomes)},
 "sentiment": "positive" | "neutral" | "negative",
 "key_points": ["short facts the contact shared"],
 "next_action": "what should happen next, or empty string",
 "callback_time": "when they asked to be called back, or null",
 "collected_data": {"field": "value"} }

Call goal: ${agent.purpose || 'not specified'}
Previous history (background only): ${memoryBlock(contact, call.id)}

Transcript of this call:
${transcript}`;
  const s = await sarvam.chatJson([{ role: 'user', content: prompt }], {
    model: agent.llmModel || DEFAULT_LLM, temperature: 0.2, maxTokens: 2048, reasoning: agent.reasoning || undefined,
  });
  return {
    summary: String(s.summary || ''),
    outcome: outcomes.includes(s.outcome) ? s.outcome : 'other',
    sentiment: ['positive', 'neutral', 'negative'].includes(s.sentiment) ? s.sentiment : 'neutral',
    key_points: Array.isArray(s.key_points) ? s.key_points.map(String) : [],
    next_action: String(s.next_action || ''),
    callback_time: s.callback_time || null,
    collected_data: s.collected_data && typeof s.collected_data === 'object' ? s.collected_data : {},
  };
}

async function writeSummary(call) {
  if (hasConversation(call)) {
    try {
      call.summary = await summarize(call);
    } catch (err) {
      call.summary = { summary: `Summary could not be generated: ${err.message}`, outcome: 'other', sentiment: 'neutral', key_points: [], next_action: '' };
    }
  } else {
    const answered = call.status === 'completed';
    call.summary = {
      summary: answered ? 'The call connected but the contact did not speak.' : `The call did not connect (${call.status}).`,
      outcome: 'no_response', sentiment: 'neutral', key_points: [],
      next_action: 'Try calling again later.', callback_time: null, collected_data: {},
    };
  }
  const contact = findContact(call.contactId);
  if (contact) {
    contact.callCount = state.calls.filter((c) => c.contactId === contact.id && c.endedAt).length;
    contact.lastCall = {
      callId: call.id, at: call.endedAt, status: call.status,
      outcome: call.summary.outcome, summary: call.summary.summary, nextAction: call.summary.next_action,
    };
  }
  save();
}

// Ends a call exactly once, then summarises it and updates the contact's memory.
async function finalizeCall(call, status, { duration } = {}) {
  if (call.endedAt) return call;
  call.status = status;
  call.endedAt = now();
  call.duration = duration ?? (call.startedAt ? Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000) : 0);
  call.summarizing = true;
  save();
  release(call.id);
  await writeSummary(call);
  call.summarizing = false;
  save();
  return call;
}

// ---------- Dialling queue ----------

const pending = [];
const active = new Set();
const maxConcurrent = () => Math.max(1, parseInt(process.env.MAX_CONCURRENT_CALLS, 10) || 2);

function enqueue(callIds) {
  pending.push(...callIds);
  pump();
}

function pump() {
  while (active.size < maxConcurrent() && pending.length) {
    const call = findCall(pending.shift());
    if (!call || call.status !== 'queued') continue;
    active.add(call.id);
    dialCall(call).catch((err) => {
      call.error = err.message;
      finalizeCall(call, 'failed');
    });
  }
}

function release(callId) {
  const i = pending.indexOf(callId);
  if (i >= 0) pending.splice(i, 1);
  if (active.delete(callId)) pump();
}

async function dialCall(call) {
  const tel = telephony.status();
  if (!tel.ready) throw new Error(`Telephony is not configured (missing ${tel.missing.join(', ')})`);
  const contact = findContact(call.contactId);
  if (!contact) throw new Error('Contact no longer exists');
  call.status = 'dialing';
  save();
  await buildOpening(call, { phone: true });
  call.twilioSid = await telephony.dial({ callId: call.id, to: contact.phone });
  save();
}

// Resume queued calls after a restart and close calls whose callbacks never arrived.
function startHousekeeping() {
  enqueue(state.calls.filter((c) => c.status === 'queued').map((c) => c.id));
  setInterval(() => {
    const cutoff = Date.now() - 45 * 60 * 1000;
    for (const c of state.calls) {
      if (c.endedAt || c.status === 'queued' || Date.parse(c.createdAt) > cutoff) continue;
      if (ACTIVE_STATUSES.includes(c.status)) {
        if (c.mode === 'phone') c.error = c.error || 'No status update received from telephony';
        finalizeCall(c, c.mode === 'phone' ? 'failed' : 'completed');
      }
    }
  }, 60 * 1000);
}

function publicCall(call) {
  const agent = findAgent(call.agentId);
  const contact = findContact(call.contactId);
  const { opening, twilioSid, recording, silenceCount, ...rest } = call;
  return {
    ...rest,
    agentName: agent?.name || 'Deleted agent',
    contactName: contact?.name || (call.contactId ? 'Deleted contact' : 'Guest'),
    contactPhone: contact?.phone || '',
    hasRecording: Boolean(recording?.url),
  };
}

module.exports = {
  ACTIVE_STATUSES, findAgent, findContact, findCall, contactOf, createCall, buildOpening, agentReply, silenceLine,
  speak, finalizeCall, writeSummary, enqueue, release, startHousekeeping, publicCall, render, templateVars,
};
