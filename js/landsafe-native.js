/* LandSafe Android/mobile integration layer.
 *
 * Loaded before the main dashboard script so it can gate real-time data
 * behind Firebase Authentication. The dashboard dispatches
 * "landsafe:dashboard-ready" once its functions are available; at that point
 * we either show the sign-in gate or start read-only data.
 *
 * Nothing in this file fabricates sensor values. Notification text always
 * comes from the Cloud Functions engine or from the signed-in user's own
 * test-alert request.
 */
(function () {
  'use strict';

  var Cap = window.Capacitor;
  var IS_NATIVE = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  var PLATFORM = Cap && typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : 'web';
  window.LandSafeNativeBoot = IS_NATIVE;

  function plugins() { return (window.Capacitor && window.Capacitor.Plugins) || {}; }
  function getDb() { return window.LandSafeFirebase && window.LandSafeFirebase.db; }
  function getAuth() { return window.LandSafeFirebase && window.LandSafeFirebase.auth; }
  function toast(msg, type) {
    try { if (typeof window.showToast === 'function') window.showToast(msg, type || 'info'); } catch (e) { /* ignore */ }
  }
  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(id) { return document.getElementById(id); }
  function text(id, value) { var e = el(id); if (e) e.textContent = value; }

  var currentUser = null;
  var currentRole = 'viewer';
  var fcmToken = localStorage.getItem('landsafe_fcm_token') || null;
  var dashboardReady = false;
  var appBooted = false;
  var authMode = false; /* true when Firebase Auth is configured */
  var readOnlyChosen = false;
  var alertsRef = null;
  var alerts = [];
  var alertFilters = { severity: 'all', node: 'all', from: '', to: '', unreadOnly: false };
  var alertPage = 1;
  var alertsPerPage = 10;
  var currentAlertId = null;
  var lastLocalAlertCount = 0;

  var ROLE_CAPS = {
    admin: { weather: true, telemetry: true, manage: true, label: 'Administrator' },
    operator: { weather: true, telemetry: true, manage: false, label: 'Operator' },
    viewer: { weather: false, telemetry: false, manage: false, label: 'Viewer' }
  };

  function normalizeRole(role) {
    var r = String(role || '').toLowerCase();
    if (r === 'admin' || r === 'administrator') return 'admin';
    if (r === 'operator' || r === 'technician' || r === 'editor') return 'operator';
    return 'viewer';
  }

  function applyRole(role) {
    currentRole = normalizeRole(role);
    var caps = ROLE_CAPS[currentRole];
    window.LandSafeCanWriteWeather = !!caps.weather;
    window.LandSafeCanWriteTelemetry = !!caps.telemetry;
    window.LandSafeCanManage = !!caps.manage;
    window.LandSafeRole = currentRole;
    var roleEl = el('lsAccountRole');
    if (roleEl) {
      roleEl.textContent = caps.label;
      roleEl.className = 'tag ' + (currentRole === 'admin' ? 'tag-danger' : currentRole === 'operator' ? 'tag-warning' : 'tag-safe');
    }
    text('lsAccountEmail', currentUser ? (currentUser.email || currentUser.uid) : 'Not signed in');
  }

  /* ───────────────────────── Auth gate (Legacy Overlay Removed) ───────────────────────── */

  function buildAuthOverlay() {
    var existing = el('lsAuthOverlay');
    if (existing) existing.remove();
  }

  function showAuthOverlay(message) {
    var existing = el('lsAuthOverlay');
    if (existing) existing.remove();
  }

  function hideAuthOverlay() {
    var existing = el('lsAuthOverlay');
    if (existing) existing.remove();
  }

  function friendlyAuthError(err) {
    var code = (err && err.code) || '';
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
      return 'Incorrect email or password.';
    }
    if (code === 'auth/invalid-email') return 'That email address is not valid.';
    if (code === 'auth/too-many-requests') return 'Too many attempts. Try again later or reset your password.';
    if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
    if (code === 'auth/user-disabled') return 'This account has been disabled. Contact an administrator.';
    return (err && err.message) || 'Sign-in failed.';
  }

  async function signInWithPassword() {
    /* Legacy green auth sign-in removed — authentication handled by Admin Gateway */
  }

  async function requestPasswordReset() {
    /* Legacy green auth reset removed */
  }

  async function resolveRole(user) {
    try {
      var token = await user.getIdTokenResult();
      var claims = token.claims || {};
      if (claims.admin === true) return 'admin';
      if (claims.role) return normalizeRole(claims.role);
    } catch (e) { /* fall through to database role */ }
    var db = getDb();
    if (db) {
      try {
        var snap = await db.ref('users/' + user.uid).once('value');
        var v = snap.val() || {};
        if (v.role) return normalizeRole(v.role);
      } catch (e) { /* rules may not be deployed yet */ }
    }
    return 'viewer';
  }

  async function handleSignedIn(user) {
    currentUser = user;
    hideAuthOverlay();
    var role = await resolveRole(user);
    applyRole(role);
    updateAccountCard();
    bootApp();
    // Data path is already subscribed; re-subscribe alert history for this uid.
    subscribeAlerts();
    if (IS_NATIVE) {
      createNotificationChannels();
      ensurePushRegistration(false);
    }
    var testWrap = el('lsTestWarning');
    var allowTest = window.LANDSAFE_ALLOW_TEST_ALERTS === true && currentRole === 'admin';
    if (testWrap) testWrap.style.display = allowTest ? 'inline-block' : 'none';
    var testCrit = el('lsTestCritical');
    if (testCrit) testCrit.style.display = allowTest ? 'inline-block' : 'none';
    if (el('lsTestNote')) {
      el('lsTestNote').textContent = allowTest
        ? 'Development test alerts call the sendTestAlert function and never modify sensor readings.'
        : 'Test alerts are disabled. Set LANDSAFE_ALLOW_TEST_ALERTS=true in firebase-config.js in development.';
    }
  }

  function handleSignedOut() {
    currentUser = null;
    currentRole = 'viewer';
    window.LandSafeCanWriteWeather = false;
    window.LandSafeCanWriteTelemetry = false;
    window.LandSafeCanManage = false;
    applyRole('viewer');
    detachAlerts();
    if (typeof window.LandSafeStopRealtime === 'function') {
      try { window.LandSafeStopRealtime(); } catch (e) { /* ignore */ }
    }
    appBooted = false;
    updateAccountCard();
    var existing = el('lsAuthOverlay');
    if (existing) existing.remove();
  }

  async function signOut() {
    var auth = getAuth();
    var user = currentUser;
    var token = fcmToken || localStorage.getItem('landsafe_fcm_token');
    if (user && token) {
      var db = getDb();
      if (db) {
        try { await db.ref('fcm_tokens/' + user.uid + '/' + token).remove(); } catch (e) { /* ignore */ }
      }
    }
    localStorage.removeItem('landsafe_fcm_token');
    fcmToken = null;
    if (auth) {
      try { await auth.signOut(); } catch (e) { toast('Sign-out failed: ' + e.message, 'warning'); }
    }
    handleSignedOut();
  }

  function updateAccountCard() {
    text('lsAccountEmail', currentUser ? (currentUser.email || currentUser.uid) : 'Not signed in');
    applyRole(currentRole);
  }

  /* ───────────────────────── App boot ───────────────────────── */

  function bootApp() {
    if (appBooted) return;
    appBooted = true;
    document.body.classList.add('ls-app-ready');
    if (typeof window.LandSafeStartRealtime === 'function') {
      try { window.LandSafeStartRealtime(); } catch (e) { console.error('Realtime start failed', e); }
    }
    if (currentUser) subscribeAlerts();
    setupMobileNav();
    setupNetworkBanner();
    setupBackButton();
    createNotificationChannels();
    applyStatusBar();
    updateAccountCard();
  }

  function bootReadOnly(reason) {
    window.LandSafeCanWriteWeather = false;
    window.LandSafeCanWriteTelemetry = false;
    window.LandSafeCanManage = false;
    applyRole('viewer');
    bootApp();
    if (reason) showConfigBanner(reason);
  }

  function showConfigBanner(message) {
    if (el('lsConfigBanner')) return;
    var b = document.createElement('div');
    b.id = 'lsConfigBanner';
    b.className = 'ls-top-banner ls-top-banner-warning';
    b.innerHTML = '<iconify-icon icon="material-symbols:info-outline"></iconify-icon><span>' + esc(message) + '</span>' +
      '<button type="button" aria-label="Dismiss" onclick="this.parentNode.remove()">×</button>';
    document.body.appendChild(b);
  }

  function setupAuth() {
    var existing = el('lsAuthOverlay');
    if (existing) existing.remove();
    applyRole('admin');
    bootApp();
    if (IS_NATIVE) {
      createNotificationChannels();
      ensurePushRegistration(false);
    }
  }

  /* ─────────────────────── Alert history ─────────────────────── */

  function toMillis(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v && typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v === 'string') {
      var t = Date.parse(v);
      if (isFinite(t)) return t;
    }
    return 0;
  }

  function mapAlert(key, a) {
    a = a || {};
    var acks = a.acknowledgements || a.acks || {};
    var uid = currentUser ? currentUser.uid : '';
    var created = toMillis(a.createdAt) || toMillis(a.ts) || toMillis(a.timestamp) || toMillis(a.firstTriggeredAt);
    var severity = String(a.severity || a.level || 'INFO').toUpperCase();
    if (severity === 'DANGER') severity = 'CRITICAL';
    if (severity === 'WARN') severity = 'WARNING';
    var state = String(a.state || a.status || (a.active === false ? 'RECOVERED' : 'ACTIVE')).toUpperCase();
    var reason = a.reason || a.message || a.description || a.detail || '';
    var node = a.nodeId || a.node || a.sensorNode || a.sensor || 'unknown';
    var type = a.type || a.hazardType || a.title || 'Hazard alert';
    return {
      id: key,
      severity: severity,
      nodeId: node,
      type: type,
      reason: reason,
      state: state,
      active: state === 'ACTIVE' || state === 'ESCALATED' || state === 'OPEN',
      createdAt: created,
      ackCount: Object.keys(acks).length,
      ackedByMe: !!(uid && acks[uid]),
      data: a
    };
  }

  function lastSeenKey() { return 'landsafe_alerts_last_seen_' + (currentUser ? currentUser.uid : 'anon'); }
  function lastSeenAt() { return parseInt(localStorage.getItem(lastSeenKey()) || '0', 10) || 0; }

  function isUnread(a) {
    return !a.ackedByMe && a.createdAt > lastSeenAt();
  }

  function subscribeAlerts() {
    if (!currentUser) return;
    var db = getDb();
    if (!db) return;
    detachAlerts();
    alertsRef = db.ref('alerts').orderByKey().limitToLast(300);
    alertsRef.on('value', function (snap) {
      var next = [];
      snap.forEach(function (child) { next.push(mapAlert(child.key, child.val())); });
      next.sort(function (a, b) { return b.createdAt - a.createdAt; });
      alerts = next;
      populateNodeFilter();
      renderAlertHistory();
      updateUnreadBadge();
    }, function (err) {
      var body = el('lsAlertHistoryBody');
      if (body) body.innerHTML = '<tr><td colspan="7" style="padding:28px;text-align:center;color:var(--danger);font-size:12px">Cannot read /alerts: ' + esc(err && err.message ? err.message : 'permission denied') + '</td></tr>';
    });
  }

  function detachAlerts() {
    if (alertsRef) {
      try { alertsRef.off(); } catch (e) { /* ignore */ }
      alertsRef = null;
    }
  }

  function populateNodeFilter() {
    var sel = el('lsAlertNode');
    if (!sel) return;
    var current = sel.value || 'all';
    var nodes = {};
    alerts.forEach(function (a) { if (a.nodeId && a.nodeId !== 'unknown') nodes[a.nodeId] = true; });
    var html = '<option value="all">All nodes</option>';
    Object.keys(nodes).sort().forEach(function (n) {
      html += '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    });
    sel.innerHTML = html;
    if (nodes[current] || current === 'all') sel.value = current;
  }

  function filteredAlerts() {
    var from = alertFilters.from ? new Date(alertFilters.from + 'T00:00:00').getTime() : null;
    var to = alertFilters.to ? new Date(alertFilters.to + 'T23:59:59.999').getTime() : null;
    return alerts.filter(function (a) {
      if (alertFilters.severity !== 'all' && a.severity !== alertFilters.severity) return false;
      if (alertFilters.node !== 'all' && a.nodeId !== alertFilters.node) return false;
      if (from !== null && a.createdAt < from) return false;
      if (to !== null && a.createdAt > to) return false;
      if (alertFilters.unreadOnly && !isUnread(a)) return false;
      return true;
    });
  }

  function severityTag(sev) {
    var cls = sev === 'CRITICAL' ? 'tag-danger' : sev === 'WARNING' ? 'tag-warning' : 'tag-safe';
    return '<span class="tag ' + cls + '">' + esc(sev) + '</span>';
  }

  function stateTag(state, severity) {
    var sev = String(severity || '').toUpperCase();
    // Recovery and sensor-online records are INFO even though they are ACTIVE.
    // Colour by severity so a safe recovery never looks like a critical alert.
    var cls = sev === 'CRITICAL' ? 'tag-danger' : sev === 'WARNING' ? 'tag-warning' : 'tag-safe';
    if (state === 'SUPERSEDED') cls = 'tag-safe';
    return '<span class="tag ' + cls + '">' + esc(state) + '</span>';
  }

  function renderAlertHistory() {
    var body = el('lsAlertHistoryBody');
    if (!body) return;
    var rows = filteredAlerts();
    var totalPages = Math.max(1, Math.ceil(rows.length / alertsPerPage));
    if (alertPage > totalPages) alertPage = totalPages;
    var start = (alertPage - 1) * alertsPerPage;
    var pageRows = rows.slice(start, start + alertsPerPage);

    if (!pageRows.length) {
      body.innerHTML = '<tr><td colspan="7" style="padding:34px;text-align:center;color:var(--text-faint);font-size:12px">' +
        (currentUser ? 'No alert history matches these filters' : 'Sign in to load cloud alert history') + '</td></tr>';
    } else {
      body.innerHTML = pageRows.map(function (a) {
        var when = a.createdAt ? new Date(a.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '--';
        var unread = isUnread(a);
        return '<tr style="border-bottom:1px solid var(--border);' + (unread ? 'background:var(--warning-soft)' : '') + '">' +
          '<td style="padding:8px;font-size:11px;color:var(--text-muted);white-space:nowrap">' + esc(when) + '</td>' +
          '<td style="padding:8px">' + severityTag(a.severity) + '</td>' +
          '<td style="padding:8px;font-size:11px;color:var(--primary);font-weight:600">' + esc(a.nodeId) + '</td>' +
          '<td style="padding:8px;font-size:11px;color:var(--text);max-width:320px">' + esc(a.reason || a.type) + '</td>' +
          '<td style="padding:8px">' + stateTag(a.state, a.severity) + '</td>' +
          '<td style="padding:8px;font-size:10.5px;color:var(--text-muted)">' + (a.ackedByMe ? 'You' : (a.ackCount ? a.ackCount + ' user(s)' : '—')) + '</td>' +
          '<td style="padding:8px;white-space:nowrap">' +
            '<button class="history-filter-btn" style="padding:3px 8px" data-id="' + esc(a.id) + '" onclick="LandSafeAlertHistory.openDetails(this.dataset.id)">Details</button> ' +
            (a.ackedByMe ? '' : '<button class="history-filter-btn" style="padding:3px 8px" data-id="' + esc(a.id) + '" onclick="LandSafeAlertHistory.acknowledge(this.dataset.id)">Ack</button>') +
          '</td>' +
        '</tr>';
      }).join('');
    }

    text('lsAlertPageInfo', 'Page ' + (rows.length ? alertPage : 0) + ' of ' + (rows.length ? totalPages : 0) + ' · ' + rows.length + ' alerts');
    var prev = el('lsAlertPrev');
    var next = el('lsAlertNext');
    if (prev) prev.disabled = alertPage <= 1;
    if (next) next.disabled = alertPage >= totalPages;
    updateUnreadBadge();
  }

  function updateUnreadBadge() {
    var unread = alerts.filter(isUnread).length;
    var badge = el('lsUnreadBadge');
    if (badge) {
      badge.textContent = unread + ' unread';
      badge.style.display = unread > 0 ? 'inline-block' : 'none';
    }
    var navBadge = el('alertBadge');
    if (navBadge) {
      var total = Math.max(unread, lastLocalAlertCount);
      navBadge.textContent = total;
      navBadge.style.display = total > 0 ? 'inline-block' : 'none';
    }
  }

  function markAllRead() {
    localStorage.setItem(lastSeenKey(), String(Date.now()));
    renderAlertHistory();
  }

  function acknowledge(id) {
    if (!currentUser) { toast('Sign in to acknowledge alerts.', 'warning'); return; }
    var db = getDb();
    if (!db) return;
    var alert = alerts.filter(function (a) { return a.id === id; })[0];
    if (!alert) return;
    db.ref('alerts/' + id + '/acknowledgements/' + currentUser.uid).set({
      at: firebase.database.ServerValue.TIMESTAMP,
      email: currentUser.email || currentUser.uid,
      displayName: currentUser.displayName || ''
    }).then(function () {
      toast('Alert acknowledged.', 'info');
      if (currentAlertId === id) closeDetails();
    }).catch(function (err) {
      toast('Acknowledgement failed: ' + (err && err.message ? err.message : 'permission denied'), 'warning');
    });
  }

  function openDetails(id) {
    var a = alerts.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    currentAlertId = id;
    var content = el('lsAlertDetailContent');
    if (content) {
      var when = a.createdAt ? new Date(a.createdAt).toLocaleString() : '--';
      var raw = '';
      try { raw = JSON.stringify(a.data, null, 2); } catch (e) { raw = ''; }
      content.innerHTML =
        '<div class="flex items-center gap-2 mb-3">' + severityTag(a.severity) + stateTag(a.state, a.severity) +
          '<span style="font-size:11px;color:var(--text-faint);margin-left:auto">' + esc(when) + '</span></div>' +
        '<div style="font-size:15px;font-weight:800;color:var(--text);margin-bottom:4px">' + esc(a.type) + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Node: <strong>' + esc(a.nodeId) + '</strong></div>' +
        '<div style="font-size:12.5px;color:var(--text);line-height:1.55;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:10px">' + esc(a.reason || 'No reason recorded') + '</div>' +
        '<div style="font-size:10.5px;color:var(--text-faint);margin-bottom:4px">Alert ID: <span style="font-family:monospace">' + esc(a.id) + '</span></div>' +
        '<div style="font-size:10.5px;color:var(--text-faint);margin-bottom:4px">Acknowledgements: ' + a.ackCount + '</div>' +
        (a.ackedByMe ? '<div class="tag tag-safe" style="margin-bottom:8px">Acknowledged by you</div>' : '') +
        '<details style="margin-top:6px"><summary style="font-size:11px;color:var(--text-faint);cursor:pointer">Raw record</summary>' +
        '<pre style="font-size:9.5px;max-height:180px;overflow:auto;background:var(--surface2);padding:8px;border-radius:8px;white-space:pre-wrap">' + esc(raw) + '</pre></details>';
    }
    var ackBtn = el('lsAlertDetailAck');
    if (ackBtn) ackBtn.style.display = a.ackedByMe ? 'none' : 'block';
    var modal = el('lsAlertDetailModal');
    if (modal) {
      modal.style.display = 'flex';
      requestAnimationFrame(function () { modal.classList.add('visible'); });
    }
  }

  function closeDetails() {
    currentAlertId = null;
    var modal = el('lsAlertDetailModal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(function () { modal.style.display = 'none'; }, 220);
  }

  function acknowledgeCurrent() { if (currentAlertId) acknowledge(currentAlertId); }

  /* ───────────────────── Push notifications ──────────────────── */

  function createNotificationChannels() {
    var L = plugins().LocalNotifications;
    if (!L || typeof L.createChannel !== 'function') return;
    var channels = [
      { id: 'landsafe_general', name: 'General', description: 'General LandSafe information', importance: 3, visibility: 1, lights: true, lightColor: '#16A34A' },
      { id: 'landsafe_warning', name: 'Warning', description: 'Elevated landslide risk warnings', importance: 4, visibility: 1, sound: 'warning_sound.wav', vibration: true, lights: true, lightColor: '#F59E0B' },
      { id: 'landsafe_critical', name: 'Critical', description: 'Critical landslide risk alerts', importance: 5, visibility: 1, sound: 'critical_sound.wav', vibration: true, lights: true, lightColor: '#EF4444' },
      { id: 'landsafe_offline', name: 'Sensor Offline', description: 'Sensor node connectivity warnings', importance: 3, visibility: 1, vibration: false, lights: true, lightColor: '#64748B' }
    ];
    channels.forEach(function (c) {
      Promise.resolve(L.createChannel(c)).catch(function (e) { console.warn('Channel create failed', c.id, e); });
    });
  }

  function getInstallationId() {
    var id = localStorage.getItem('landsafe_install_id');
    if (!id) {
      id = 'inst_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      localStorage.setItem('landsafe_install_id', id);
    }
    return id;
  }

  function getSubscribedPoles() {
    try {
      var saved = localStorage.getItem('landsafe_subscribed_poles');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { pole_1: true, pole_2: true };
  }

  function setPushStatus(msg, color) {
    var e = el('lsPushStatus');
    if (e) { e.textContent = msg; e.style.color = color || 'var(--text)'; }
    text('lsFcmToken', fcmToken ? fcmToken.slice(0, 26) + '…' : 'Not registered');
  }

  async function ensurePushRegistration(requestPermission) {
    var P = plugins().PushNotifications;
    if (!P) {
      setPushStatus('Push plugin unavailable', 'var(--warning)');
      return false;
    }
    try {
      var perm = await P.checkPermissions();
      if (perm.receive !== 'granted' && requestPermission) {
        perm = await P.requestPermissions();
      }
      var permEl = el('lsNotifPermission');
      if (permEl) permEl.textContent = perm.receive === 'granted' ? 'Granted' : (perm.receive || 'Denied');
      if (perm.receive !== 'granted') {
        setPushStatus('Permission not granted', 'var(--warning)');
        return false;
      }
      await P.register();
      setPushStatus('Registering…', 'var(--text)');
      return true;
    } catch (err) {
      console.warn('Push registration failed', err);
      setPushStatus('FCM not configured', 'var(--warning)');
      toast('Push registration failed. Confirm google-services.json is installed and FCM is enabled.', 'warning');
      return false;
    }
  }

  async function saveFcmToken(token) {
    if (!token) return;
    var db = getDb();
    if (!db) return;
    fcmToken = token;
    localStorage.setItem('landsafe_fcm_token', token);
    setPushStatus('Registered', 'var(--success)');

    var installId = getInstallationId();
    var poles = getSubscribedPoles();

    var devPayload = {
      token: token,
      active: true,
      platform: PLATFORM,
      installationId: installId,
      updatedAt: (window.firebase && firebase.database && firebase.database.ServerValue) ? firebase.database.ServerValue.TIMESTAMP : Date.now(),
      userAgent: (navigator.userAgent || '').slice(0, 180),
      poles: poles
    };

    try {
      await db.ref('fcm_devices/' + installId).set(devPayload);
      console.log('FCM device token registered under /fcm_devices/' + installId);
    } catch (err) {
      console.warn('Could not save to fcm_devices:', err);
      setPushStatus('Token not saved (rules?)', 'var(--warning)');
    }

    if (currentUser) {
      try {
        var sanitizedKey = String(token).replace(/[.#$\[\]/]/g, '_').slice(0, 1024);
        await db.ref('fcm_tokens/' + currentUser.uid + '/' + sanitizedKey).set({
          token: token,
          platform: PLATFORM,
          role: currentRole,
          updatedAt: Date.now(),
          poles: poles
        });
      } catch (err) { /* ignore */ }
    }
  }

  function setupPushListeners() {
    var P = plugins().PushNotifications;
    if (!P) return;
    P.addListener('registration', function (t) { saveFcmToken(t.value); });
    P.addListener('registrationError', function (err) {
      console.warn('FCM registration error', err);
      setPushStatus('FCM registration error', 'var(--danger)');
    });
    P.addListener('pushNotificationReceived', function (n) {
      var data = (n && n.data) || {};
      showInAppAlert(n && n.title ? n.title : (data.title || 'LandSafe alert'),
        n && n.body ? n.body : (data.body || data.reason || ''), data.severity || data.level || 'INFO', data);
      setTimeout(function () { if (alertsRef) renderAlertHistory(); }, 800);
    });
    P.addListener('pushNotificationActionPerformed', function (action) {
      var data = (action && action.notification && action.notification.data) || {};
      routeNotification(data);
    });
  }

  function showInAppAlert(title, body, severity, data) {
    var existing = el('lsInAppAlert');
    if (existing) existing.remove();
    var sev = String(severity || 'INFO').toUpperCase();
    var box = document.createElement('div');
    box.id = 'lsInAppAlert';
    box.className = 'ls-inapp-alert ' + (sev === 'CRITICAL' ? 'is-critical' : sev === 'WARNING' ? 'is-warning' : 'is-info');
    box.innerHTML =
      '<div class="ls-inapp-icon"><iconify-icon icon="' +
        (sev === 'CRITICAL' ? 'material-symbols:crisis-alert' : sev === 'WARNING' ? 'material-symbols:warning-rounded' : 'material-symbols:notifications-active') +
      '"></iconify-icon></div>' +
      '<div class="ls-inapp-text"><strong>' + esc(title) + '</strong><span>' + esc(body) + '</span></div>' +
      '<button type="button" aria-label="Open alerts" class="ls-inapp-open">View</button>' +
      '<button type="button" aria-label="Dismiss" class="ls-inapp-close">×</button>';
    document.body.appendChild(box);
    requestAnimationFrame(function () { box.classList.add('visible'); });
    box.querySelector('.ls-inapp-close').addEventListener('click', function () { dismissInAppAlert(); });
    box.querySelector('.ls-inapp-open').addEventListener('click', function () {
      dismissInAppAlert();
      routeNotification(data || {});
    });
    setTimeout(dismissInAppAlert, 15000);
  }

  function dismissInAppAlert() {
    var box = el('lsInAppAlert');
    if (!box) return;
    box.classList.remove('visible');
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 220);
  }

  function routeNotification(data) {
    if (typeof window.setPage === 'function') {
      window.setPage('alerts', document.getElementById('nav-alerts'));
    }
    if (data && data.alertId) {
      setTimeout(function () {
        if (alerts.some(function (a) { return a.id === data.alertId; })) openDetails(data.alertId);
      }, 1200);
    }
  }

  async function sendTestAlert(severity) {
    if (!currentUser) { toast('Sign in first.', 'warning'); return; }
    if (window.LANDSAFE_ALLOW_TEST_ALERTS !== true) { toast('Test alerts are disabled in this build.', 'warning'); return; }
    var sev = severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
    var base = window.LANDSAFE_FUNCTIONS_BASE_URL;
    if (!base) {
      var cfg = window.LANDSAFE_FIREBASE_CONFIG || {};
      var region = window.LANDSAFE_FUNCTIONS_REGION || 'asia-southeast1';
      base = 'https://' + region + '-' + (cfg.projectId || 'landslide-ews-12015') + '.cloudfunctions.net';
    }
    try {
      var token = await currentUser.getIdToken();
      var res = await fetch(base.replace(/\/$/, '') + '/sendTestAlert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ severity: sev })
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
      toast('Test ' + sev + ' alert sent to this account’s devices.', 'info');
    } catch (err) {
      toast('Test alert failed: ' + (err && err.message ? err.message : 'unknown error'), 'warning');
    }
  }

  function openNotificationSettings() {
    var N = plugins().LandSafeNative;
    if (N && typeof N.openNotificationSettings === 'function') {
      N.openNotificationSettings().catch(function () { toast('Could not open Android notification settings.', 'warning'); });
    } else {
      toast('Open Android Settings → Apps → LandSafe → Notifications.', 'info');
    }
  }

  /* ─────────────────────── Mobile shell ──────────────────────── */

  function setupMobileNav() {
    if (el('lsBottomNav')) return;
    var items = [
      { page: 'overview', icon: 'material-symbols:dashboard', label: 'Overview' },
      { page: 'live', icon: 'material-symbols:sensors', label: 'Live' },
      { page: 'map3d', icon: 'material-symbols:map', label: 'Map' },
      { page: 'alerts', icon: 'material-symbols:warning', label: 'Alerts' },
      { page: 'settings', icon: 'material-symbols:settings', label: 'Settings' }
    ];
    var nav = document.createElement('nav');
    nav.id = 'lsBottomNav';
    nav.setAttribute('aria-label', 'Primary navigation');
    nav.innerHTML = items.map(function (it) {
      return '<button type="button" class="ls-nav-btn" data-page="' + it.page + '">' +
        '<iconify-icon icon="' + it.icon + '"></iconify-icon><span>' + it.label + '</span></button>';
    }).join('');
    document.body.appendChild(nav);
    nav.addEventListener('click', function (e) {
      var btn = e.target.closest('.ls-nav-btn');
      if (!btn) return;
      var page = btn.dataset.page;
      if (typeof window.setPage === 'function') {
        window.setPage(page, document.getElementById('nav-' + page));
      }
      syncBottomNav(page);
    });

    // Keep the bottom bar in sync when navigation happens programmatically
    // (notification taps, in-app links) or via the desktop sidebar.
    var originalSetPage = window.setPage;
    if (typeof originalSetPage === 'function') {
      window.setPage = function (page, navEl) {
        var result = originalSetPage.apply(this, arguments);
        syncBottomNav(page);
        return result;
      };
    }
    syncBottomNav('overview');
  }

  function syncBottomNav(page) {
    var nav = el('lsBottomNav');
    if (!nav) return;
    nav.querySelectorAll('.ls-nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === page);
    });
  }

  function setupNetworkBanner() {
    if (el('lsOfflineBanner')) return;
    var b = document.createElement('div');
    b.id = 'lsOfflineBanner';
    b.className = 'ls-top-banner ls-top-banner-offline';
    b.innerHTML = '<iconify-icon icon="material-symbols:wifi-off"></iconify-icon><span>Offline — showing the last loaded data. New alerts will not arrive until the connection returns.</span>';
    b.style.display = navigator.onLine ? 'none' : 'flex';
    document.body.appendChild(b);
    function update() { b.style.display = navigator.onLine ? 'none' : 'flex'; }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    var N = plugins().Network;
    if (N && typeof N.addListener === 'function') {
      N.addListener('networkStatus', function (status) {
        b.style.display = status && status.connected ? 'none' : 'flex';
      });
    }
  }

  function setupBackButton() {
    var App = plugins().App;
    if (!App || typeof App.addListener !== 'function') return;
    App.addListener('backButton', function () {
      var visibleModal = document.querySelector('.modal-overlay.visible');
      if (visibleModal) {
        visibleModal.classList.remove('visible');
        setTimeout(function () { if (visibleModal.id !== 'resetModal' && visibleModal.id !== 'sensorDetailModal' && visibleModal.id !== 'lsAlertDetailModal') visibleModal.style.display = 'none'; }, 220);
        if (visibleModal.id === 'lsAlertDetailModal') currentAlertId = null;
        return;
      }
      if (el('lsAuthOverlay') && el('lsAuthOverlay').classList.contains('visible')) {
        if (App.minimizeApp) App.minimizeApp();
        return;
      }
      var active = document.querySelector('.page-section.active');
      if (active && active.id !== 'page-overview') {
        if (typeof window.setPage === 'function') window.setPage('overview', document.getElementById('nav-overview'));
        return;
      }
      if (App.minimizeApp) App.minimizeApp();
      else if (App.exitApp) App.exitApp();
    });
    App.addListener('appStateChange', function (state) {
      if (state && state.isActive && currentUser && IS_NATIVE) {
        ensurePushRegistration(false);
      }
    });
  }

  function applyStatusBar() {
    var SB = plugins().StatusBar;
    if (!SB) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    try {
      if (SB.setStyle) SB.setStyle({ style: dark ? 'LIGHT' : 'DARK' });
      if (SB.setBackgroundColor) SB.setBackgroundColor({ color: dark ? '#0F172A' : '#F8FAFC' });
      if (SB.setOverlaysWebView) SB.setOverlaysWebView({ overlay: false });
    } catch (e) { /* web */ }
  }
  window.LandSafeSetStatusBar = function (theme) {
    var SB = plugins().StatusBar;
    if (!SB) return;
    var dark = theme === 'dark';
    try {
      if (SB.setStyle) SB.setStyle({ style: dark ? 'LIGHT' : 'DARK' });
      if (SB.setBackgroundColor) SB.setBackgroundColor({ color: dark ? '#0F172A' : '#F8FAFC' });
    } catch (e) { /* ignore */ }
  };

  /* ─────────────────────── File exports ──────────────────────── */

  window.LandSafeSaveWorkbook = async function (wb, filename) {
    if (!IS_NATIVE || typeof XLSX === 'undefined') {
      XLSX.writeFile(wb, filename);
      return;
    }
    var F = plugins().Filesystem;
    var S = plugins().Share;
    if (!F) { XLSX.writeFile(wb, filename); return; }
    try {
      var ext = String(filename).split('.').pop().toLowerCase();
      var bookType = ext === 'csv' ? 'csv' : 'xlsx';
      var base64 = XLSX.write(wb, { bookType: bookType, type: 'base64' });
      var res = await F.writeFile({
        path: 'LandSafe/' + filename,
        data: base64,
        directory: 'DOCUMENTS',
        recursive: true
      });
      toast('Saved to Documents/LandSafe/' + filename, 'info');
      if (S && res && res.uri) {
        try {
          await S.share({ title: filename, url: res.uri, dialogTitle: 'Share ' + filename });
        } catch (e) { /* user cancelled share */ }
      }
    } catch (err) {
      console.error('Native save failed', err);
      toast('Could not save file: ' + (err && err.message ? err.message : 'unknown error'), 'warning');
    }
  };

  /* ────────────────────────── Globals ────────────────────────── */

  window.LandSafeAuth = {
    showSignIn: function () { showAuthOverlay(''); },
    signOut: signOut,
    get role() { return currentRole; },
    get user() { return currentUser; }
  };

  window.LandSafeNotifications = {
    enable: function () { ensurePushRegistration(true); },
    openSettings: openNotificationSettings,
    sendTest: sendTestAlert,
    getPoleSubscriptions: getSubscribedPoles,
    setPoleSubscription: async function (pole, isSubscribed) {
      var current = getSubscribedPoles();
      current[pole] = !!isSubscribed;
      localStorage.setItem('landsafe_subscribed_poles', JSON.stringify(current));
      var db = getDb();
      var installId = getInstallationId();
      if (db) {
        await db.ref('fcm_devices/' + installId + '/poles/' + pole).set(!!isSubscribed).catch(function () {});
      }
      return current;
    }
  };

  window.LandSafeAlertHistory = {
    setFilter: function (key, value) {
      if (key in alertFilters) alertFilters[key] = value;
      alertPage = 1;
      renderAlertHistory();
    },
    toggleUnreadOnly: function () {
      alertFilters.unreadOnly = !alertFilters.unreadOnly;
      var b = el('lsAlertUnreadOnly');
      if (b) b.classList.toggle('active', alertFilters.unreadOnly);
      alertPage = 1;
      renderAlertHistory();
    },
    resetFilters: function () {
      alertFilters = { severity: 'all', node: 'all', from: '', to: '', unreadOnly: false };
      if (el('lsAlertSeverity')) el('lsAlertSeverity').value = 'all';
      if (el('lsAlertNode')) el('lsAlertNode').value = 'all';
      if (el('lsAlertFrom')) el('lsAlertFrom').value = '';
      if (el('lsAlertTo')) el('lsAlertTo').value = '';
      var b = el('lsAlertUnreadOnly');
      if (b) b.classList.remove('active');
      alertPage = 1;
      renderAlertHistory();
    },
    refresh: function () { subscribeAlerts(); },
    markAllRead: markAllRead,
    acknowledge: acknowledge,
    acknowledgeCurrent: acknowledgeCurrent,
    openDetails: openDetails,
    closeDetails: closeDetails,
    prevPage: function () { if (alertPage > 1) { alertPage--; renderAlertHistory(); } },
    nextPage: function () { alertPage++; renderAlertHistory(); }
  };

  // Preserve the dashboard's local alert badge behaviour while additionally
  // surfacing unread cloud alerts.
  if (typeof window.updateAlertBadge === 'function') {
    var originalUpdateAlertBadge = window.updateAlertBadge;
    window.updateAlertBadge = function (count) {
      lastLocalAlertCount = parseInt(count, 10) || 0;
      originalUpdateAlertBadge.apply(this, arguments);
      updateUnreadBadge();
    };
  }

  /* ─────────────────────────── Start ─────────────────────────── */

  // The dashboard dispatches this on window (not document): events dispatched
  // on window do not propagate down to document listeners.
  window.addEventListener('landsafe:dashboard-ready', function () {
    dashboardReady = true;
    if (IS_NATIVE) {
      setupPushListeners();
    }
    setupAuth();
  }, { once: true });

  // If the dashboard script failed before dispatch, do not leave the WebView
  // on a blank screen; surface the failure instead.
  setTimeout(function () {
    if (!dashboardReady) {
      showConfigBanner('Dashboard initialisation did not complete. Check the browser console for errors.');
    }
  }, 12000);

})();
