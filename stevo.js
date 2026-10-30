// Lê o payload que o Stevo envia no webhook de mensagens.
// O formato exato varia conforme a versão/configuração, então a leitura é tolerante:
// procura as chaves conhecidas em qualquer nível do JSON. O que não for reconhecido
// fica visível na aba Integrações (últimos webhooks recebidos) para ajustar.
const { normalizePhone, findDeep, collectValues, truthy } = require('./util');

const PHONE_KEYS = [
  'senderPn', 'SenderPn', 'remoteJidAlt', 'SenderAlt', 'senderAlt', 'participantPn',
  'remoteJid', 'RemoteJid', 'remote_jid', 'Chat', 'chat', 'chatId', 'chat_id',
  'Sender', 'sender', 'from', 'From', 'jid', 'Jid', 'phone', 'Phone', 'number', 'Number',
];
const NAME_KEYS = ['pushName', 'PushName', 'push_name', 'notifyName', 'senderName', 'SenderName'];
const TEXT_KEYS = ['conversation', 'Conversation', 'text', 'Text', 'caption', 'Caption', 'body', 'Body'];
const CTWA_KEYS = ['ctwa_clid', 'ctwaClid', 'CtwaClid', 'CTWAClid', 'ctwaclid'];

function parseStevo(p) {
  const evt = String(findDeep(p, ['event', 'Event', 'eventType', 'type', 'Type']) || '');

  if (truthy(findDeep(p, ['fromMe', 'FromMe', 'from_me', 'IsFromMe', 'isFromMe']))) return { ignore: 'mensagem_enviada_por_voce' };
  if (truthy(findDeep(p, ['isGroup', 'IsGroup']))) return { ignore: 'grupo' };
  if (/(receipt|presence|ack|connect|disconnect|qr|call|history|status)/i.test(evt) && !/message/i.test(evt)) {
    return { ignore: 'evento:' + evt };
  }

  let phone = null;
  let sawGroup = false;
  let sawLid = false;
  for (const c of collectValues(p, PHONE_KEYS)) {
    const s = String(c);
    if (s.includes('@g.us')) { sawGroup = true; continue; }
    if (s.includes('@lid')) { sawLid = true; continue; }
    if (s.includes('@broadcast') || s.includes('status@')) continue;
    const n = normalizePhone(s);
    if (n) { phone = n; break; }
  }
  if (!phone) return { ignore: sawGroup ? 'grupo' : sawLid ? 'contato_lid_sem_telefone' : 'sem_telefone' };

  const name = findDeep(p, NAME_KEYS) || null;
  const textRaw = findDeep(p, TEXT_KEYS);
  const text = typeof textRaw === 'string' ? textRaw : null;

  // Dados do anúncio (clique para WhatsApp)
  const refObj = findDeep(p, ['referral', 'Referral', 'externalAdReply', 'ExternalAdReply'], { object: true });
  const scope = refObj || {};
  const ctwa = findDeep(scope, CTWA_KEYS) || findDeep(p, CTWA_KEYS) || null;
  const sourceId = findDeep(scope, ['source_id', 'sourceId', 'SourceID', 'SourceId']) || null;
  const sourceType = findDeep(scope, ['source_type', 'sourceType', 'SourceType']) || null;

  let referral = null;
  if (ctwa || sourceId) {
    // "url" = apenas prévia de link, não é anúncio
    if (ctwa || !/^url$/i.test(String(sourceType || ''))) {
      referral = {
        ctwa_clid: ctwa ? String(ctwa) : null,
        source_id: sourceId ? String(sourceId) : null,
        source_type: sourceType ? String(sourceType) : null,
        source_url: findDeep(scope, ['source_url', 'sourceUrl', 'SourceURL', 'SourceUrl']) || null,
        headline: findDeep(scope, ['headline', 'Headline', 'title', 'Title']) || null,
        body: findDeep(scope, ['body', 'Body']) || null,
      };
    }
  }

  return { phone, name, text, referral };
}

module.exports = { parseStevo };
