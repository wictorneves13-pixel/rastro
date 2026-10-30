// API do painel. Todas as rotas exigem sessão (cookie) e usam ?r=nome-da-rota
const { q } = require('../lib/db');
const { isAdmin } = require('../lib/auth');
const { readBody, normalizePhone, clip } = require('../lib/util');
const meta = require('../lib/meta');
const ghl = require('../lib/ghl');

const TZ = process.env.TZ_NAME || 'America/Sao_Paulo';

// Dimensões disponíveis nos relatórios (expressões SQL fixas, nunca vindas do usuário)
const DIMS = {
  origin: "coalesce(origin, 'direct')",
  channel: "coalesce(nullif(channel, ''), origin, 'direct')",
  campaign: "coalesce(nullif(utm_campaign, ''), nullif(campaign_id, ''), '(sem campanha)')",
  adset: "coalesce(nullif(utm_term, ''), nullif(adset_id, ''), '(sem conjunto)')",
  ad: "coalesce(nullif(utm_content, ''), nullif(ad_id, ''), nullif(ad_headline, ''), '(sem anúncio)')",
};

// ───────── datas ─────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function getRange(query) {
  const to = DATE_RE.test(query.to || '') ? query.to : today();
  let from = DATE_RE.test(query.from || '') ? query.from : addDays(to, -29);
  if (from > to) from = to;
  if (addDays(from, 400) < to) from = addDays(to, -400);
  return { from, to };
}
// condição "created_at dentro do período" com $1=from, $2=to, $3=fuso
const inRange = (col) =>
  `${col} >= ($1::date)::timestamp at time zone $3 and ${col} < ($2::date + 1)::timestamp at time zone $3`;

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ───────── rotas ─────────
async function stats(req) {
  const { from, to } = getRange(req.query);
  const by = DIMS[req.query.by] ? req.query.by : 'campaign';
  const P = [from, to, TZ];

  const breakdown = (dim) =>
    q(
      `select ${DIMS[dim]} as k, count(*)::int as leads,
              count(*) filter (where status = 'won')::int as buyers,
              coalesce(sum(revenue), 0)::float as revenue
         from leads where ${inRange('created_at')}
        group by 1 order by 2 desc, 1 limit 60`,
      P
    );

  const [k1, k2, d1, d2, rows, origins] = await Promise.all([
    q(`select count(*)::int as leads, count(*) filter (where status = 'won')::int as buyers from leads where ${inRange('created_at')}`, P),
    q(`select count(*)::int as sales, coalesce(sum((data->>'value')::numeric), 0)::float as revenue from events where type = 'purchase' and ${inRange('created_at')}`, P),
    q(`select to_char((created_at at time zone $3)::date, 'YYYY-MM-DD') as d, count(*)::int as n from leads where ${inRange('created_at')} group by 1`, P),
    q(`select to_char((created_at at time zone $3)::date, 'YYYY-MM-DD') as d, count(*)::int as n, coalesce(sum((data->>'value')::numeric), 0)::float as revenue from events where type = 'purchase' and ${inRange('created_at')} group by 1`, P),
    breakdown(by),
    by === 'origin' ? null : breakdown('origin'),
  ]);

  const leadsByDay = new Map(d1.map((r) => [r.d, r.n]));
  const salesByDay = new Map(d2.map((r) => [r.d, r]));
  const days = eachDay(from, to).map((d) => ({
    d,
    leads: leadsByDay.get(d) || 0,
    sales: (salesByDay.get(d) || {}).n || 0,
    revenue: (salesByDay.get(d) || {}).revenue || 0,
  }));

  const leads = k1[0].leads;
  const buyers = k1[0].buyers;
  return {
    range: { from, to },
    kpi: {
      leads, buyers,
      sales: k2[0].sales,
      revenue: k2[0].revenue,
      conv: leads ? buyers / leads : 0,
    },
    days,
    by,
    rows,
    origins: origins || rows,
  };
}

