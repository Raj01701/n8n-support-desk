/**
 * Harbourly support chat widget.
 *
 * One <script> tag, no dependencies, no build step, no iframe:
 *
 *   <script src="/chat-widget.js"
 *           data-endpoint="https://n8n.example.com/webhook/chat/message"
 *           data-secret="the value of CHAT_WEBHOOK_SECRET"
 *           data-title="Harbourly Support"
 *           data-greeting="Ask me anything about invoices, plans or your account."
 *           defer></script>
 *
 * It posts { session_id, message, page_url, visitor_email? } to workflow 02 and
 * renders whatever comes back in the same response. The session id lives in
 * localStorage so a visitor who reloads the page keeps their conversation, and
 * so workflow 02 can load the earlier turns out of Postgres.
 *
 * A note on data-secret, because it is the obvious objection: this is a
 * client-side script, so the value is readable by anyone who views source. It
 * is a throttle on drive-by posting, not authentication. The real protections
 * are that the endpoint can only ever read from a public knowledge base, that
 * every request is logged, and that you rate limit the path at your proxy. See
 * docs/setup.md.
 */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    return all[all.length - 1];
  })();

  var ENDPOINT = script.getAttribute('data-endpoint');
  if (!ENDPOINT) {
    console.error('[chat-widget] data-endpoint is required');
    return;
  }
  var SECRET = script.getAttribute('data-secret') || '';
  var TITLE = script.getAttribute('data-title') || 'Support';
  var SUBTITLE = script.getAttribute('data-subtitle') || 'Typically replies instantly';
  var GREETING = script.getAttribute('data-greeting') || 'Hi. Ask me anything and I will answer from our help centre.';
  var ACCENT = script.getAttribute('data-accent') || '#6d8cff';
  var STORAGE_KEY = 'harbourly-chat-session';

  /* ------------------------------------------------------------- session */
  function sessionId() {
    var existing;
    try {
      existing = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      existing = null; // private browsing, or storage disabled
    }
    if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing;

    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var fresh = 'sess-';
    for (var i = 0; i < bytes.length; i++) fresh += (bytes[i] % 36).toString(36);
    try {
      window.localStorage.setItem(STORAGE_KEY, fresh);
    } catch (err) {
      /* the conversation then lasts one page view, which is still a conversation */
    }
    return fresh;
  }
  var SESSION = sessionId();

  /* ----------------------------------------------------------------- css */
  var css = [
    '.hb-root{position:fixed;right:20px;bottom:20px;z-index:2147483000;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;color:#e8ebf2}',
    '.hb-bubble{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:linear-gradient(145deg,#2b3550,#161b2b);box-shadow:0 12px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;transition:transform .18s ease}',
    '.hb-bubble:hover{transform:translateY(-2px) scale(1.04)}',
    '.hb-bubble svg{width:24px;height:24px;stroke:' + ACCENT + ';fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    '.hb-panel{position:absolute;right:0;bottom:72px;width:370px;max-width:calc(100vw - 32px);height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;overflow:hidden;border-radius:16px;background:#11141f;border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 70px rgba(0,0,0,.55)}',
    '.hb-root[data-open="1"] .hb-panel{display:flex}',
    '.hb-head{padding:16px 18px;background:linear-gradient(140deg,#1b2236,#12151f);border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:11px}',
    '.hb-dot{width:9px;height:9px;border-radius:50%;background:#46d08a;box-shadow:0 0 0 3px rgba(70,208,138,.16);flex:0 0 auto}',
    '.hb-title{font-weight:640;letter-spacing:-.01em}',
    '.hb-sub{font-size:12px;color:#8b93a8;margin-top:1px}',
    '.hb-close{margin-left:auto;background:none;border:0;color:#8b93a8;font-size:22px;line-height:1;cursor:pointer;padding:0 2px}',
    '.hb-close:hover{color:#e8ebf2}',
    '.hb-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:11px;scrollbar-width:thin;scrollbar-color:#2a3145 transparent}',
    '.hb-log::-webkit-scrollbar{width:7px}.hb-log::-webkit-scrollbar-thumb{background:#2a3145;border-radius:4px}',
    '.hb-msg{max-width:86%;padding:10px 13px;border-radius:13px;white-space:pre-wrap;word-wrap:break-word;animation:hb-in .22s ease both}',
    '@keyframes hb-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.hb-agent{align-self:flex-start;background:#1b2030;border:1px solid rgba(255,255,255,.06);border-bottom-left-radius:4px}',
    '.hb-visitor{align-self:flex-end;background:' + ACCENT + ';color:#0d1020;font-weight:500;border-bottom-right-radius:4px}',
    '.hb-meta{align-self:flex-start;font-size:11.5px;color:#7a8299;padding-left:3px;margin-top:-5px}',
    '.hb-typing{align-self:flex-start;display:flex;gap:4px;padding:13px 14px;background:#1b2030;border:1px solid rgba(255,255,255,.06);border-radius:13px;border-bottom-left-radius:4px}',
    '.hb-typing i{width:6px;height:6px;border-radius:50%;background:#79839d;animation:hb-bounce 1.15s infinite ease-in-out}',
    '.hb-typing i:nth-child(2){animation-delay:.15s}.hb-typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes hb-bounce{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}',
    '.hb-form{display:flex;gap:9px;padding:13px;border-top:1px solid rgba(255,255,255,.07);background:#0e111a}',
    '.hb-input{flex:1;background:#171c2a;border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:10px 12px;color:#e8ebf2;font:inherit;outline:none;resize:none;max-height:110px}',
    '.hb-input:focus{border-color:' + ACCENT + '}',
    '.hb-send{background:' + ACCENT + ';border:0;border-radius:10px;width:40px;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.hb-send:disabled{opacity:.4;cursor:default}',
    '.hb-send svg{width:17px;height:17px;stroke:#0d1020;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '@media (max-width:420px){.hb-root{right:12px;bottom:12px}.hb-panel{bottom:66px}}',
  ].join('');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------------------------------------------------------------- dom */
  var root = document.createElement('div');
  root.className = 'hb-root';
  root.setAttribute('data-open', '0');
  root.innerHTML =
    '<div class="hb-panel" role="dialog" aria-label="' + TITLE + '">' +
    '  <div class="hb-head">' +
    '    <span class="hb-dot"></span>' +
    '    <div><div class="hb-title"></div><div class="hb-sub"></div></div>' +
    '    <button class="hb-close" aria-label="Close chat">&times;</button>' +
    '  </div>' +
    '  <div class="hb-log" role="log" aria-live="polite"></div>' +
    '  <form class="hb-form">' +
    '    <textarea class="hb-input" rows="1" placeholder="Type your question…" aria-label="Your message"></textarea>' +
    '    <button class="hb-send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M4 12h15M13 6l6 6-6 6"/></svg></button>' +
    '  </form>' +
    '</div>' +
    '<button class="hb-bubble" aria-label="Open support chat">' +
    '  <svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 1 1 21 12z"/></svg>' +
    '</button>';
  document.body.appendChild(root);

  var panel = root.querySelector('.hb-panel');
  var log = root.querySelector('.hb-log');
  var form = root.querySelector('.hb-form');
  var input = root.querySelector('.hb-input');
  var sendBtn = root.querySelector('.hb-send');
  root.querySelector('.hb-title').textContent = TITLE;
  root.querySelector('.hb-sub').textContent = SUBTITLE;

  /* -------------------------------------------------------------- render */
  function bubble(role, text) {
    var el = document.createElement('div');
    el.className = 'hb-msg ' + (role === 'visitor' ? 'hb-visitor' : 'hb-agent');
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function meta(text) {
    var el = document.createElement('div');
    el.className = 'hb-meta';
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function typing(on) {
    var existing = log.querySelector('.hb-typing');
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var el = document.createElement('div');
    el.className = 'hb-typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  bubble('agent', GREETING);

  /* --------------------------------------------------------------- send */
  var busy = false;

  async function send(text) {
    busy = true;
    sendBtn.disabled = true;
    bubble('visitor', text);
    typing(true);

    var started = Date.now();
    try {
      var res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chat-secret': SECRET },
        body: JSON.stringify({
          session_id: SESSION,
          message: text,
          page_url: location.href,
        }),
      });

      var data = null;
      try {
        data = await res.json();
      } catch (err) {
        data = null;
      }
      typing(false);

      if (!res.ok || !data || !data.reply) {
        bubble('agent', 'Sorry - something went wrong on our side. Please email support and we will pick it up there.');
        return;
      }

      bubble('agent', data.reply);
      meta(
        (data.handed_to_human ? 'Passed to a person' : 'Answered from the help centre') +
          ' · ' + (Date.now() - started) + 'ms',
      );
    } catch (err) {
      typing(false);
      bubble('agent', 'Sorry - I could not reach support just now. Please try again in a moment.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  /* -------------------------------------------------------------- events */
  function open(state) {
    root.setAttribute('data-open', state ? '1' : '0');
    if (state) setTimeout(function () { input.focus(); }, 60);
  }

  root.querySelector('.hb-bubble').addEventListener('click', function () {
    open(root.getAttribute('data-open') !== '1');
  });
  root.querySelector('.hb-close').addEventListener('click', function () { open(false); });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    input.style.height = 'auto';
    send(text);
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') open(false);
  });

  // Anything the host page wants to do with it, without reaching into the DOM.
  window.HarbourlyChat = {
    open: function () { open(true); },
    close: function () { open(false); },
    session: SESSION,
    ask: function (text) { open(true); send(text); },
  };
})();
