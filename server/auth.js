// Optional password login for the dashboard (set APP_PASSWORD).
const crypto = require('crypto');
const express = require('express');

const COOKIE = 'vd_session';
const password = () => process.env.APP_PASSWORD || '';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sessionToken = () => crypto.createHmac('sha256', `${password()}|${process.env.SESSION_SECRET || 'voice-desk'}`).update('session').digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthed(req) {
  if (!password()) return true;
  const token = readCookie(req, COOKIE);
  return Boolean(token) && crypto.timingSafeEqual(sha(token), sha(sessionToken()));
}

const router = express.Router();

router.get('/session', (req, res) => res.json({ authRequired: Boolean(password()), authed: isAuthed(req) }));

router.post('/login', express.json(), (req, res) => {
  if (!password() || !crypto.timingSafeEqual(sha(req.body?.password || ''), sha(password()))) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

module.exports = { router, requireAuth };