async function leadsList(req) {
  const P = [];
  const where = [];
  const push = (v) => { P.push(v); return '$' + P.length; };

  if (req.query.origin) where.push(`origin = ${push(req.query.origin)}`);
  if (req.query.status) where.push(`status = ${push(req.query.status)}`);
  if (req.query.dim && DIMS[req.query.dim] && req.query.val) where.push(`${DIMS[req.query.dim]} = ${push(req.query.val)}`);
  if (DATE_RE.test(req.query.from || '') && DATE_RE.test(req.query.to || '')) {
    const a = push(req.query.from), b = push(req.query.to), z = push(TZ);
    where.push(`created_at >= (${a}::date)::timestamp at time zone ${z} and created_at < (${b}::date + 1)::timestamp at time zone ${z}`);
  }
  if (req.query.search) {
    const s = push('%' + String(req.query.search).slice(0, 80) + '%');
    where.push(`(name ilike ${s} or phone like ${s} or email ilike ${s} or utm_campaign ilike ${s} or utm_content ilike ${s} or ad_headline ilike ${s})`);
  }
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  const [rows, total] = await Promise.all([
    q(
      `select id, name, phone, email, origin, channel, utm_campaign, utm_content, ad_id, ad_headline,
              stage, status, revenue::float as revenue, sales_count, created_at
         from leads ${w} order by created_at desc limit ${limit} offset ${offset}`,
      P
    ),
    q(`select count(*)::int as n from leads ${w}`, P),
  ]);
  return { rows, total: total[0].n, limit, offset };
}

async function leadDetail(req) {
  const id = parseInt(req.query.id, 10);
  if (!id) return { error: 'id inválido', status: 400 };
  const lead = (await q('select * from leads where id = $1', [id]))[0];
  if (!lead) return { error: 'lead não encontrado', status: 404 };
  const [events, touches] = await Promise.all([
    q('select id, type, data, created_at from events where lead_id = $1 order by created_at asc, id asc', [id]),
    lead.visitor_id
      ? q(
          `select type, url, referrer, channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                  ad_id, link_slug, ref_code, created_at
             from touches where visitor_id = $1 order by created_at asc limit 100`,
          [lead.visitor_id]
        )
      : [],
  ]);
  lead.revenue = Number(lead.revenue);
  return { lead, events, touches };
}

async function linksList() {
  const rows = await q(
    `select l.*, coalesce(x.leads, 0)::int as leads, coalesce(x.buyers, 0)::int as buyers, coalesce(x.revenue, 0)::float as revenue
       from links l
       left join (
         select link_slug, count(*) as leads, count(*) filter (where status = 'won') as buyers, sum(revenue) as revenue
           from leads where link_slug is not null group by link_slug
       ) x on x.link_slug = l.slug
      order by l.created_at desc`
  );
  return { rows };
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}
const rand = (n) => Math.random().toString(36).slice(2, 2 + n);

async function linkCreate(req) {
  const b = readBody(req);
  const name = clip(b.name, 80);
  if (!name) return { error: 'Dê um nome ao link.', status: 400 };
  const kind = b.kind === 'url' ? 'url' : 'whatsapp';
  let wa_phone = null, destination = null;
  if (kind === 'whatsapp') {
    wa_phone = normalizePhone(b.wa_phone);
    if (!wa_phone) return { error: 'Informe o número do WhatsApp com DDD.', status: 400 };
  } else {
    try {
      const u = new URL(String(b.destination || ''));
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      destination = u.toString();
    } catch { return { error: 'Informe uma URL completa, começando com https://', status: 400 }; }
  }
  const channel = clip(b.channel, 40) || 'link';
  let slug = slugify(b.slug) || slugify(name) || rand(6);
  const row = [
    name, channel, kind, destination, wa_phone, clip(b.wa_message, 300),
    clip(b.utm_source, 60) || channel, clip(b.utm_medium, 60) || 'link', clip(b.utm_campaign, 100) || name,
  ];
  for (let i = 0; i < 4; i++) {
    const ins = await q(
      `insert into links (slug, name, channel, kind, destination, wa_phone, wa_message, utm_source, utm_medium, utm_campaign)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (slug) do nothing returning slug`,
      [slug, ...row]
    );
    if (ins.length) return { ok: true, slug };
    slug = slugify(name).slice(0, 24) + '-' + rand(3);
  }
  return { error: 'Não foi possível gerar um endereço único.', status: 500 };
}

