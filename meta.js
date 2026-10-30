const { sha256 } = require('./util');

const GRAPH = 'https://graph.facebook.com/v21.0';

const env = (k) => (process.env[k] || '').trim();

function capiConfigured() {
  return !!(env('META_PIXEL_ID') && env('META_CAPI_TOKEN'));
}
function adsConfigured() {
  return !!(env('META_ADS_TOKEN') && env('META_AD_ACCOUNT_ID'));
}

// Nomes usados nos workflows do GHL → nomes de evento padrão da Meta
const EVENT_NAMES = {
  lead: 'Lead',
  contact: 'Contact',
  schedule: 'Schedule',
  checkout: 'InitiateCheckout',
  purchase: 'Purchase',
  won: 'Purchase',
};
function metaEventName(type) {
  const k = String(type || '').toLowerCase();
  return EVENT_NAMES[k] || String(type);
}

function buildUserData(lead) {
  const ud = {};
  if (lead.phone) ud.ph = [sha256(lead.phone)];
  if (lead.email) ud.em = [sha256(lead.email)];
  if (lead.name) {
    const parts = String(lead.name).trim().split(/\s+/);
    if (parts[0]) ud.fn = [sha256(parts[0])];
    if (parts.length > 1) ud.ln = [sha256(parts.slice(1).join(' '))];
  }
  ud.external_id = [sha256('lead_' + lead.id)];
  if (env('DEFAULT_COUNTRY_CODE') === '55' || !env('DEFAULT_COUNTRY_CODE')) ud.country = [sha256('br')];
  if (lead.fbc) ud.fbc = lead.fbc;
  else if (lead.fbclid) ud.fbc = `fb.1.${Date.parse(lead.created_at) || Date.now()}.${lead.fbclid}`;
  if (lead.fbp) ud.fbp = lead.fbp;
  if (lead.ip) ud.client_ip_address = lead.ip;
  if (lead.ua) ud.client_user_agent = lead.ua;
  return ud;
}

// Monta o evento no formato da API de Conversões (sem enviar). Útil para testes.
function buildEvent(lead, o) {
  const ud = buildUserData(lead);
  const ev = {
    event_name: metaEventName(o.type),
    event_time: Math.floor((o.time || Date.now()) / 1000),
    event_id: o.eventId,
    user_data: ud,
    custom_data: {},
  };
  if (o.value !== undefined && o.value !== null) {
    ev.custom_data.value = Number(o.value);
    ev.custom_data.currency = o.currency || env('CURRENCY') || 'BRL';
  }
  if (lead.ctwa_clid && env('META_WABA_ID')) {
    // Conversões de mensagens: liga a venda ao clique no anúncio de WhatsApp
    ev.action_source = 'business_messaging';
    ev.messaging_channel = 'whatsapp';
    ud.ctwa_clid = lead.ctwa_clid;
    ud.whatsapp_business_account_id = env('META_WABA_ID');
  } else if (lead.origin === 'site' && lead.landing_url) {
    ev.action_source = 'website';
    ev.event_source_url = lead.landing_url;
  } else {
    ev.action_source = 'chat';
  }
  return ev;
}

async function sendEvent(lead, o) {
  if (!capiConfigured()) return { skipped: 'meta_nao_configurada' };
  const ev = buildEvent(lead, o);
  const payload = { data: [ev], access_token: env('META_CAPI_TOKEN') };
  if (env('META_TEST_EVENT_CODE')) payload.test_event_code = env('META_TEST_EVENT_CODE');
  const r = await fetch(`${GRAPH}/${env('META_PIXEL_ID')}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, response: j, event: ev.event_name, action_source: ev.action_source, test: !!payload.test_event_code };
}

async function graphGet(path, params = {}) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + env('META_ADS_TOKEN') } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Erro ' + r.status + ' na Meta');
  return j;
}

// Descobre nome do anúncio/conjunto/campanha a partir do ad_id (vem do anúncio de WhatsApp)
async function resolveAd(adId) {
  if (!env('META_ADS_TOKEN') || !/^\d+$/.test(String(adId || ''))) return null;
  try {
    const j = await graphGet('/' + adId, { fields: 'name,adset{id,name},campaign{id,name}' });
    return {
      ad_name: j.name || null,
      adset_id: j.adset && j.adset.id, adset_name: j.adset && j.adset.name,
      campaign_id: j.campaign && j.campaign.id, campaign_name: j.campaign && j.campaign.name,
    };
  } catch (e) {
    return null;
  }
}

// Gasto por anúncio no período (since/until = YYYY-MM-DD)
async function adInsights(since, until) {
  if (!adsConfigured()) return [];
  const acct = env('META_AD_ACCOUNT_ID').replace(/^act_/, '');
  let json = await graphGet(`/act_${acct}/insights`, {
    level: 'ad',
    fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
  });
  const rows = [...(json.data || [])];
  for (let i = 0; i < 5 && json.paging && json.paging.next; i++) {
    const r = await fetch(json.paging.next, { headers: { Authorization: 'Bearer ' + env('META_ADS_TOKEN') } });
    json = await r.json();
    rows.push(...(json.data || []));
  }
  return rows;
}

module.exports = { capiConfigured, adsConfigured, buildEvent, sendEvent, resolveAd, adInsights, metaEventName };
