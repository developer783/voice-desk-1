require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { AUDIO_DIR } = require('./db');
const auth = require('./auth');
const engine = require('./engine');
const telephony = require('./telephony');

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.send('ok'));

// Twilio webhooks and generated audio must be reachable without a dashboard login.
app.use('/twilio', require('./routes/twilio'));
app.use('/media', express.static(AUDIO_DIR, { fallthrough: false, maxAge: '1h' }));

app.use('/api', express.json({ limit: '2mb' }));
app.use('/api', auth.router);
app.use('/api', auth.requireAuth, require('./routes/api'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

// Delete generated audio older than 7 days.
function cleanAudio() {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  for (const f of fs.readdirSync(AUDIO_DIR)) {
    const p = path.join(AUDIO_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
}
cleanAudio();
setInterval(cleanAudio, 6 * 3600 * 1000);

engine.startHousekeeping();

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  const tel = telephony.status();
  console.log(`Voice Desk running at http://localhost:${port}`);
  if (!process.env.SARVAM_API_KEY) console.warn('! SARVAM_API_KEY is not set. Add it to .env');
  if (!process.env.APP_PASSWORD) console.warn('! APP_PASSWORD is not set, so the dashboard has no login');
  console.log(tel.ready ? `Phone calls enabled from ${tel.from}` : `Phone calls disabled (missing ${tel.missing.join(', ')}). Browser test calls still work.`);
});
