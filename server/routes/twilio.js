// Webhooks Twilio calls during a phone call. Each caller turn: record -> Sarvam STT -> Sarvam LLM -> Sarvam TTS -> play.
const express = require('express');
const { save, now } = require('../db');
const engine = require('../engine');
const sarvam = require('../sarvam');
const telephony = require('../telephony');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));
router.use((req, res, next) => {
  if (telephony.validateSignature(req)) return next();
  console.warn(`Rejected Twilio webhook with a bad signature: ${req.originalUrl}`);
  res.status(403).send('Invalid signature');
});

const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const mediaUrl = (file) => `${telephony.publicBase()}/media/${file}`;
const send = (res, xml) => res.type('text/xml').send(xml);

function listen(call, file) {
  const base = telephony.publicBase();
  return twiml(
    `<Play>${esc(mediaUrl(file))}</Play>`
    + `<Record action="${esc(`${base}/twilio/turn/${call.id}`)}" method="POST" maxLength="28" timeout="2" playBeep="false" trim="trim-silence"/>`
    + `<Redirect method="POST">${esc(`${base}/twilio/silence/${call.id}`)}</Redirect>`,
  );
}
const finish = (file) => twiml(`<Play>${esc(mediaUrl(file))}</Play><Hangup/>`);
const failure = twiml('<Say>Sorry, we are having a technical problem. We will call you back. Goodbye.</Say><Hangup/>');

function handler(fn) {
  return async (req, res) => {
    const call = engine.findCall(req.params.callId);
    const agent = call && engine.findAgent(call.agentId);
    if (!call || !agent) return send(res, twiml('<Hangup/>'));
    try {
      await fn(req, res, call, agent);
    } catch (err) {
      console.error(`Call ${call.id}:`, err.message);
      call.error = err.message;
      save();
      send(res, failure);
    }
  };
}

async function respondToSilence(res, call, agent) {
  const { text, end } = engine.silenceLine(call);
  const file = await engine.speak(agent, text, { phone: true });
  send(res, end ? finish(file) : listen(call, file));
}

// Call answered: play the opening line.
router.post('/voice/:callId', handler(async (req, res, call, agent) => {
  call.status = 'in-progress';
  call.startedAt = call.startedAt || now();
  const opening = call.opening || await engine.buildOpening(call, { phone: true });
  call.transcript.push({ role: 'agent', text: opening.text, at: now() });
  save();
  send(res, listen(call, opening.audio));
}));

// Caller finished speaking.
router.post('/turn/:callId', handler(async (req, res, call, agent) => {
  const { RecordingUrl, RecordingDuration } = req.body;
  if (!RecordingUrl || Number(RecordingDuration) < 1) return respondToSilence(res, call, agent);

  const { buffer } = await telephony.fetchRecording(RecordingUrl);
  const { transcript } = await sarvam.stt(buffer, {
    filename: 'turn.wav', mimeType: 'audio/wav', languageCode: agent.sttAutoDetect ? 'unknown' : agent.language,
  });
  if (!transcript) return respondToSilence(res, call, agent);

  call.silenceCount = 0;
  const { text, end } = await engine.agentReply(call, transcript);
  const file = await engine.speak(agent, text, { phone: true });
  send(res, end ? finish(file) : listen(call, file));
}));

router.post('/silence/:callId', handler(async (req, res, call, agent) => respondToSilence(res, call, agent)));

router.post('/status/:callId', (req, res) => {
  const call = engine.findCall(req.params.callId);
  const s = req.body.CallStatus;
  if (call && !call.endedAt) {
    if (s === 'ringing') call.status = 'ringing';
    else if (s === 'in-progress') call.status = 'in-progress';
    else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(s)) {
      engine.finalizeCall(call, s, { duration: Number(req.body.CallDuration) || 0 });
    }
    save();
  }
  res.sendStatus(204);
});

router.post('/recording/:callId', (req, res) => {
  const call = engine.findCall(req.params.callId);
  if (call && req.body.RecordingUrl) {
    call.recording = { sid: req.body.RecordingSid, url: req.body.RecordingUrl, duration: Number(req.body.RecordingDuration) || 0 };
    save();
  }
  res.sendStatus(204);
});

module.exports = router;
