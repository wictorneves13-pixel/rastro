// Recebe visitas, cliques em botões de WhatsApp e formulários enviados pelo /t.js
const { q } = require('../lib/db');
const { readBody, clientIp, clip, cors, isRefCode, classifyChannel } = require('../lib/util');
const { registerLead, afterLead } = require('../lib/leads');

const ATTR_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ad_id', 'adset_id', 'campaign_id', 'fbclid', 'gclid', 'rp_l',
];

function pickAttr(o) {
  const out = {};
  if (o && typeof o === 'object') for (const k of ATTR_KEYS) { const v = clip(o[k], 200); if (v) out[k] = v; }
  return out;
}

module.exports = async (req, res) => {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  if (!allowed) return res.status(403).json({ error: 'origem não permitida' });

  try {
    const b = readBody(req);
    const vid = clip(b.v, 64);
    if (!vid || !/^[\w-]+$/.test(vid)) return res.status(400).json({ error: 'visitante inválido' });

    const last = pickAttr(b.a);
    const first = pickAttr(b.f);
    const url = clip(b.url, 600);
    const referrer = clip(b.ref, 600);
    const fbp = clip(b.fbp, 120);
    const fbc = clip(b.fbc, 200);
    const ip = clientIp(req);
    const ua = clip(req.headers['user-agent'], 300);
    const attr = Object.keys(last).length ? last : first;
    const channel = classifyChannel(attr, referrer);

    await q(
      `insert into visitors (id, fbp, fbc, ip, ua, first_attr, last_attr)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       on conflict (id) do update set
         last_seen = now(),
         fbp = coalesce(excluded.fbp, visitors.fbp),
         fbc = coalesce(excluded.fbc, visitors.fbc),
         ip = coalesce(excluded.ip, visitors.ip),
         ua = coalesce(excluded.ua, visitors.ua),
         first_attr = coalesce(visitors.first_attr, excluded.first_attr),
         last_attr = coalesce(excluded.last_attr, visitors.last_attr)`,
      [vid, fbp, fbc, ip, ua, Object.keys(first).length ? JSON.stringify(first) : null, Object.keys(attr).length ? JSON.stringify(attr) : null]
    );

    const type = b.t === 'wa' ? 'wa_click' : b.t === 'lead' ? 'form' : 'pageview';
    const code = type === 'wa_click' && isRefCode(b.code) ? b.code : null;

    await q(
      `insert into touches
        (visitor_id, type, ref_code, channel, url, referrer,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         ad_id, adset_id, campaign_id, fbclid, link_slug)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        vid, type, code, channel, url, referrer,
        attr.utm_source || null, attr.utm_medium || null, attr.utm_campaign || null,
        attr.utm_content || null, attr.utm_term || null,
        attr.ad_id || null, attr.adset_id || null, attr.campaign_id || null,
        attr.fbclid || null, attr.rp_l || null,
      ]
    );

    if (b.t === 'lead') {
      const r = await registerLead({
        source: 'formulario',
        phone: b.phone, email: b.email, name: clip(b.name, 120),
        form: { attr, url, referrer, visitorId: vid, fbc, fbp, ip, ua },
      });
      await afterLead(r);
      return res.status(200).json({ ok: true, lead: r ? r.lead.id : null });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('track:', e);
    return res.status(200).json({ ok: false }); // nunca quebra o site do cliente
  }
};
