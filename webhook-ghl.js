// POST /api/webhook-ghl?key=SEU_WEBHOOK_SECRET&event=purchase
// Use uma ação "Webhook" nos workflows do GHL, uma URL por evento:
//   event=lead      contato criado/qualificado
//   event=stage     mudou de etapa no funil (envie o nome da etapa)
//   event=schedule  agendou
//   event=purchase  comprou / oportunidade ganha (envie o valor)
// Qualquer outro nome vira um evento personalizado na Meta.
const { q } = require('../lib/db');
const { readBody, findDeep, parseMoney } = require('../lib/util');
const { checkWebhookKey } = require('../lib/auth');
const { registerLead, addEvent, updateLead, sendMeta, recordPurchase } = require('../lib/leads');
const { logHook } = require('../lib/hooks');

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: true, dica: 'Use POST a partir de um workflow do GHL.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  if (!checkWebhookKey(req)) return res.status(401).json({ error: 'chave inválida' });

  const p = readBody(req);
  try {
    const event = String(req.query.event || findDeep(p, ['rp_event', 'event']) || 'lead').trim().toLowerCase();

    const phone = findDeep(p, ['phone', 'Phone', 'telefone']);
    const email = findDeep(p, ['email', 'Email']);
    const name = str(findDeep(p, ['full_name', 'fullName', 'contact_name', 'contactName'])) ||
      [findDeep(p, ['first_name', 'firstName']), findDeep(p, ['last_name', 'lastName'])].filter(Boolean).join(' ') || null;
    const contactId = str(findDeep(p, ['contact_id', 'contactId']));
    const oppId = str(findDeep(p, ['opportunity_id', 'opportunityId']));
    const stage = str(findDeep(p, ['stage', 'pipleline_stage', 'pipeline_stage', 'stage_name', 'pipelineStageName', 'pipeline_stage_name']));
    const value = parseMoney(req.query.value) ?? parseMoney(findDeep(p, ['value', 'monetaryValue', 'monetary_value', 'lead_value', 'valor', 'amount']));

    const r = await registerLead({ source: 'ghl', phone, email, name, ghlContactId: contactId, stage: event === 'stage' ? stage : undefined });
    if (!r) {
      await logHook('ghl', `ignorado (${event}): sem telefone/e-mail`, p);
      return res.status(200).json({ ok: true, ignorado: 'sem_telefone_ou_email' });
    }
    let lead = r.lead;

    // evitar duplicar a mesma oportunidade
    if (oppId && (event === 'purchase' || event === 'won')) {
      const dup = await q(`select 1 from events where lead_id = $1 and type = 'purchase' and data->>'oportunidade' = $2 limit 1`, [lead.id, oppId]);
      if (dup.length) {
        await logHook('ghl', `duplicado (${event}): oportunidade ${oppId}`, p);
        return res.status(200).json({ ok: true, duplicado: true });
      }
    }

    if (event === 'lead') {
      // nada além do cadastro
    } else if (event === 'stage') {
      await addEvent(lead.id, 'stage_change', { etapa: stage });
      if (stage) await updateLead(lead.id, { stage });
    } else if (event === 'purchase' || event === 'won') {
      lead = await recordPurchase(lead, value ?? 0, { oportunidade: oppId || undefined, etapa: stage || undefined });
    } else {
      await addEvent(lead.id, 'crm_event', { evento: event, etapa: stage, valor: value ?? undefined });
      await sendMeta(lead, event, value != null ? { value } : {});
    }

    await logHook('ghl', `ok (${event}): lead ${lead.id}`, p);
    return res.status(200).json({ ok: true, lead: lead.id, evento: event });
  } catch (e) {
    console.error('ghl:', e);
    await logHook('ghl', 'erro: ' + e.message, p);
    return res.status(200).json({ ok: false, erro: e.message });
  }
};
