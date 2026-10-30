const crypto = require('crypto');
const { q } = require('./db');
const { normalizePhone, classifyChannel } = require('./util');
const meta = require('./meta');
const ghl = require('./ghl');

const LEAD_ATTR_COLS = [
  'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ad_id', 'adset_id', 'campaign_id', 'ad_headline', 'ad_source_url',
  'fbclid', 'fbc', 'fbp', 'ctwa_clid', 'ip', 'ua', 'landing_url', 'ref_code', 'link_slug', 'visitor_id',
];

function pickLeadAttr(a) {
  const out = {};
  for (const k of LEAD_ATTR_COLS) if (a[k] !== undefined && a[k] !== null && a[k] !== '') out[k] = a[k];
  return out;
}

// ───────── Eventos da linha do tempo ─────────
async function addEvent(leadId, type, data = {}) {
  await q('insert into events (lead_id, type, data) values ($1, $2, $3::jsonb)', [leadId, type, JSON.stringify(data)]);
}

// ───────── Acesso a leads ─────────
async function findLead({ phone, email }) {
  if (phone) {
    const r = await q('select * from leads where phone = $1', [phone]);
    if (r[0]) return r[0];
  }
  if (email) {
    const r = await q('select * from leads where lower(email) = lower($1) order by id desc limit 1', [email]);
    if (r[0]) return r[0];
  }
  return null;
}

async function insertLead(row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined && row[k] !== null);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await q(
    `insert into leads (${cols}) values (${ph}) on conflict (phone) do nothing returning *`,
    keys.map((k) => row[k])
  );
  return rows[0] || null;
}

async function updateLead(id, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  await q(`update leads set ${set}, updated_at = now() where id = $${keys.length + 1}`, [...keys.map((k) => patch[k]), id]);
}

// ───────── Fontes de atribuição ─────────

// 1) Código (ref:XXXXXX) enviado na mensagem → clique registrado pelo script do site ou link rastreado
async function attrFromRef(code) {
  const t = (await q('select * from touches where ref_code = $1 order by created_at desc limit 1', [code]))[0];
  if (!t) return null;
  let v = null;
  if (t.visitor_id) v = (await q('select * from visitors where id = $1', [t.visitor_id]))[0] || null;
  return {
    origin: t.type === 'link_click' ? 'link' : 'site',
    channel: t.channel,
    utm_source: t.utm_source, utm_medium: t.utm_medium, utm_campaign: t.utm_campaign,
    utm_content: t.utm_content, utm_term: t.utm_term,
    ad_id: t.ad_id, adset_id: t.adset_id, campaign_id: t.campaign_id,
    fbclid: t.fbclid,
    link_slug: t.link_slug,
    landing_url: t.url,
    visitor_id: t.visitor_id,
    ref_code: code,
    fbc: v && v.fbc, fbp: v && v.fbp, ip: v && v.ip, ua: v && v.ua,
  };
}

// 2) Anúncio de clique para WhatsApp (referral com ctwa_clid / source_id)
async function attrFromReferral(ref) {
  const a = {
    origin: 'ctwa',
    channel: 'meta',
    utm_source: 'facebook',
    utm_medium: 'paid',
    ad_id: ref.source_id,
    ctwa_clid: ref.ctwa_clid,
    ad_headline: ref.headline,
    ad_source_url: ref.source_url,
  };
  const info = await meta.resolveAd(ref.source_id);
  if (info) {
    a.utm_campaign = info.campaign_name;
    a.utm_term = info.adset_name;
    a.utm_content = info.ad_name;
    a.campaign_id = info.campaign_id;
    a.adset_id = info.adset_id;
  }
  return a;
}

// 3) Formulário do site (script envia first/last touch do visitante)
function attrFromForm(f) {
  const a = f.attr || {};
  return {
    origin: 'site',
    channel: classifyChannel(a, f.referrer),
    utm_source: a.utm_source, utm_medium: a.utm_medium, utm_campaign: a.utm_campaign,
    utm_content: a.utm_content, utm_term: a.utm_term,
    ad_id: a.ad_id, adset_id: a.adset_id, campaign_id: a.campaign_id,
    fbclid: a.fbclid,
    link_slug: a.rp_l,
    landing_url: f.url,
    visitor_id: f.visitorId,
    fbc: f.fbc, fbp: f.fbp, ip: f.ip, ua: f.ua,
  };
}

