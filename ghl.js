const { originLabel } = require('./util');

const BASE = 'https://services.leadconnectorhq.com';
const env = (k) => (process.env[k] || '').trim();

function configured() {
  return !!(env('GHL_TOKEN') && env('GHL_LOCATION_ID'));
}

function customFieldMap() {
  try { return JSON.parse(env('GHL_CUSTOM_FIELDS') || '{}'); } catch { return {}; }
}

// Cria ou atualiza o contato no GHL (por telefone/e-mail) com a origem do lead.
async function upsertContact(lead) {
  if (!configured()) return { skipped: 'ghl_nao_configurado' };

  const values = {
    origem: originLabel(lead.origin),
    canal: lead.channel,
    campanha: lead.utm_campaign,
    conjunto: lead.utm_term,
    anuncio: lead.utm_content || lead.ad_headline,
    ad_id: lead.ad_id,
    ctwa_clid: lead.ctwa_clid,
    pagina: lead.landing_url,
  };
  const map = customFieldMap();
  const customFields = Object.entries(map)
    .filter(([k, id]) => id && values[k])
    .map(([k, id]) => ({ id, field_value: String(values[k]) }));

  const tags = ['origem:' + (lead.origin || 'direct')];
  if (lead.channel) tags.push('canal:' + lead.channel);

  const body = {
    locationId: env('GHL_LOCATION_ID'),
    source: 'Rastro · ' + originLabel(lead.origin),
    tags,
  };
  if (lead.phone) body.phone = '+' + lead.phone;
  if (lead.email) body.email = lead.email;
  if (lead.name) body.name = lead.name;
  if (customFields.length) body.customFields = customFields;

  const r = await fetch(BASE + '/contacts/upsert', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env('GHL_TOKEN'),
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  const contactId = (j.contact && j.contact.id) || j.id || null;
  return {
    ok: r.ok,
    status: r.status,
    contactId,
    created: j.new,
    error: r.ok ? undefined : (j.message || j.error || 'erro ' + r.status),
  };
}

module.exports = { configured, upsertContact, customFieldMap };