async function adsReport(req) {
  const { from, to } = getRange(req.query);
  const P = [from, to, TZ];
  const internal = await q(
    `select ad_id, max(utm_content) as ad_name, max(utm_campaign) as campaign, max(utm_term) as adset,
            count(*)::int as leads, count(*) filter (where status = 'won')::int as buyers,
            coalesce(sum(revenue), 0)::float as revenue
       from leads where ad_id is not null and ad_id <> '' and ${inRange('created_at')}
      group by ad_id`,
    P
  );
  const byAd = new Map(internal.map((r) => [r.ad_id, r]));
  const out = [];
  let metaError = null;

  if (meta.adsConfigured()) {
    try {
      const ins = await meta.adInsights(from, to);
      for (const i of ins) {
        const m = byAd.get(i.ad_id) || { leads: 0, buyers: 0, revenue: 0 };
        byAd.delete(i.ad_id);
        out.push({
          ad_id: i.ad_id, ad_name: i.ad_name, campaign: i.campaign_name, adset: i.adset_name,
          spend: parseFloat(i.spend) || 0, impressions: parseInt(i.impressions, 10) || 0, clicks: parseInt(i.clicks, 10) || 0,
          leads: m.leads, buyers: m.buyers, revenue: m.revenue,
        });
      }
    } catch (e) {
      metaError = e.message;
    }
  }
  for (const m of byAd.values()) out.push({ ...m, spend: null, impressions: null, clicks: null });

  for (const r of out) {
    r.cpl = r.spend && r.leads ? r.spend / r.leads : null;
    r.cac = r.spend && r.buyers ? r.spend / r.buyers : null;
    r.roas = r.spend ? r.revenue / r.spend : null;
  }
  out.sort((a, b) => (b.spend || 0) - (a.spend || 0) || b.leads - a.leads);
  return { range: { from, to }, rows: out, metaConfigured: meta.adsConfigured(), metaError };
}

async function settings() {
  const hooks = await q('select source, count(*)::int as n, max(created_at) as last from webhook_logs group by source');
  const has = (k) => !!(process.env[k] || '').trim();
  return {
    tz: TZ,
    currency: process.env.CURRENCY || 'BRL',
    vars: {
      ADMIN_PASSWORD: has('ADMIN_PASSWORD'),
      SESSION_SECRET: has('SESSION_SECRET'),
      WEBHOOK_SECRET: has('WEBHOOK_SECRET'),
    },
    meta: {
      capi: meta.capiConfigured(),
      test_mode: has('META_TEST_EVENT_CODE'),
      waba: has('META_WABA_ID'),
      ads: meta.adsConfigured(),
      ads_token_only: has('META_ADS_TOKEN'),
    },
    ghl: { configured: ghl.configured(), custom_fields: Object.keys(ghl.customFieldMap()).length },
    hooks: Object.fromEntries(hooks.map((h) => [h.source, { n: h.n, last: h.last }])),
  };
}

async function logs() {
  const rows = await q('select id, source, status, payload, created_at from webhook_logs order by id desc limit 25');
  return { rows };
}

async function testMeta() {
  const r = await meta.sendEvent(
    { id: 0, phone: '5511999990000', origin: 'direct', created_at: new Date().toISOString() },
    { type: 'lead', eventId: 'teste_' + Date.now() }
  );
  return r;
}

// ───────── despacho ─────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.status(401).json({ error: 'Faça login para continuar.' });

  const route = req.query.r;
  const send = (out) => {
    if (out && out.error && out.status) return res.status(out.status).json({ error: out.error });
    return res.status(200).json(out);
  };

  try {
    if (route === 'stats') return send(await stats(req));
    if (route === 'leads') return send(await leadsList(req));
    if (route === 'lead') {
      if (req.method === 'DELETE') {
        await q('delete from leads where id = $1', [parseInt(req.query.id, 10) || 0]);
        return send({ ok: true });
      }
      return send(await leadDetail(req));
    }
    if (route === 'links') {
      if (req.method === 'POST') return send(await linkCreate(req));
      if (req.method === 'DELETE') {
        await q('delete from links where slug = $1', [String(req.query.slug || '')]);
        return send({ ok: true });
      }
      return send(await linksList());
    }
    if (route === 'ads') return send(await adsReport(req));
    if (route === 'settings') return send(await settings());
    if (route === 'logs') return send(await logs());
    if (route === 'test-meta' && req.method === 'POST') return send(await testMeta());
    return res.status(404).json({ error: 'rota desconhecida' });
  } catch (e) {
    console.error('admin:', e);
    return res.status(500).json({ error: e.message });
  }
};
