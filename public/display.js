/* ---------------------------------------------------------------------------
   display.js — the gym TV (Android touch panel).

   Design rules for this screen, in priority order:
     1. NEVER go blank. If the connection drops it keeps showing the last list
        it received and says so. A stale list is useful; an empty screen is not.
     2. Read-only. It sends nothing, so it cannot cause a bad write, and it
        needs no authentication.
     3. Recover by itself. Nobody should have to walk to the gym to fix it.
--------------------------------------------------------------------------- */
(function () {
  'use strict';

  var last = null;               // last STATE received — the thing we keep showing
  var brand = null;              // last branding received (colours, logo, title)
  var ws = null, retry = 0, connected = false;
  var scale = parseFloat(localStorage.getItem('pp_scale') || '1');

  // How many waves to show behind the loading group, and what to call them.
  // "Loading now" (group 0) is always shown; these are groups 1..ONDECK_GROUPS.
  // Bump ONDECK_GROUPS and add a label to show more/fewer on deck.
  var ONDECK_GROUPS = 3;
  var DECK_LABELS = ['Next up', 'On deck', 'After that'];

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ---------- branding ----------
     The full colour scheme, logo and title arrive on the STATE broadcast, so
     rebranding from the staff admin reaches this board with no reload. The board
     keeps its OWN light/dark choice and applies whichever palette matches. On
     this screen most colours are TEXT and borders on the background (not fills),
     so brand hues are nudged to stay legible against the chosen board colour. */
  var PALETTE_KEYS = ['accent', 'laneA', 'laneB', 'bg', 'panel', 'line', 'text', 'muted'];
  var PALETTE_DEFAULTS = {
    light: { accent: '#4F46E5', laneA: '#0F766E', laneB: '#F59E0B', bg: '#F7F8FA', panel: '#FFFFFF', line: '#E4E7EC', text: '#1A2333', muted: '#5B6472' },
    dark:  { accent: '#8098F7', laneA: '#2DD4BF', laneB: '#FBBF24', bg: '#0F1420', panel: '#171E2B', line: '#2A3342', text: '#E8EDF4', muted: '#9BA6B7' }
  };
  function hexToRgb(h) { var m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h || ''); return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 }; }
  function toHex(n) { n = Math.max(0, Math.min(255, Math.round(n))); return ('0' + n.toString(16)).slice(-2); }
  function rgbToHex(r, g, b) { return '#' + toHex(r) + toHex(g) + toHex(b); }
  function mix(a, b, t) { var x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t); }
  function lum(h) { var c = hexToRgb(h); var a = [c.r, c.g, c.b].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; }
  function contrast(l1, l2) { var hi = Math.max(l1, l2) + 0.05, lo = Math.min(l1, l2) + 0.05; return hi / lo; }
  function onColor(hex) { return contrast(lum(hex), lum('#231f14')) >= contrast(lum(hex), lum('#ffffff')) ? '#231f14' : '#ffffff'; }
  function readableText(hex, bg) {
    var bgL = lum(bg);
    if (contrast(lum(hex), bgL) >= 4.5) return hex;
    var c = hexToRgb(hex), toward = bgL > 0.5 ? 0 : 255;
    for (var f = 0.05; f <= 1.0001; f += 0.05) {
      var hx = rgbToHex(c.r + (toward - c.r) * f, c.g + (toward - c.g) * f, c.b + (toward - c.b) * f);
      if (contrast(lum(hx), bgL) >= 4.5) return hx;
    }
    return bgL > 0.5 ? '#111111' : '#ffffff';
  }
  function paletteFor(b, theme) {
    var d = PALETTE_DEFAULTS[theme === 'light' ? 'light' : 'dark'];
    var p = (theme === 'light' ? b.paletteLight : b.paletteDark) || {};
    var out = {};
    PALETTE_KEYS.forEach(function (k) { out[k] = p[k] || d[k]; });
    return out;
  }
  function applyBrandingD(b) {
    if (!b) return;
    var root = document.documentElement, S = function (k, v) { root.style.setProperty(k, v); };
    var p = paletteFor(b, currentTheme());
    S('--bg', p.bg);
    S('--fg', p.text);
    S('--accent', readableText(p.accent, p.bg));
    S('--on-accent', onColor(p.accent));
    S('--laneA', readableText(p.laneA, p.bg));
    S('--laneB', readableText(p.laneB, p.bg));
    S('--dim', readableText(p.muted, p.bg));
    S('--rule', p.line);
    S('--faint', mix(p.muted, p.bg, 0.5));
    S('--hr', p.muted);
    S('--ctl-bg', p.panel);
    S('--ctl-line', p.line);
    S('--ctl-fg', readableText(p.muted, p.panel));

    var src = '/api/branding/logo' + (b.logoVersion ? '?v=' + b.logoVersion : '');
    var lg = $('dlogo'); if (lg) lg.src = src;
    var fav = $('dfav'); if (fav) fav.href = src;

    var name = b.appName || 'Pickup';
    var ts = $('dtitle'); if (ts) ts.textContent = name;
    document.title = name + ' — Display';
  }

  /* ---------- connection ---------- */
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function () {
      connected = true; retry = 0;
      $('dot').className = 'dot';
      $('stale').classList.remove('on');
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== 'STATE') return;
      last = m;
      if (m.branding) { brand = m.branding; applyBrandingD(brand); }
      render();
    };
    ws.onclose = function () {
      connected = false;
      $('dot').className = 'dot down';
      // Only shout about it if we actually have something stale on screen.
      if (last) $('stale').classList.add('on');
      retry = Math.min(retry + 1, 10);
      setTimeout(connect, Math.min(500 * retry, 5000));
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  /* ---------- render ---------- */
  function render() {
    if (!last) {
      $('cols').innerHTML = '<div class="col" style="grid-column:1/3">'
        + '<div class="none">Connecting' + (brand && brand.appName ? ' to ' + esc(brand.appName) : '') + '…</div></div>';
      return;
    }

    $('cols').innerHTML = last.lanes.map(function (l) {
      var q = last.queues[l.id] || [];

      /*  Each child gets the coloured dot for their spot. `spot` is assigned by
          the server so the board, the marshal tablet and the walker tablet
          always agree. For the loading group it's the spot they're standing on
          now; for an on-deck group it's the spot they'll take when that group
          moves up — same number, same colour, so the wave lines up early.   */
      function names(entries) {
        var out = [];
        entries.forEach(function (e) {
          e.students.forEach(function (s) {
            var dot = s.spot ? '<span class="spot" data-s="' + s.spot + '">' + s.spot + '</span>' : '';
            out.push('<div class="nm">' + dot
              + '<span class="who">' + esc(s.first + ' ' + s.last) + '</span></div>');
          });
        });
        return out.join('');
      }

      // "Loading now" (group 0) plus ONDECK_GROUPS waves behind it, each wearing
      // its own 1..N coloured spot numbers. ALL waves are always shown — even an
      // empty one holds its slot with a "—" — so the board reliably shows the
      // full look-ahead (4 groups) and its shape doesn't jump around as the line
      // shortens. Empty waves read as "nothing queued here yet", which is useful.
      var sect = '<div class="sect">Loading now</div>'
        + '<div class="list main">'
        + (names(q.filter(function (e) { return e.group === 0; })) || '<div class="none">— waiting —</div>')
        + '</div>';

      for (var g = 1; g <= ONDECK_GROUPS; g++) {
        var gg = q.filter(function (e) { return e.group === g; });
        sect += '<div class="sect">' + DECK_LABELS[g - 1] + '</div>'
          + '<div class="list ondeck d' + g + '">'
          + (names(gg) || '<div class="none">—</div>') + '</div>';
      }

      // Lane colour comes from the theme (see display.html), not the server.
      return '<div class="col ' + (l.id === 'B' ? 'b' : 'a') + '">'
        + '<div class="lname">' + esc(l.name) + '</div>' + sect
        + '</div>';
    }).join('');
  }

  /* ---------- touch panel plumbing ---------- */

  // Controls fade out so the gym screen is clean; tap anywhere to bring them back.
  var hideTimer = null;
  function showCtl() {
    $('ctl').classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { $('ctl').classList.remove('show'); }, 6000);
  }
  document.addEventListener('click', showCtl);
  document.addEventListener('touchstart', showCtl, { passive: true });

  // Theme. Remembered per panel, independent of the staff app's setting.
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('pp_display_theme', t); } catch (e) {}
    $('themeBtn').textContent = t === 'light' ? 'Dark' : 'Light';
    // Contrast of the palette depends on the board theme — re-derive on a switch.
    if (brand) applyBrandingD(brand);
  }
  $('themeBtn').onclick = function (e) {
    e.stopPropagation();
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  };
  applyTheme(currentTheme());

  $('fsBtn').onclick = function (e) {
    e.stopPropagation();
    var el = document.documentElement;
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
  };

  function applyScale() {
    document.documentElement.style.fontSize = (16 * scale) + 'px';
    document.body.style.zoom = scale;          // Chrome/Android honours this
    localStorage.setItem('pp_scale', String(scale));
  }
  $('biggerBtn').onclick = function (e) { e.stopPropagation(); scale = Math.min(1.6, scale + 0.1); applyScale(); };
  $('smallerBtn').onclick = function (e) { e.stopPropagation(); scale = Math.max(0.7, scale - 0.1); applyScale(); };
  applyScale();

  // Keep the panel awake. Android drops the lock when the screen is hidden,
  // so re-acquire it whenever we become visible again.
  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* denied or unsupported — the panel's own settings must handle it */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!wakeLock) keepAwake();
      // A panel waking from sleep often has a dead socket it hasn't noticed yet.
      if (!connected) { try { ws.close(); } catch (e) {} connect(); }
    }
  });
  keepAwake();

  /* ---------- clock ---------- */
  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  setInterval(tick, 1000); tick();

  connect();
  render();
  showCtl();
})();
