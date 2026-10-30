const crypto = require('crypto');

const COOKIE = 'rp_session';
const DAYS = 14;

function secret() {
  return process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
}

function sign(v) {
  return crypto.createHmac('sha256', secret()).update(v).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeToken() {
  const exp = String(Date.now() + DAYS * 86400 * 1000);
  return exp + '.' + sign(exp);
}

function verifyToken(t) {
  if (!t || !secret()) return false;
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig) return false;
  if (!safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function isAdmin(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function setSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function checkPassword(p) {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real) return false;
  return safeEqual(p || '', real);
}

// Webhooks: exigem WEBHOOK_SECRET (querystring ?key= ou header x-webhook-key).
function checkWebhookKey(req) {
  const key = process.env.WEBHOOK_SECRET;
  if (!key) return false;
  const got = (req.query && req.query.key) || req.headers['x-webhook-key'] || '';
  return safeEqual(got, key);
}

module.exports = { isAdmin, setSession, clearSession, checkPassword, checkWebhookKey };
