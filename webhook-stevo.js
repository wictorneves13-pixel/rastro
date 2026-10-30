// POST /api/webhook-stevo?key=SEU_WEBHOOK_SECRET
// Recebe as mensagens do WhatsApp (Stevo), cria o lead com a origem e envia ao GHL e à Meta.
const { readBody, extractRef } = require('../lib/util');
const { checkWebhookKey } = require('../lib/auth');
const { parseStevo } = require('../lib/stevo');
const { registerLead, afterLead } = require('../lib/leads');
const { logHook } = require('../lib/hooks');

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: true, dica: 'Configure este endereço como webhook (POST) no Stevo.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  if (!checkWebhookKey(req)) return res.status(401).json({ error: 'chave inválida' });

  const payload = readBody(req);
  try {
    const m = parseStevo(payload);
    if (m.ignore) {
      await logHook('stevo', 'ignorado: ' + m.ignore, payload);
      return res.status(200).json({ ok: true, ignorado: m.ignore });
    }

    // O código (ref:XXXXXX) pode estar em qualquer parte do payload
    const refCode = extractRef(JSON.stringify(payload));

    const r = await registerLead({
      source: 'whatsapp',
      phone: m.phone, name: m.name, text: m.text,
      refCode, referral: m.referral,
    });
    if (!r) {
      await logHook('stevo', 'ignorado: lead_invalido', payload);
      return res.status(200).json({ ok: true, ignorado: 'lead_invalido' });
    }
    await afterLead(r);

    await logHook('stevo', `ok: lead ${r.lead.id} (${r.lead.origin}${r.isNew ? ', novo' : ''})`, payload);
    return res.status(200).json({ ok: true, lead: r.lead.id, origem: r.lead.origin, novo: r.isNew });
  } catch (e) {
    console.error('stevo:', e);
    await logHook('stevo', 'erro: ' + e.message, payload);
    return res.status(200).json({ ok: false, erro: e.message }); // 200 para o Stevo não reenviar em loop
  }
};