// ───────── Cadastro / atualização de lead ─────────
// input: { source, phone, email, name, text, refCode, referral, form, ghlContactId, stage }
async function registerLead(i) {
  const phone = normalizePhone(i.phone);
  const email = i.email ? String(i.email).trim().toLowerCase() : null;
  if (!phone && !email) return null;

  let attr = null;
  if (i.refCode) attr = await attrFromRef(i.refCode);
  if (!attr && i.referral && (i.referral.ctwa_clid || i.referral.source_id)) attr = await attrFromReferral(i.referral);
  if (!attr && i.form) attr = attrFromForm(i.form);

  let lead = await findLead({ phone, email });

  if (!lead) {
    const created = await insertLead({
      phone, email, name: i.name || null,
      origin: attr ? attr.origin : 'direct',
      ...(attr ? pickLeadAttr(attr) : {}),
      first_message: i.text ? String(i.text).slice(0, 300) : null,
      ghl_contact_id: i.ghlContactId || null,
      stage: i.stage || null,
    });
    if (created) {
      await addEvent(created.id, 'lead_created', {
        fonte: i.source,
        origem: created.origin,
        ref_code: attr && attr.ref_code,
        ad_id: attr && attr.ad_id,
        mensagem: i.text ? String(i.text).slice(0, 140) : undefined,
      });
      return { lead: created, isNew: true, attributed: !!attr };
    }
    lead = await findLead({ phone, email }); // outra requisição criou no mesmo instante
    if (!lead) return null;
  }

  const patch = {};
  if (!lead.name && i.name) patch.name = i.name;
  if (!lead.email && email) patch.email = email;
  if (!lead.phone && phone) patch.phone = phone;
  if (!lead.ghl_contact_id && i.ghlContactId) patch.ghl_contact_id = i.ghlContactId;
  if (i.stage) patch.stage = i.stage;
  let attributed = false;
  if (attr && (!lead.origin || lead.origin === 'direct')) {
    Object.assign(patch, pickLeadAttr(attr), { origin: attr.origin });
    attributed = true;
  }
  if (Object.keys(patch).length) {
    await updateLead(lead.id, patch);
    lead = { ...lead, ...patch };
  }
  if (attributed) {
    await addEvent(lead.id, 'attribution_set', { origem: attr.origin, ref_code: attr.ref_code, ad_id: attr.ad_id });
  }
  return { lead, isNew: false, attributed };
}

// ───────── Envios ─────────
async function sendMeta(lead, type, o = {}) {
  const eventId = `${String(type).toLowerCase()}_${lead.id}_${crypto.randomUUID().slice(0, 8)}`;
  try {
    const r = await meta.sendEvent(lead, { type, eventId, ...o });
    if (r.skipped) return r;
    await addEvent(lead.id, r.ok ? 'meta_sent' : 'meta_error', {
      evento: r.event,
      action_source: r.action_source,
      valor: o.value,
      teste: r.test || undefined,
      status: r.status,
      resposta: r.ok
        ? { events_received: r.response.events_received, fbtrace_id: r.response.fbtrace_id }
        : r.response,
    });
    return r;
  } catch (e) {
    await addEvent(lead.id, 'meta_error', { evento: type, erro: e.message });
    return { ok: false, error: e.message };
  }
}

async function syncGhl(lead) {
  try {
    const g = await ghl.upsertContact(lead);
    if (g.skipped) return g;
    await addEvent(lead.id, g.ok ? 'ghl_sync' : 'ghl_error', {
      contact_id: g.contactId, criado: g.created, status: g.status, erro: g.error,
    });
    if (g.ok && g.contactId && g.contactId !== lead.ghl_contact_id) {
      await updateLead(lead.id, { ghl_contact_id: g.contactId });
    }
    return g;
  } catch (e) {
    await addEvent(lead.id, 'ghl_error', { erro: e.message });
    return { ok: false, error: e.message };
  }
}

// Depois de registrar um lead vindo do WhatsApp/site: manda a origem ao GHL e o Lead à Meta.
async function afterLead(r, opts = {}) {
  if (!r) return;
  const { lead } = r;
  if (opts.ghl !== false && (r.isNew || r.attributed)) await syncGhl(lead);
  if (opts.meta !== false && r.isNew) await sendMeta(lead, 'lead');
}

// Registra uma compra: soma receita, marca como cliente e avisa a Meta.
async function recordPurchase(lead, value, extra = {}) {
  const v = Number.isFinite(value) ? value : 0;
  await q(
    `update leads set status = 'won', revenue = revenue + $2, sales_count = sales_count + 1, updated_at = now() where id = $1`,
    [lead.id, v]
  );
  await addEvent(lead.id, 'purchase', { value: v, currency: process.env.CURRENCY || 'BRL', ...extra });
  const fresh = (await q('select * from leads where id = $1', [lead.id]))[0] || lead;
  if (extra.meta !== false) await sendMeta(fresh, 'purchase', { value: v });
  return fresh;
}

module.exports = {
  addEvent, findLead, updateLead, registerLead, afterLead, sendMeta, syncGhl, recordPurchase,
};
