/*
 * LandSafe Firebase web configuration
 * -----------------------------------
 * Fill these values from Firebase Console → Project settings → Your apps →
 * Web app → SDK setup and configuration. These are public client identifiers,
 * NOT service-account credentials. Never put a service-account JSON file or a
 * private key in this project or in the APK.
 *
 * Authentication requires apiKey, authDomain, and appId. Native push also
 * requires messagingSenderId plus a real android/app/google-services.json.
 * The dashboard can still read the Realtime Database with only databaseURL if
 * the currently deployed rules allow public reads. Secure rules require sign-in.
 */
window.LANDSAFE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBJ5FSaPAEYNscKVF1WygRyPmBI0v91MHg",
  authDomain: "landslide-ews-12015.firebaseapp.com",
  databaseURL: "https://landslide-ews-12015-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "landslide-ews-12015",
  storageBucket: "landslide-ews-12015.firebasestorage.app",
  messagingSenderId: "937196153027",
  appId: "1:937196153027:web:4852a094cd591210a39a76",
  measurementId: "G-GX0R8KCT8P"
};

/* Cloud Functions region used by the alert engine. */
window.LANDSAFE_FUNCTIONS_REGION = "asia-southeast1";

/*
 * Optional: override the callable-function base URL. Leave blank to derive it
 * from the project ID as:
 * https://<region>-<projectId>.cloudfunctions.net
 */
window.LANDSAFE_FUNCTIONS_BASE_URL = "";

/*
 * Development-only test alerts. When true, administrators see "Test warning"
 * and "Test critical" buttons in Settings. The Cloud Function additionally
 * requires ALLOW_TEST_ALERTS=true in its environment, so do not enable this
 * for production deployments.
 */
window.LANDSAFE_ALLOW_TEST_ALERTS = false;
