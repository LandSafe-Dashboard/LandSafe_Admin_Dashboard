/* LandSafe App — native bridge for the simplified mobile interface.
 *
 * Handles Firebase Anonymous Auth sign-in completion, FCM push
 * registration, push notification listeners, and in-app alert display.
 * Loaded only by www/app.html (the Android app shell), not by the web
 * dashboard (index.html).
 *
 * Call window.LandSafeAppNative.init() after Firebase is initialized.
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
  function el(id) { return document.getElementById(id); }

  var fcmToken = localStorage.getItem('landsafe_fcm_token') || null;
  var pushRegistered = false;
  var authInitialized = false;

  // ══════════════════════════════════════════════════════════════════════
  // FCM / PUSH
  // ══════════════════════════════════════════════════════════════════════

  function setPushStatus(msg, color) {
    var e = el('topStatusText');
    if (e) e.textContent = msg;
  }

  function saveFcmToken(token) {
    if (!token) return;
    var user = getAuth() ? getAuth().currentUser : null;
    if (!user) {
      fcmToken = token;
      localStorage.setItem('landsafe_fcm_token', token);
      return;
    }
    var db = getDb();
    if (!db) return;
    var old = localStorage.getItem('landsafe_fcm_token');
    fcmToken = token;
    localStorage.setItem('landsafe_fcm_token', token);
    try {
      if (old && old !== token) {
        db.ref('fcm_tokens/' + user.uid + '/' + old).remove().catch(function () { /* ignore */ });
      }
      db.ref('fcm_tokens/' + user.uid + '/' + token).set({
        token: token,
        platform: PLATFORM,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
        userAgent: navigator.userAgent.slice(0, 180)
      }).catch(function (err) {
        console.warn('Could not save FCM token', err);
      });
    } catch (err) {
      console.warn('FCM token save error', err);
    }
  }

  function setupPushListeners() {
    var P = plugins().PushNotifications;
    if (!P) {
      setPushStatus('Push plugin unavailable', 'var(--warning)');
      return;
    }
    P.addListener('registration', function (t) {
      var token = t && t.value ? t.value : t;
      saveFcmToken(token);
      pushRegistered = true;
      setPushStatus('Push registered', 'var(--success)');
    });
    P.addListener('registrationError', function (err) {
      console.warn('FCM registration error', err);
      setPushStatus('FCM registration failed', 'var(--warning)');
    });
    P.addListener('pushNotificationReceived', function (n) {
      var data = (n && n.data) || {};
      var title = (n && n.title) || (data && data.title) || 'LandSafe alert';
      var body = (n && n.body) || (data && data.body) || (data && data.reason) || '';
      var severity = (data && data.severity) || 'INFO';
      if (typeof window.showInAppAlert === 'function') {
        window.showInAppAlert(title, body, severity, data || {});
      }
      toast(title + ': ' + body, 'info');
    });
    P.addListener('pushNotificationActionPerformed', function (action) {
      var data = (action && action.notification && action.notification.data) || {};
      if (typeof window.switchPage === 'function') {
        window.switchPage('alerts', document.getElementById('nav-alerts'));
      }
      if (data && data.alertId && typeof window.openAlertDetail === 'function') {
        setTimeout(function () { window.openAlertDetail(data.alertId); }, 800);
      }
    });
  }

  async function ensurePushRegistration(requestPermission) {
    if (!IS_NATIVE) return false;
    var P = plugins().PushNotifications;
    if (!P) { setPushStatus('Push plugin unavailable', 'var(--warning)'); return false; }
    try {
      var perm = await P.checkPermissions();
      if (perm.receive !== 'granted' && requestPermission) {
        perm = await P.requestPermissions();
      }
      if (perm.receive !== 'granted') {
        setPushStatus('Notification permission denied', 'var(--warning)');
        toast('Enable notifications in Android Settings to receive alerts.', 'warning');
        return false;
      }
      await P.register();
      setPushStatus('Registering push…', 'var(--text)');
      return true;
    } catch (err) {
      console.warn('Push registration failed', err);
      setPushStatus('FCM not configured', 'var(--warning)');
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // AUTH STATE — after anonymous sign-in, register push
  // ══════════════════════════════════════════════════════════════════════

  function onAuthenticated(user) {
    if (!user) return;
    var tok = fcmToken || localStorage.getItem('landsafe_fcm_token');
    if (tok) saveFcmToken(tok);
    if (IS_NATIVE && !pushRegistered) {
      ensurePushRegistration(true);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PUBLIC INIT — called from app.html after Firebase init
  // ══════════════════════════════════════════════════════════════════════

  window.LandSafeAppNative = {
    init: function () {
      var auth = getAuth();
      if (!auth) {
        setPushStatus('Firebase Auth not configured', 'var(--warning)');
        return;
      }
      auth.onAuthStateChanged(function (user) {
        if (user) {
          onAuthenticated(user);
        } else if (typeof window.signInAnonymously === 'function') {
          window.signInAnonymously();
        }
      });
      if (auth.currentUser) {
        onAuthenticated(auth.currentUser);
      }
      if (IS_NATIVE) {
        setupPushListeners();
      }
      authInitialized = true;
    }
  };

})();
