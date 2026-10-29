// Twilio adapter using the plain REST API (no SDK needed).
const crypto = require('crypto');

const env = (k) => (process.env[k] || '').trim();
const publicBase = () => env('PUBLIC_BASE_URL').replace(/\/+$/, '');
const authHeader = () => 'Basic ' + Buffer.from(`${env('TWILIO_ACCOUNT_SID')}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64');
const apiBase = () => `https://api.twilio.com/2010-04-01/Accounts/${env('TWILIO_ACCOUNT_SID')}`;

function status() {
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'PUBLIC_BASE_URL'].filter((k) => !env(k));
  const from = env('TWILIO_FROM_NUMBER');
  return {
    provider: 'twilio',
    ready: missing.length === 0,
    missing,
    from: from ? from.slice(0, 4) + '•••' + from.slice(-3) : null,
  };
}

async function twilio(path, params) {
  const res = await fetch(apiBase() + path, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio error (${res.status}): ${json.message || res.statusText}`);
  return json;
}

async function dial({ callId, to }) {
  const base = publicBase();
  const params = new URLSearchParams({
    To: to,
    From: env('TWILIO_FROM_NUMBER'),
    Url: `${base}/twilio/voice/${callId}`,
    Method: 'POST',
    StatusCallback: `${base}/twilio/status/${callId}`,
    StatusCallbackMethod: 'POST',
    Record: 'true',
    RecordingChannels: 'dual',
    RecordingStatusCallback: `${base}/twilio/recording/${callId}`,
    Timeout: '30',
  });
  for (const ev of ['initiated', 'ringing', 'answered', 'completed']) params.append('StatusCallbackEvent', ev);
  const json = await twilio('/Calls.json', params);
  return json.sid;
}

async function hangup(sid) {
  await twilio(`/Calls/${sid}.json`, new URLSearchParams({ Status: 'completed' }));
}

// Download a Twilio recording (they require account auth). Retries briefly while Twilio finalises the file.
async function fetchRecording(url, ext = '.wav') {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url + ext, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    if (res.status !== 404) throw new Error(`Could not download recording (${res.status})`);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Recording was not available in time');
}

// Verifies X-Twilio-Signature so nobody else can drive the call webhooks.
function validateSignature(req) {
  const token = env('TWILIO_AUTH_TOKEN');
  if (!token || env('TWILIO_VALIDATE_SIGNATURE') === 'false') return true;
  const params = req.body || {};
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], publicBase() + req.originalUrl);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const got = req.get('X-Twilio-Signature') || '';
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = { status, dial, hangup, fetchRecording, validateSignature, publicBase };
