const crypto = require('crypto');

// ───────── Código de referência (vai junto da mensagem de WhatsApp) ─────────
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_RE = /\(ref:([A-HJ-NP-Z2-9]{6})\)/;

function newRefCode(n = 6) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += REF_ALPHABET[b[i] % REF_ALPHABET.length];
  return s;
}

function extractRef(text) {
  const m = REF_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

function isRefCode(s) {
  return typeof s === 'string' && /^[A-HJ-NP-Z2-9]{6}$/.test(s);
}

// ───────── Telefone ─────────
// Devolve só dígitos com DDI (ex.: 5577999998888) ou null.
// Para o Brasil, insere o 9º dígito em celulares antigos (12 dígitos) para que
// o mesmo número venha igual do WhatsApp, do GHL e do site.
function normalizePhone(raw, cc = process.env.DEFAULT_COUNTRY_CODE || '55') {
  if (raw === null || raw === undefined || raw === '') return null;
  let d = String(raw).split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!d) return null;
  d = d.replace(/^0+/, '');
  if (cc === '55') {
    if (d.length === 10 || d.length === 11) d = '55' + d;
    if (d.length === 12 && d.startsWith('55') && /^[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  } else if (d.length <= 11 && !d.startsWith(cc)) {
    d = cc + d;
  }
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

// ───────── Hash (Meta exige SHA-256 em minúsculas e sem espaços) ─────────
function sha256(v) {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

// ───────── Dinheiro ─────────
// Aceita 1500, "1500.50", "1.500,50", "R$ 1.500,50"
function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ───────── Busca em objetos aninhados (payloads de webhook variam muito) ─────────
function nodesBFS(obj, maxDepth = 6) {
  const nodes = [];
  const queue = [[obj, 0]];
  while (queue.length) {
    const [cur, d] = queue.shift();
    if (!cur || typeof cur !== 'object' || d > maxDepth) continue;
    nodes.push(cur);
    for (const v of Object.values(cur)) if (v && typeof v === 'object') queue.push([v, d + 1]);
  }
  return nodes;
}

// Primeiro valor encontrado para qualquer uma das chaves (na ordem de prioridade
// das chaves; dentro de cada chave, do nível mais raso para o mais fundo).
function findDeep(obj, keys, opts = {}) {
  const nodes = nodesBFS(obj);
  for (const k of keys) {
    const lk = k.toLowerCase();
    for (const n of nodes) {
      for (const [nk, v] of Object.entries(n)) {
        if (nk.toLowerCase() !== lk) continue;
        if (v === null || v === undefined || v === '') continue;
        if (opts.object ? typeof v === 'object' : typeof v !== 'object') return v;
      }
    }
  }
  return undefined;
}

// Todos os valores (string/número) das chaves, na ordem de prioridade.
function collectValues(obj, keys) {
  const nodes = nodesBFS(obj);
  const out = [];
  for (const k of keys) {
    const lk = k.toLowerCase();
    for (const n of nodes) {
      for (const [nk, v] of Object.entries(n)) {
        if (nk.toLowerCase() === lk && (typeof v === 'string' || typeof v === 'number')) out.push(v);
      }
    }
  }
  return out;
}

function truthy(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', '1', 'yes', 'sim'].includes(v.toLowerCase());
  return false;
}

// ───────── HTTP ─────────
function readBody(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return {}; }
  }
  return b && typeof b === 'object' ? b : {};
}

function clientIp(req) {
  const h = req.headers || {};
  const xf = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || h['x-real-ip'] || (req.socket && req.socket.remoteAddress) || null;
}

function clip(v, n = 300) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n) : null;
}

// CORS para o endpoint chamado pelo script dos sites
function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (allowed.length) {
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return !allowed.length || (origin && allowed.includes(origin));
}

// ───────── Rótulos ─────────
const ORIGIN_LABELS = {
  ctwa: 'Anúncio de WhatsApp',
  site: 'Site / página',
  link: 'Link rastreado',
  direct: 'Sem origem',
};
function originLabel(o) {
  return ORIGIN_LABELS[o] || o || 'Sem origem';
}

// ───────── Classificação do canal de uma visita ─────────
function classifyChannel(a = {}, referrer = '') {
  const src = String(a.utm_source || '').toLowerCase();
  if (a.fbclid || /^(fb|facebook|ig|instagram|meta)/.test(src)) return 'meta';
  if (a.gclid || /google/.test(src)) return 'google';
  if (src) return src.slice(0, 40);
  if (referrer) {
    try {
      const host = new URL(referrer).hostname.replace(/^www\./, '');
      if (/instagram\./.test(host)) return 'instagram';
      if (/(facebook|fb)\./.test(host)) return 'facebook';
      if (/google\./.test(host)) return 'google-organico';
      if (/youtube\./.test(host)) return 'youtube';
      return host.slice(0, 40);
    } catch { /* ignora */ }
  }
  return 'direto';
}

module.exports = {
  newRefCode, extractRef, isRefCode, REF_RE,
  normalizePhone, sha256, parseMoney,
  findDeep, collectValues, nodesBFS, truthy,
  readBody, clientIp, clip, cors,
  originLabel, ORIGIN_LABELS, classifyChannel,
};
