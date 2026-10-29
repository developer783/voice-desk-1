// Tiny JSON-file store. Everything lives in data/db.json; audio files in data/audio.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On Render, point DATA_DIR at a persistent disk; the default folder is wiped on every deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(AUDIO_DIR, { recursive: true });

const state = { contacts: [], agents: [], calls: [] };
if (fs.existsSync(FILE)) {
  Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8')));
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}
function flush() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
process.on('SIGINT', () => { flush(); process.exit(0); });

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

module.exports = { state, save, flush, id, now, DATA_DIR, AUDIO_DIR };
