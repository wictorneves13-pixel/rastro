const { q } = require('./db');

function safeJson(payload) {
  const s = JSON.stringify(payload || {});
  return s.length <= 60000 ? s : JSON.stringify({ _truncado: true, inicio: s.slice(0, 20000) });
}

// Guarda o payload cru dos últimos webhooks. A aba Integrações mostra esses registros,
// o que permite conferir o formato real enviado pelo Stevo/GHL.
async function logHook(source, status, payload) {
  try {
    await q('insert into webhook_logs (source, status, payload) values ($1, $2, $3::jsonb)', [
      source,
      String(status).slice(0, 200),
      safeJson(payload),
    ]);
    if (Math.random() < 0.05) {
      await q('delete from webhook_logs where id < (select coalesce(max(id), 0) - 300 from webhook_logs)');
    }
  } catch (e) {
    console.error('logHook:', e.message);
  }
}

module.exports = { logHook };
