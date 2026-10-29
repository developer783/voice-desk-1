// Thin client for the Sarvam AI REST API. The key only ever lives here, on the server.
const BASE = 'https://api.sarvam.ai';

function apiKey() {
  // Tolerate keys pasted into a hosting dashboard with spaces or quotes around them.
  const key = (process.env.SARVAM_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!key) throw Object.assign(new Error('SARVAM_API_KEY is not set on the server. Add it to .env, or on Render under Environment, then restart.'), { status: 500 });
  return key;
}

const HINTS = {
  401: 'Sarvam rejected the API key. Check SARVAM_API_KEY on the server (on Render: Environment tab) and redeploy.',
  403: 'Sarvam rejected the API key. Check SARVAM_API_KEY on the server (on Render: Environment tab) and redeploy.',
  402: 'Your Sarvam account has run out of credits. Top up at dashboard.sarvam.ai.',
  429: 'Sarvam rate limit or credit limit reached. Wait a minute, or check your plan at dashboard.sarvam.ai.',
  503: 'This Sarvam model is temporarily unavailable. Try again shortly or pick the other model in the agent settings.',
};

async function parse(res) {
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || body?.detail || text.slice(0, 300) || res.statusText;
    const detail = (typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const hint = HINTS[res.status] ? `${HINTS[res.status]} ` : '';
    throw Object.assign(new Error(`${hint}Sarvam API error (${res.status}): ${detail}`), { status: 502, upstreamStatus: res.status });
  }
  return body;
}

// Quick end-to-end check of the key, used by the dashboard's connection test.
async function check() {
  const results = {};
  try { apiKey(); } catch (err) { return { ok: false, error: err.message }; }
  const probe = async (name, fn) => {
    const started = Date.now();
    try { await fn(); results[name] = { ok: true, ms: Date.now() - started }; }
    catch (err) { results[name] = { ok: false, error: err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message }; }
  };
  await Promise.all([
    probe('voice', () => tts({ text: 'नमस्ते', languageCode: 'hi-IN', model: 'bulbul:v3', speaker: 'priya' })),
    probe('llm', () => chat([{ role: 'user', content: 'Reply with OK' }], { maxTokens: 256, reasoning: 'low' })),
  ]);
  return { ok: Object.values(results).every((r) => r.ok), ...results };
}

// Text-to-speech (Bulbul). Returns a WAV Buffer.
async function tts({ text, languageCode, model = 'bulbul:v3', speaker, pace = 1, sampleRate = 22050 }) {
  const limit = model === 'bulbul:v2' ? 1500 : 2500;
  const body = {
    text: String(text).slice(0, limit),
    language_code: languageCode,
    model,
    pace: Number(pace) || 1,
    speech_sample_rate: sampleRate,
    output_audio_codec: 'wav',
  };
  if (speaker) body.speaker = speaker;
  const res = await fetch(`${BASE}/text-to-speech`, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await parse(res);
  if (!json?.audios?.[0]) throw new Error('Sarvam TTS returned no audio');
  return Buffer.from(json.audios[0], 'base64');
}

// Speech-to-text (Saaras). Audio must be under 30 seconds.
async function stt(buffer, { filename = 'audio.wav', mimeType = 'audio/wav', languageCode = 'unknown', model = 'saaras:v4' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', model);
  form.append('language_code', languageCode || 'unknown');
  const res = await fetch(`${BASE}/speech-to-text`, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey() },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const json = await parse(res);
  return { transcript: (json.transcript || '').trim(), languageCode: json.language_code };
}

// If a model is temporarily down (503), retry once on the other one so live calls keep going.
const FALLBACK = { 'sarvam-105b': 'sarvam-105b-conversations', 'sarvam-105b-conversations': 'sarvam-105b' };

// Chat completions (Sarvam LLM). Returns the assistant's text.
async function chat(messages, { model = 'sarvam-105b-conversations', temperature = 0.3, maxTokens = 1024, reasoning } = {}) {
  const body = { model, messages, temperature: Number(temperature), max_tokens: maxTokens };
  if (reasoning) body.reasoning_effort = reasoning;
  const key = apiKey();
  const send = (payload) => fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'api-subscription-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  }).then(parse);
  let json;
  try {
    json = await send(body);
  } catch (err) {
    if (err.upstreamStatus !== 503 || !FALLBACK[model]) throw err;
    console.warn(`${model} is unavailable, retrying with ${FALLBACK[model]}`);
    json = await send({ ...body, model: FALLBACK[model] });
  }
  const choice = json?.choices?.[0];
  const content = (choice?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!content) {
    throw new Error(choice?.finish_reason === 'length'
      ? 'Sarvam LLM ran out of tokens while thinking. Try a lower reasoning level.'
      : 'Sarvam LLM returned an empty reply');
  }
  return content;
}

// Pull the first JSON object out of an LLM reply.
function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Chat that must return JSON. The model occasionally emits malformed JSON, so ask again once.
async function chatJson(messages, options) {
  const raw = await chat(messages, options);
  try {
    return extractJson(raw);
  } catch (err) {
    console.warn('Retrying after invalid JSON from the model:', err.message);
    const retry = [...messages, { role: 'assistant', content: raw },
      { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the valid JSON object. Escape any double quotes inside strings.' }];
    return extractJson(await chat(retry, { ...options, temperature: 0.1 }));
  }
}

module.exports = { tts, stt, chat, chatJson, extractJson, check };
