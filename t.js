/*!
 * Rastro · script de rastreio
 * Cole no <head> do site:
 *   <script async src="https://SEU-DOMINIO/t.js" data-forms></script>
 *
 * O que faz:
 *  1. Guarda de onde o visitante veio (UTMs, ad_id, fbclid) e registra a visita.
 *  2. Em todo botão/link de WhatsApp, acrescenta um código (ref:XXXXXX) à mensagem.
 *     Quando a pessoa envia a mensagem, o webhook do WhatsApp lê o código e liga
 *     a conversa ao anúncio que trouxe a visita.
 *  3. (opcional, atributo data-forms) captura formulários com telefone/e-mail.
 *
 * Atributos opcionais no <script>:
 *   data-text="Olá! Vim pelo site..."   mensagem padrão quando o link não tem texto
 *   data-endpoint="https://.../api/track"
 *   data-forms                          captura formulários automaticamente
 */
(function () {
  'use strict';
  if (window.RP && window.RP._loaded) return;

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) if (/\/t\.js(\?|$)/.test(all[i].src)) { script = all[i]; break; }
  }
  var attr = function (n) { return script && script.getAttribute(n); };
  var ENDPOINT = attr('data-endpoint') || (script && script.src ? new URL(script.src).origin + '/api/track' : '/api/track');
  var DEFAULT_TEXT = attr('data-text') || 'Olá! Vim pelo site e gostaria de mais informações.';
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ad_id', 'adset_id', 'campaign_id', 'fbclid', 'gclid', 'rp_l'];
  var LAST_TTL = 30 * 24 * 3600 * 1000;

  // ───────── armazenamento (localStorage com cookie de reserva) ─────────
  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(n, v, days) {
    try {
      document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=' + days * 86400 + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) { /* ignora */ }
  }
  function read(k) {
    try { var v = localStorage.getItem(k); if (v) return v; } catch (e) { /* ignora */ }
    return getCookie(k);
  }
  function write(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* ignora */ }
    setCookie(k, v, 365);
  }
  function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  function rid(n) {
    var out = '';
    try {
      var a = new Uint8Array(n);
      (window.crypto || window.msCrypto).getRandomValues(a);
      for (var i = 0; i < n; i++) out += ('0' + a[i].toString(16)).slice(-2);
      return out;
    } catch (e) {
      for (var j = 0; j < n; j++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
      return out;
    }
  }
  var ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function refCode() {
    var out = '';
    var bytes;
    try { bytes = new Uint8Array(6); (window.crypto || window.msCrypto).getRandomValues(bytes); } catch (e) { bytes = null; }
    for (var i = 0; i < 6; i++) out += ALPHA.charAt((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % ALPHA.length);
    return out;
  }

  // ───────── visitante e origem ─────────
  var vid = read('rp_vid');
  if (!vid) { vid = rid(12); write('rp_vid', vid); }

  function currentParams() {
    var out = {}, has = false;
    try {
      var sp = new URLSearchParams(location.search);
      for (var i = 0; i < KEYS.length; i++) {
        var v = sp.get(KEYS[i]);
        if (v) { out[KEYS[i]] = v.slice(0, 200); has = true; }
      }
    } catch (e) { /* ignora */ }
    return has ? out : null;
  }

  var first = parse(read('rp_first'));
  var last = parse(read('rp_last'));
  if (last && last._t && Date.now() - last._t > LAST_TTL) last = null;
  var cur = currentParams();
  if (cur) {
    cur._t = Date.now();
    last = cur;
    write('rp_last', JSON.stringify(cur));
    if (!first) { first = cur; write('rp_first', JSON.stringify(cur)); }
  }

  // _fbc: formato exigido pela Meta quando há fbclid na URL
  if (cur && cur.fbclid) {
    var existing = getCookie('_fbc');
    if (!existing || existing.split('.').pop() !== cur.fbclid) {
      setCookie('_fbc', 'fb.1.' + Date.now() + '.' + cur.fbclid, 90);
    }
  }

  function payload(t, extra) {
    var p = {
      t: t,
      v: vid,
      url: location.href.slice(0, 600),
      ref: (document.referrer || '').slice(0, 600),
      a: last || {},
      f: first || {},
      fbp: getCookie('_fbp') || undefined,
      fbc: getCookie('_fbc') || undefined,
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) p[k] = extra[k];
    return p;
  }

  function send(p) {
    var body = JSON.stringify(p);
    try {
      if (window.fetch) {
        fetch(ENDPOINT, {
          method: 'POST', body: body, keepalive: true, mode: 'cors', credentials: 'omit',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        }).catch(function () { /* ignora */ });
        return;
      }
    } catch (e) { /* tenta o beacon */ }
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } catch (e) { /* ignora */ }
  }

  // ───────── links de WhatsApp ─────────
  var CODE = refCode();
  var TAG = '(ref:' + CODE + ')';

  function isWa(h) {
    return /^(?:https?:)?\/\/(?:wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send)|^whatsapp:\/\/send/i.test(h || '');
  }

  function tagLink(a) {
    var href = a.getAttribute('href');
    if (!isWa(href)) return false;
    var dec = href;
    try { dec = decodeURIComponent(href.replace(/\+/g, ' ')); } catch (e) { /* ignora */ }
    if (dec.indexOf(TAG) > -1) return true;
    try {
      var u = new URL(href, location.href);
      var text = (u.searchParams.get('text') || '').replace(/\s*\(ref:[A-Z0-9]{6}\)/g, '').trim();
      u.searchParams.set('text', (text || DEFAULT_TEXT) + ' ' + TAG);
      a.setAttribute('href', u.toString());
    } catch (e) { return false; }
    return true;
  }

  function scan() {
    var as = document.querySelectorAll('a[href]');
    for (var i = 0; i < as.length; i++) tagLink(as[i]);
  }

  function onClick(e) {
    var el = e.target;
    while (el && el !== document && !(el.tagName === 'A' && el.hasAttribute('href'))) el = el.parentNode;
    if (!el || el === document) return;
    if (tagLink(el)) send(payload('wa', { code: CODE }));
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  if (window.MutationObserver) {
    var timer;
    new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(scan, 200); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }

  // ───────── formulários ─────────
  function lead(d) {
    d = d || {};
    if (!d.phone && !d.email) return;
    send(payload('lead', { name: d.name, phone: d.phone, email: d.email }));
  }

  function field(form, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = form.querySelector(selectors[i]);
      if (el && el.value && String(el.value).trim()) return String(el.value).trim();
    }
    return '';
  }

  if (script && script.hasAttribute('data-forms')) {
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || !f.querySelector) return;
      lead({
        phone: field(f, ['input[type=tel]', '[name*=phone i]', '[name*=telefone i]', '[name*=whats i]', '[name*=celular i]']),
        email: field(f, ['input[type=email]', '[name*=mail i]']),
        name: field(f, ['[name*=nome i]', '[name*=name i]']),
      });
    }, true);
  }

  window.RP = { _loaded: true, id: vid, code: CODE, lead: lead, scan: scan };

  send(payload('pv'));
})();
