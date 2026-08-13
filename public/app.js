/* ---------------------------------------------------------------------------
   app.js — staff app (line walker, marshal, admin)

   No framework and no build step, on purpose. Edit this file, refresh the
   browser, done. See README section "Why no frontend framework".

   The server is the source of truth. This file sends mutations and re-renders
   whatever state comes back. It never computes queue order itself.
--------------------------------------------------------------------------- */
(function () {
  'use strict';

  var state = null;                  // last STATE from the server
  var ws = null, wsReady = false, retry = 0;
  var walkLane = 'A', marshalLane = 'A';
  var token = sessionStorage.getItem('pp_token') || null;
  var pendingImport = null;
  var refSeq = 0, refs = {};
  var offlineQueue = [];             // tag entries typed while disconnected

  // Marshal on-deck waves shown behind the loading group, and their labels.
  // "Loading now" (group 0) is always shown; these are groups 1..ONDECK_GROUPS.
  var ONDECK_GROUPS = 3;
  var DECK_LABELS = ['Next up', 'On deck', 'After that'];
  var DECK_OPACITY = ['.7', '.55', '.42'];

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var deviceName = function () {
    var n = localStorage.getItem('pp_device');
    if (!n) { n = 'device-' + Math.random().toString(36).slice(2, 6); localStorage.setItem('pp_device', n); }
    return n;
  };

  /* ===================== WEBSOCKET ===================== */
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function () {
      wsReady = true; retry = 0;
      setConn('live', 'live');
      // Anything typed while the network was down goes in now, in order.
      var pend = offlineQueue.splice(0);
      pend.forEach(function (t) { send({ type: 'ADD_TAG', tag: t.tag, lane: t.lane }); });
      if (pend.length) msg('Sent ' + pend.length + ' queued tag(s) after reconnecting.', true);
    };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.type === 'STATE') { state = m; render(); return; }

      var cb = m.ref && refs[m.ref];
      if (cb) { delete refs[m.ref]; cb(m); return; }
      if (m.type === 'ERROR') msg(m.message, false);
    };

    ws.onclose = function () {
      wsReady = false;
      setConn('down', 'offline — retrying');
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry);        // 0.5s, 1s, 1.5s … capped at 3s
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function send(obj, cb) {
    if (cb) { obj.ref = 'r' + (++refSeq); refs[obj.ref] = cb; }
    obj.actor = deviceName();
    if (wsReady) ws.send(JSON.stringify(obj));
    else if (cb) cb({ type: 'ERROR', message: 'Not connected to the server.' });
  }

  function setConn(cls, text) {
    var el = $('conn');
    el.className = 'conn ' + cls;
    el.textContent = text;
  }

  /* ===================== THEME ===================== */
  /* The initial theme is applied by an inline script in index.html so there is
     no flash. This only handles switching it afterwards. */
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('pp_theme', t); } catch (e) {}
    $('themeBtn').textContent = t === 'light' ? '☾' : '☀';
    $('themeBtn').title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    // Contrast text depends on the theme, so re-derive the palette on a switch.
    if (brand) applyBranding(brand);
  }
  $('themeBtn').onclick = function () { applyTheme(currentTheme() === 'light' ? 'dark' : 'light'); };
  applyTheme(currentTheme());

  /* ===================== BRANDING ===================== */
  /* The full colour scheme, logo, app name and subtitle all arrive on the STATE
     broadcast (state.branding), so every device restyles the moment an admin
     saves — no reload. Light and dark palettes are kept separate; the client
     applies whichever matches the screen's current theme, so the light/dark
     toggle keeps working with each mode wearing the school's own colours. */
  var brand = null;

  // The 8 editable tokens and their default values per theme. These defaults
  // reproduce the original look, so an untouched install looks exactly as before.
  var PALETTE_TOKENS = [
    { key: 'accent', label: 'Primary' },
    { key: 'laneA', label: 'Lane A' },
    { key: 'laneB', label: 'Lane B' },
    { key: 'bg', label: 'Background' },
    { key: 'panel', label: 'Surface' },
    { key: 'line', label: 'Borders' },
    { key: 'text', label: 'Text' },
    { key: 'muted', label: 'Muted text' }
  ];
  var PALETTE_DEFAULTS = {
    light: { accent: '#4F46E5', laneA: '#0F766E', laneB: '#F59E0B', bg: '#F7F8FA', panel: '#FFFFFF', line: '#E4E7EC', text: '#1A2333', muted: '#5B6472' },
    dark:  { accent: '#8098F7', laneA: '#2DD4BF', laneB: '#FBBF24', bg: '#0F1420', panel: '#171E2B', line: '#2A3342', text: '#E8EDF4', muted: '#9BA6B7' }
  };

  function hexToRgb(h) {
    var m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h || '');
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
  }
  function toHex(n) { n = Math.max(0, Math.min(255, Math.round(n))); return ('0' + n.toString(16)).slice(-2); }
  function rgbToHex(r, g, b) { return '#' + toHex(r) + toHex(g) + toHex(b); }
  function mix(a, b, t) { var x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t); }
  function lum(h) {
    var c = hexToRgb(h);
    var a = [c.r, c.g, c.b].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(l1, l2) { var hi = Math.max(l1, l2) + 0.05, lo = Math.min(l1, l2) + 0.05; return hi / lo; }
  // Text colour to sit ON a fill of `hex` — whichever of dark/white reads better.
  function onColor(hex) {
    return contrast(lum(hex), lum('#231f14')) >= contrast(lum(hex), lum('#ffffff')) ? '#231f14' : '#ffffff';
  }
  // A version of `hex` readable as TEXT against background `bg`: nudged toward
  // black (light bg) or white (dark bg) until it clears 4.5:1. Because it's
  // bg-driven, it protects headings/lane names even on a fully custom scheme.
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

  // Pull the palette for the active theme, with any gap filled from defaults.
  function paletteFor(b, theme) {
    var d = PALETTE_DEFAULTS[theme === 'light' ? 'light' : 'dark'];
    var p = (theme === 'light' ? b.paletteLight : b.paletteDark) || {};
    var out = {};
    PALETTE_TOKENS.forEach(function (t) { out[t.key] = p[t.key] || d[t.key]; });
    return out;
  }

  function applyBranding(b) {
    if (!b) return;
    var root = document.documentElement, S = function (k, v) { root.style.setProperty(k, v); };
    var p = paletteFor(b, currentTheme());

    // Base surfaces + text come straight from the scheme; the school owns these.
    S('--bg', p.bg); S('--panel', p.panel); S('--line', p.line);
    S('--text', p.text); S('--muted', p.muted);
    // Secondary surfaces derived from the chosen ones so nothing is left stranded.
    S('--panel2', mix(p.panel, p.text, 0.10));
    S('--kid-bg', mix(p.panel, p.text, 0.05));

    // Primary: the raw colour is the button/badge fill; a bg-readable variant is
    // the heading/border text; on-fill text is derived for contrast.
    S('--accent-fill', p.accent);
    S('--accent', readableText(p.accent, p.bg));
    S('--on-accent', onColor(p.accent));

    // Lanes are fills here (tabs / loading pips) — raw colour + derived on-text.
    S('--laneA', p.laneA); S('--laneB', p.laneB);
    S('--on-laneA', onColor(p.laneA)); S('--on-laneB', onColor(p.laneB));

    var src = '/api/branding/logo' + (b.logoVersion ? '?v=' + b.logoVersion : '');
    Array.prototype.forEach.call(document.querySelectorAll('img.brand-logo'), function (img) { img.src = src; });
    var fav = $('favicon'); if (fav) fav.href = src;

    var name = b.appName || 'Pickup';
    var at = $('appTitle'); if (at) at.textContent = name;
    document.title = name;
  }

  /* ---- palette editor (built once, on admin unlock) ---- */
  var paletteBuilt = false;
  function buildPaletteEditor() {
    if (paletteBuilt) return;
    var host = $('paletteEditor');
    if (!host) return;
    var THEMES = [{ k: 'light', label: 'Light mode' }, { k: 'dark', label: 'Dark mode' }];
    host.innerHTML = THEMES.map(function (t) {
      return '<div class="palcol"><div class="palhd">' + t.label + '</div>'
        + PALETTE_TOKENS.map(function (tok) {
          var id = t.k + '_' + tok.key;
          return '<div class="palrow"><span class="pallbl">' + tok.label + '</span>'
            + '<input type="color" id="pc_' + id + '">'
            + '<input type="text" id="ph_' + id + '" class="palhex" maxlength="7" spellcheck="false" autocapitalize="off">'
            + '</div>';
        }).join('') + '</div>';
    }).join('');
    THEMES.forEach(function (t) {
      PALETTE_TOKENS.forEach(function (tok) {
        var id = t.k + '_' + tok.key, c = $('pc_' + id), h = $('ph_' + id);
        c.oninput = function () { h.value = c.value.toUpperCase(); };
        h.oninput = function () { if (/^#[0-9a-fA-F]{6}$/.test(h.value)) c.value = h.value; };
      });
    });
    paletteBuilt = true;
  }
  function fillPalette(themeKey, obj) {
    var d = PALETTE_DEFAULTS[themeKey];
    PALETTE_TOKENS.forEach(function (tok) {
      var v = (obj && obj[tok.key]) || d[tok.key];
      var c = $('pc_' + themeKey + '_' + tok.key), h = $('ph_' + themeKey + '_' + tok.key);
      if (c) c.value = v;
      if (h) h.value = v.toUpperCase();
    });
  }
  function readPalette(themeKey) {
    var out = {};
    PALETTE_TOKENS.forEach(function (tok) {
      var h = $('ph_' + themeKey + '_' + tok.key), c = $('pc_' + themeKey + '_' + tok.key);
      var v = (h.value || '').trim();
      out[tok.key] = /^#[0-9a-fA-F]{6}$/.test(v) ? v : c.value;
    });
    return out;
  }

  /* ===================== SHARED HELPERS ===================== */
  function lane(id) { return state.lanes.filter(function (l) { return l.id === id; })[0]; }
  /* Lane colour is a THEME concern, not server data — see styles.css. */
  function laneVar(id) { return 'var(--lane' + (id === 'B' ? 'B' : 'A') + ')'; }
  function laneClass(id) { return id === 'B' ? 'lane-b' : 'lane-a'; }
  function entriesInGroup(laneId, g) {
    return (state.queues[laneId] || []).filter(function (e) { return e.group === g; });
  }
  function fullName(s) { return s.first + ' ' + s.last; }
  function laneTabs(elId, cur, onPick) {
    var el = $(elId);
    el.innerHTML = state.lanes.map(function (l) {
      return '<button data-l="' + l.id + '" class="' + (cur === l.id ? 'on' : '') + '">' + esc(l.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
      b.onclick = function () { onPick(b.dataset.l); };
    });
  }

  /* ===================== RENDER ===================== */
  function render() {
    if (!state) return;
    if (state.branding) { brand = state.branding; applyBranding(brand); }
    $('schoolName').textContent = state.settings.schoolName;
    laneTabs('walkerLanes', walkLane, function (id) { walkLane = id; render(); });
    laneTabs('marshalLanes', marshalLane, function (id) { marshalLane = id; render(); });
    $('walkerMode').textContent = '· Tags go into the selected lane, first come first served';
    renderWalkerQueue();
    renderMarshal();
    if (token) renderRoster();
  }

  function renderWalkerQueue() {
    var gs = state.settings.groupSize;
    var q = state.queues[walkLane] || [];
    var g0 = entriesInGroup(walkLane, 0), g1 = entriesInGroup(walkLane, 1);
    var rest = q.filter(function (e) { return e.group > 1; });
    var n = 0;

    function row(e, loading) {
      n++;
      return '<div class="qitem">'
        + '<span class="pos' + (loading ? ' loading' : '') + '" data-l="' + walkLane + '">' + n + '</span>'
        + '<span class="tagno">' + esc(e.tag) + '</span>'
        + '<span class="names">' + e.students.map(function (s) {
          var dot = s.spot ? '<span class="spot" data-s="' + s.spot + '">' + s.spot + '</span> ' : '';
          return dot + esc(fullName(s));
        }).join(', ') + '</span>'
        + '<select data-move="' + e.qid + '">'
        + state.lanes.map(function (l) {
          var sel = (state.queues[l.id] || []).some(function (x) { return x.qid === e.qid; });
          return '<option value="' + l.id + '"' + (sel ? ' selected' : '') + '>' + l.id + '</option>';
        }).join('')
        + '</select>'
        + '<button class="act danger" data-del="' + e.qid + '">&times;</button></div>';
    }

    var loadedSlots = g0.reduce(function (a, e) { return a + e.students.length; }, 0);
    $('walkerQueue').innerHTML =
      '<div class="grp">Loading now &mdash; ' + loadedSlots + ' of ' + gs + ' name slots</div>'
      + (g0.length ? g0.map(function (e) { return row(e, true); }).join('') : '<div class="empty">Lane is empty.</div>')
      + '<div class="grp">Next up</div>'
      + (g1.length ? g1.map(function (e) { return row(e, false); }).join('') : '<div class="empty muted">&mdash;</div>')
      + (rest.length ? '<div class="grp">Waiting (' + rest.length + ')</div>'
        + rest.map(function (e) { return row(e, false); }).join('') : '');

    bindQueueControls($('walkerQueue'));
  }

  function bindQueueControls(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { send({ type: 'REMOVE_ENTRY', qid: +b.dataset.del }); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-move]'), function (s) {
      s.onchange = function () { send({ type: 'MOVE_ENTRY', qid: +s.dataset.move, lane: s.value }); };
    });
  }

  function renderMarshal() {
    var g0 = entriesInGroup(marshalLane, 0);

    function card(e, active) {
      return '<div class="mcar ' + (active ? 'on' : '') + '">'
        + '<div style="display:flex;align-items:center;gap:10px">'
        + '<span class="tagno" style="font-size:21px">' + esc(e.tag) + '</span>'
        + '<span class="muted" style="font-size:12px">' + e.students.length + ' rider'
        + (e.students.length > 1 ? 's' : '') + '</span>'
        + '<button class="act" style="margin-left:auto" data-del="' + e.qid + '">Release car</button></div>'
        + '<div>' + e.students.map(function (s) {
          // Same coloured spot the child is standing on, so the marshal can
          // match a name on the board to a body in the waiting area.
          var dot = s.spot ? '<span class="spot" data-s="' + s.spot + '">' + s.spot + '</span>' : '';
          return '<span class="kid ' + (s.inCar ? 'in' : '') + '" data-q="' + e.qid + '" data-sid="' + s.id + '">'
            + dot + esc(fullName(s)) + '</span>';
        }).join('') + '</div></div>';
    }

    // Count the children still standing in the loading group, for the button label.
    var g0kids = g0.reduce(function (a, e) { return a + e.students.length; }, 0);

    // The whole-group release sits BELOW the loading cars — normal end-of-wave
    // action, so it reads as "…and then release all of these". No confirmation:
    // this is routine, and an extra tap every wave would slow the marshal down.
    var releaseAll = g0.length
      ? '<button class="act primary" id="releaseGroup" style="width:100%;margin-top:10px;padding:13px">'
        + 'Release all &middot; ' + g0.length + (g0.length > 1 ? ' cars' : ' car') + '</button>'
      : '';

    // Loading group first, then up to ONDECK_GROUPS waves behind it — each
    // wearing the same coloured spot numbers it will stand on up front, so the
    // marshal can wave the next groups into place early. The first on-deck wave
    // always shows; deeper ones appear only when they have cars.
    var html =
      '<div class="card">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
      + '<h3 style="margin:0">Loading now</h3>'
      + '<span class="muted" style="font-size:12px">' + g0kids + ' student' + (g0kids === 1 ? '' : 's') + '</span></div>'
      + (g0.length ? g0.map(function (e) { return card(e, true); }).join('') + releaseAll
        : '<div class="empty">No cars in this lane yet.</div>') + '</div>';

    for (var g = 1; g <= ONDECK_GROUPS; g++) {
      var gg = entriesInGroup(marshalLane, g);
      if (g > 1 && !gg.length) continue;
      html += '<div class="card" style="opacity:' + DECK_OPACITY[g - 1] + '"><h3>' + DECK_LABELS[g - 1] + '</h3>'
        + (gg.length ? gg.map(function (e) { return card(e, false); }).join('')
          : '<div class="empty muted">&mdash;</div>') + '</div>';
    }

    $('marshalBody').innerHTML = html;

    var rg = $('releaseGroup');
    if (rg) rg.onclick = function () { send({ type: 'RELEASE_GROUP', lane: marshalLane }); };

    bindQueueControls($('marshalBody'));
    Array.prototype.forEach.call($('marshalBody').querySelectorAll('.kid'), function (k) {
      k.onclick = function () {
        send({ type: 'TOGGLE_STUDENT', qid: +k.dataset.q, studentId: +k.dataset.sid });
      };
    });
  }

  /* ===================== WALKER INPUT ===================== */
  function msg(text, ok) {
    var el = $('tagMsg');
    el.textContent = text;
    el.style.color = ok ? 'var(--ok-text)' : 'var(--warn-text)';
  }

  function submitTag() {
    var v = $('tagIn').value.trim();
    if (!v) { msg('Enter a tag number.', false); return; }

    if (!wsReady) {
      // Don't lose the entry just because the wifi hiccuped.
      offlineQueue.push({ tag: v, lane: walkLane });
      $('tagIn').value = '';
      msg('Offline — ' + v + ' saved and will send when the connection returns.', true);
      return;
    }

    send({ type: 'ADD_TAG', tag: v, lane: walkLane }, function (m) {
      if (m.type === 'ACK') { $('tagIn').value = ''; msg('✓ ' + m.message, true); }
      else msg(m.message || 'Could not add that tag.', false);
      $('tagIn').focus();
    });
  }

  (function buildKeypad() {
    var html = '';
    for (var d = 1; d <= 9; d++) html += '<button data-k="' + d + '">' + d + '</button>';
    html += '<button data-k="back">&#9003;</button>';
    html += '<button data-k="0">0</button>';
    html += '<button data-k="go" class="go">Enter</button>';
    $('keys').innerHTML = html;
    Array.prototype.forEach.call($('keys').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        var k = b.dataset.k;
        if (k === 'go') return submitTag();
        if (k === 'back') $('tagIn').value = $('tagIn').value.slice(0, -1);
        else $('tagIn').value += k;
        $('tagIn').focus();
      };
    });
  })();

  $('tagIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitTag(); });

  /* ===================== ADMIN ===================== */
  function api(method, url, body, isRaw) {
    var opts = { method: method, headers: {} };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    if (body !== undefined && body !== null) {
      if (isRaw) { opts.headers['Content-Type'] = 'application/octet-stream'; opts.body = body; }
      else if (typeof body === 'string') { opts.headers['Content-Type'] = 'text/csv'; opts.body = body; }
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { token = null; sessionStorage.removeItem('pp_token'); showAdmin(); throw new Error('Signed out — enter the PIN again.'); }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; });
    });
  }

  function showAdmin() {
    $('adminLocked').style.display = token ? 'none' : 'block';
    $('adminPanel').style.display = token ? 'block' : 'none';
    if (token) { loadSettings(); renderRoster(); }
  }

  $('pinGo').onclick = function () {
    fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('pinIn').value })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { $('pinMsg').textContent = res.j.error || 'Incorrect PIN.'; return; }
        token = res.j.token; sessionStorage.setItem('pp_token', token);
        $('pinIn').value = ''; $('pinMsg').textContent = '';
        showAdmin();
      });
  };
  $('pinIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('pinGo').click(); });

  function loadSettings() {
    buildPaletteEditor();
    api('GET', '/api/settings').then(function (s) {
      $('setLaneA').value = s.laneAName; $('setLaneB').value = s.laneBName;
      $('setGroup').value = s.groupSize;
      $('setPin').value = s.adminPin;
      $('setAppName').value = s.appName || '';
      $('setSchoolName').value = s.schoolName || '';
      fillPalette('light', s.paletteLight);
      fillPalette('dark', s.paletteDark);
    }).catch(function () {});
  }

  $('saveSettings').onclick = function () {
    api('PATCH', '/api/settings', {
      laneAName: $('setLaneA').value, laneBName: $('setLaneB').value,
      groupSize: $('setGroup').value, adminPin: $('setPin').value
    }).then(function () { $('settingsMsg').textContent = 'Saved.'; setTimeout(function () { $('settingsMsg').textContent = ''; }, 2500); })
      .catch(function (e) { $('settingsMsg').textContent = e.message; });
  };
  $('clearLanes').onclick = function () {
    if (confirm('Clear every car from both lanes?')) send({ type: 'CLEAR_LANES' });
  };

  /* ---- branding ---- */
  function brandMsg(t) {
    $('brandingMsg').textContent = t;
    setTimeout(function () { if ($('brandingMsg').textContent === t) $('brandingMsg').textContent = ''; }, 3000);
  }
  $('saveBranding').onclick = function () {
    api('PATCH', '/api/settings', {
      appName: $('setAppName').value,
      schoolName: $('setSchoolName').value,
      paletteLight: readPalette('light'),
      paletteDark: readPalette('dark')
    }).then(function () { brandMsg('Branding saved.'); })
      .catch(function (e) { brandMsg(e.message); });
  };
  $('resetColors').onclick = function () {
    if (!confirm('Reset all colors (light and dark) to the defaults?')) return;
    fillPalette('light', PALETTE_DEFAULTS.light);
    fillPalette('dark', PALETTE_DEFAULTS.dark);
    $('saveBranding').click();
  };
  $('logoBtn').onclick = function () { $('logoFile').click(); };
  // Read the image's real dimensions client-side before uploading, so the admin
  // can see exactly what they're sending (and scale it first if they want to).
  $('logoFile').onchange = function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 512 * 1024) { brandMsg('That image is over 500 KB — resize it and try again.'); return; }
    var kb = Math.round(f.size / 1024);
    var url = URL.createObjectURL(f), img = new Image();
    img.onload = function () {
      var dims = img.naturalWidth + ' × ' + img.naturalHeight + ' px';
      URL.revokeObjectURL(url);
      var r = new FileReader();
      r.onload = function (ev) {
        api('POST', '/api/branding/logo', { dataUrl: ev.target.result })
          .then(function () { brandMsg('Logo updated — ' + dims + ', ' + kb + ' KB.'); })
          .catch(function (err) { brandMsg(err.message); });
      };
      r.readAsDataURL(f);
    };
    img.onerror = function () { URL.revokeObjectURL(url); brandMsg('That file could not be read as an image.'); };
    img.src = url;
  };
  $('logoReset').onclick = function () {
    api('DELETE', '/api/branding/logo')
      .then(function () { brandMsg('Logo reset to default.'); })
      .catch(function (e) { brandMsg(e.message); });
  };
  // Show the current logo's pixel size beneath the preview as it (re)loads.
  (function () {
    var pv = $('logoPreview');
    if (pv) pv.onload = function () {
      var d = $('logoDims');
      if (d && this.naturalWidth) d.textContent = this.naturalWidth + ' × ' + this.naturalHeight + ' px';
    };
  })();

  /* ---- roster table ---- */
  var rosterCache = [];
  function renderRoster() {
    api('GET', '/api/roster').then(function (r) { rosterCache = r.families; drawRoster(); }).catch(function () {});
  }
  function drawRoster() {
    var term = ($('search').value || '').toLowerCase();
    var rows = [];
    rosterCache.forEach(function (f) {
      f.students.forEach(function (s) {
        var hay = (s.first + ' ' + s.last + ' ' + f.tag).toLowerCase();
        if (!term || hay.indexOf(term) >= 0) rows.push({ f: f, s: s });
      });
    });
    rows.sort(function (a, b) { return (a.s.last + a.s.first).localeCompare(b.s.last + b.s.first); });

    var total = rosterCache.reduce(function (a, f) { return a + f.students.length; }, 0);
    $('rosterCount').textContent = total + ' students · ' + rosterCache.length + ' hang tags'
      + (term ? ' · showing ' + rows.length : '');

    function inLane(tag) {
      var hit = null;
      state && state.lanes.forEach(function (l) {
        (state.queues[l.id] || []).forEach(function (e) { if (e.tag === tag) hit = l; });
      });
      return hit;
    }

    $('rosterTable').innerHTML =
      '<tr><th>Tag</th><th>Student</th><th>Grade</th><th>Siblings</th>'
      + '<th>In line</th><th></th></tr>'
      + (rows.length ? rows.map(function (r) {
        var l = inLane(r.f.tag);
        var sibs = r.f.students.filter(function (x) { return x.id !== r.s.id; }).map(function (x) { return esc(x.first); });
        return '<tr>'
          + '<td><span class="tag">' + esc(r.f.tag) + '</span></td>'
          + '<td><b>' + esc(r.s.last) + '</b>, ' + esc(r.s.first) + '</td>'
          + '<td class="muted">' + esc(r.s.grade || '—') + '</td>'
          + '<td class="muted">' + (sibs.length ? sibs.join(', ') : '—') + '</td>'
          + '<td>' + (l ? '<span class="' + laneClass(l.id) + '">' + esc(l.name) + '</span>' : '<span class="muted">—</span>') + '</td>'
          + '<td><button class="act danger" data-delstu="' + r.s.id + '" data-name="'
          + esc(r.s.first + ' ' + r.s.last) + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="empty">No matches.</td></tr>');

    Array.prototype.forEach.call($('rosterTable').querySelectorAll('[data-delstu]'), function (b) {
      b.onclick = function () {
        if (!confirm('Remove ' + b.dataset.name + ' from the rider list?')) return;
        api('DELETE', '/api/students/' + b.dataset.delstu).then(renderRoster);
      };
    });
  }
  $('search').oninput = drawRoster;

  $('addStudent').onclick = function () {
    var body = {
      tag: $('nTag').value.trim(), first: $('nFirst').value.trim(), last: $('nLast').value.trim(),
      grade: $('nGrade').value.trim()
    };
    api('POST', '/api/students', body).then(function () {
      $('addMsg').textContent = 'Added ' + body.first + ' ' + body.last + ' to tag ' + body.tag + '.';
      ['nFirst', 'nLast', 'nGrade'].forEach(function (id) { $(id).value = ''; });
      renderRoster();
    }).catch(function (e) { $('addMsg').textContent = e.message; });
  };

  /* ---- import ---- */
  function preview(text) {
    api('POST', '/api/roster/preview', text).then(function (p) {
      var box = $('importResult');
      if (!p.students) {
        pendingImport = null;
        box.innerHTML = '<div class="errbox"><b>Nothing could be imported.</b><br>'
          + (p.errors.length ? p.errors.map(esc).join('<br>') : 'No usable rows found in that file.')
          + (p.skippedSampleRows ? '<br>(' + p.skippedSampleRows + ' sample row(s) skipped — those are the template examples.)' : '')
          + '</div>';
        return;
      }
      pendingImport = p.payload;
      box.innerHTML = '<div class="okbox"><b>Ready to import: ' + p.students + ' students · '
        + p.families + ' hang tags · ' + p.siblingFamilies + ' families with siblings.</b>'
        + (p.skippedSampleRows ? '<br>' + p.skippedSampleRows + ' sample row(s) skipped.' : '')
        + '<div style="margin-top:8px"><button class="act primary" id="commitBtn">Confirm import</button> '
        + '<button class="act" id="cancelBtn">Cancel</button></div></div>'
        + (p.errors.length ? '<div class="errbox"><b>' + p.errors.length + ' row(s) will be skipped:</b><br>'
          + p.errors.map(esc).join('<br>') + '</div>' : '');

      $('commitBtn').onclick = function () {
        api('POST', '/api/roster/import', { families: pendingImport, replace: $('replaceMode').checked })
          .then(function (r) {
            $('importResult').innerHTML = '<div class="okbox"><b>Imported ' + r.imported + ' students.</b> '
              + 'The rider list is now ' + r.total + ' students.</div>';
            pendingImport = null; renderRoster();
          }).catch(function (e) { $('importResult').innerHTML = '<div class="errbox">' + esc(e.message) + '</div>'; });
      };
      $('cancelBtn').onclick = function () { pendingImport = null; $('importResult').innerHTML = ''; };
    }).catch(function (e) { $('importResult').innerHTML = '<div class="errbox">' + esc(e.message) + '</div>'; });
  }

  $('parsePaste').onclick = function () {
    var t = $('pasteIn').value.trim();
    if (!t) { $('importResult').innerHTML = '<div class="errbox">Nothing pasted.</div>'; return; }
    preview(t);
  };
  $('exportCsv').onclick = function () { downloadAuth('/api/roster/export.csv'); };

  var drop = $('drop');
  drop.onclick = function () { $('fileIn').click(); };
  drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = function () { drop.classList.remove('over'); };
  drop.ondrop = function (e) {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readCsv(e.dataTransfer.files[0]);
  };
  $('fileIn').onchange = function (e) { if (e.target.files[0]) readCsv(e.target.files[0]); };

  function readCsv(file) {
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      $('importResult').innerHTML = '<div class="errbox">This imports CSV files. '
        + 'Open the spreadsheet in Excel, choose <b>File &rsaquo; Save As &rsaquo; CSV</b>, then drop that file here.</div>';
      return;
    }
    var r = new FileReader();
    r.onload = function (ev) { preview(ev.target.result); };
    r.readAsText(file);
  }

  /* ---- backup / restore ---- */
  function downloadAuth(url) {
    fetch(url, { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) {
        if (!r.ok) throw new Error('Download failed');
        var name = (r.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/);
        return r.blob().then(function (b) { return { blob: b, name: name ? name[1] : 'download' }; });
      })
      .then(function (d) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(d.blob); a.download = d.name; a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      })
      .catch(function (e) { alert(e.message); });
  }

  $('backupBtn').onclick = function () {
    downloadAuth('/api/backup');
    $('backupResult').innerHTML = '<div class="okbox">Backup downloading. '
      + 'Store it somewhere other than this server — a district file share or a USB drive.</div>';
  };
  $('restoreBtn').onclick = function () { $('restoreFile').click(); };
  $('restoreFile').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    if (!confirm('Restore from "' + f.name + '"?\n\nThis replaces the entire current database — roster, '
      + 'settings and today\'s queue. The current database is kept on the server as a safety copy.')) {
      e.target.value = ''; return;
    }
    f.arrayBuffer().then(function (buf) {
      return api('POST', '/api/restore', buf, true);
    }).then(function (r) {
      $('backupResult').innerHTML = '<div class="okbox"><b>Restored.</b> ' + r.students
        + ' students loaded. The previous database was kept on the server as <code>'
        + esc(r.previousDatabaseKeptAs) + '</code>.</div>';
      renderRoster(); loadSettings();
    }).catch(function (err) {
      $('backupResult').innerHTML = '<div class="errbox">' + esc(err.message) + '</div>';
    });
    e.target.value = '';
  };

  $('showLog').onclick = function () {
    var box = $('logBox');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    api('GET', '/api/events').then(function (r) {
      box.innerHTML = '<div class="card"><h3>Activity log</h3>'
        + (r.events.length ? r.events.map(function (e) {
          return '<div class="logline"><time>' + new Date(e.at).toLocaleString() + '</time>'
            + '<b>' + esc(e.kind) + '</b> ' + esc(e.detail) + '</div>';
        }).join('') : '<div class="empty">Nothing logged yet.</div>') + '</div>';
    });
  };

  /* ===================== NAV / CLOCK ===================== */
  Array.prototype.forEach.call(document.querySelectorAll('nav button[data-v]'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('nav button[data-v]'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.remove('on'); });
      $('v-' + b.dataset.v).classList.add('on');
      if (b.dataset.v === 'walker') $('tagIn').focus();
      if (b.dataset.v === 'admin') { showAdmin(); if (!token) $('pinIn').focus(); }
    };
  });

  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  setInterval(tick, 1000); tick();

  connect();
  $('tagIn').focus();
})();
