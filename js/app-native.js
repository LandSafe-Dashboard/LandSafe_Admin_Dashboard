/* LandSafe Mobile — Native Bridge & Core Telemetry Controller
 * Integrates:
 * - Capacitor Geolocation & runtime permissions
 * - Firebase Realtime Database (/sensors, /weather, /alerts)
 * - Firebase Anonymous Auth & FCM Push Notifications
 * - Haversine distance & nearest pole finder
 * - Sira-style Landslide Risk Evaluation
 */

(function () {
  'use strict';

  var Cap = window.Capacitor;
  var IS_NATIVE = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  var PLATFORM = Cap && typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : 'web';

  function plugins() { return (window.Capacitor && window.Capacitor.Plugins) || {}; }
  function getDb() { return window.LandSafeFirebase && window.LandSafeFirebase.db; }
  function getAuth() { return window.LandSafeFirebase && window.LandSafeFirebase.auth; }

  // ══════════════════════════════════════════════════════════════════════
  // GEOLOCATION ENGINE
  // ══════════════════════════════════════════════════════════════════════
  var userLocation = null; // { lat, lon, accuracy, timestamp }
  var watchId = null;

  async function requestLocationPermission() {
    var Geo = plugins().Geolocation;
    if (Geo && typeof Geo.requestPermissions === 'function') {
      try {
        var status = await Geo.requestPermissions();
        return status.location === 'granted' || status.coarseLocation === 'granted';
      } catch (e) {
        console.warn('Capacitor location permission error:', e);
      }
    }
    return true; // Fallback to browser prompt
  }

  async function getCurrentUserPosition(options) {
    var Geo = plugins().Geolocation;
    var opts = Object.assign({ enableHighAccuracy: true, timeout: 12000, maximumAge: 3000 }, options || {});

    // Try native Capacitor Geolocation first
    if (Geo && typeof Geo.getCurrentPosition === 'function') {
      try {
        var permGranted = await requestLocationPermission();
        if (permGranted) {
          var pos = await Geo.getCurrentPosition(opts);
          if (pos && pos.coords) {
            userLocation = {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              timestamp: pos.timestamp || Date.now()
            };
            return userLocation;
          }
        }
      } catch (err) {
        console.warn('Native geolocation failed, falling back to Web API:', err);
      }
    }

    // Web Geolocation Fallback
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported on this device'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          userLocation = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp || Date.now()
          };
          resolve(userLocation);
        },
        function (err) {
          reject(err);
        },
        opts
      );
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // HAVERSINE DISTANCE FORMULA
  // ══════════════════════════════════════════════════════════════════════
  function haversineKm(lat1, lon1, lat2, lon2) {
    if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
      return Infinity;
    }
    var R = 6371; // Earth radius in km
    var toRad = function (x) { return (x * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ══════════════════════════════════════════════════════════════════════
  // FCM / NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════
  var fcmToken = localStorage.getItem('landsafe_fcm_token') || null;
  var pushRegistered = false;

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

  function saveFcmToken(token) {
    if (!token) return;
    fcmToken = token;
    localStorage.setItem('landsafe_fcm_token', token);
    var db = getDb();
    if (!db) return;

    var installId = getInstallationId();
    var poles = getSubscribedPoles();

    var devPayload = {
      token: token,
      active: true,
      platform: PLATFORM,
      installationId: installId,
      updatedAt: Date.now(),
      userAgent: (navigator.userAgent || '').slice(0, 180),
      poles: poles
    };

    try {
      db.ref('fcm_devices/' + installId).set(devPayload).catch(function(e) {
        console.warn('Could not save to fcm_devices:', e);
      });
    } catch (e) {}

    var user = getAuth() ? getAuth().currentUser : null;
    if (user) {
      try {
        var sanitizedKey = String(token).replace(/[.#$\[\]/]/g, '_').slice(0, 1024);
        db.ref('fcm_tokens/' + user.uid + '/' + sanitizedKey).set({
          token: token,
          platform: PLATFORM,
          updatedAt: Date.now(),
          poles: poles
        }).catch(function (e) { console.warn('Could not save FCM token:', e); });
      } catch (e) { /* ignore */ }
    }
  }

  async function initPushNotifications() {
    if (!IS_NATIVE) return;
    var P = plugins().PushNotifications;
    if (!P) return;

    try {
      var perm = await P.checkPermissions();
      if (perm.receive !== 'granted') {
        perm = await P.requestPermissions();
      }
      if (perm.receive === 'granted') {
        await P.register();
      }

      P.addListener('registration', function (t) {
        var token = t && t.value ? t.value : t;
        saveFcmToken(token);
        pushRegistered = true;
      });

      P.addListener('pushNotificationReceived', function (n) {
        var data = (n && n.data) || {};
        var title = (n && n.title) || (data && data.title) || 'LandSafe Alert';
        var body = (n && n.body) || (data && data.body) || (data && data.reason) || '';
        var severity = (data && data.severity) || 'WARNING';
        if (typeof window.showToast === 'function') {
          window.showToast(title + ': ' + body);
        }
        if (typeof window.triggerInAppAlert === 'function') {
          window.triggerInAppAlert(title, body, severity);
        }
      });

      P.addListener('pushNotificationActionPerformed', function (action) {
        if (typeof window.switchPage === 'function') {
          window.switchPage('alerts');
        }
      });
    } catch (err) {
      console.warn('Push init error:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // OPEN NATIVE SETTINGS
  // ══════════════════════════════════════════════════════════════════════
  function openAppSettings() {
    var Native = plugins().LandSafeNative;
    if (Native && typeof Native.openNotificationSettings === 'function') {
      Native.openNotificationSettings().catch(function (e) {
        console.warn('Native open settings error:', e);
      });
    } else {
      if (typeof window.showToast === 'function') {
        window.showToast('Open Settings > Apps > LandSafe to manage permissions.');
      }
    }
  }

  function setPoleSubscription(pole, enabled) {
    var poles = getSubscribedPoles();
    poles[pole] = !!enabled;
    localStorage.setItem('landsafe_subscribed_poles', JSON.stringify(poles));
    if (fcmToken) {
      saveFcmToken(fcmToken);
    }
  }

  // Export to Global Scope
  window.LandSafeNative = {
    isNative: IS_NATIVE,
    platform: PLATFORM,
    getUserLocation: function () { return userLocation; },
    getCurrentPosition: getCurrentUserPosition,
    haversineKm: haversineKm,
    initPush: initPushNotifications,
    openSettings: openAppSettings,
    getPoleSubscriptions: getSubscribedPoles,
    setPoleSubscription: setPoleSubscription,
    getInstallationId: getInstallationId
  };

})();
