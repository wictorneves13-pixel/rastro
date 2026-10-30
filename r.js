// /l/:slug → registra o clique e redireciona (WhatsApp com código de referência, ou URL com UTMs)
const { q } = require('../lib/db');
const { newRefCode, clientIp, clip } = require('../lib/util');

module.exports = async (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const rows = slug ? await q('select * from links where slug = $1', [slug]) : [];
    if (!rows.length) {
      res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send('Link não encontrado.');
    }
    const l = rows[0];
    const code = l.kind === 'whatsapp' ? newRefCode() : null;
    const utm = {
      utm_source: l.utm_source || l.channel || 'link',
      utm_medium: l.utm_medium || 'link',
      utm_campaign: l.utm_campaign || l.name,
    };

    // visitante anônimo só para esta passagem (o script do site cria o definitivo)
    const vid = 'l_' + newRefCode(10).toLowerCase();
    await q(
      `insert into touches (visitor_id, type, ref_code, channel, url, referrer, utm_source, utm_medium, utm_campaign, link_slug)
       values ($1, 'link_click', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [vid, code, l.channel || utm.utm_source, clip(req.url, 300), clip(req.headers.referer, 300), utm.utm_source, utm.utm_medium, utm.utm_campaign, slug]
    );
    // guarda IP/UA para a Meta casar a pessoa depois
    await q(`insert into visitors (id, ip, ua) values ($1, $2, $3) on conflict (id) do nothing`, [vid, clientIp(req), clip(req.headers['user-agent'], 300)]);
    await q('update links set clicks = clicks + 1 where slug = $1', [slug]);

    let dest;
    if (l.kind === 'whatsapp') {
      const text = `${l.wa_message || ''} (ref:${code})`.trim();
      dest = `https://wa.me/${String(l.wa_phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
    } else {
      const u = new URL(l.destination);
      for (const [k, v] of Object.entries(utm)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
      u.searchParams.set('rp_l', slug);
      dest = u.toString();
    }
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 302;
    res.setHeader('Location', dest);
    return res.end();
  } catch (e) {
    console.error('r:', e);
    res.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send('Erro ao abrir o link.');
  }
};
