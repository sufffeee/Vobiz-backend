const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory token store (use Redis or DB in production)
const deviceTokens = new Map();

// Diagnostic: store recent dial-status callbacks for inspection
const recentDialStatus = [];

// Room of the most recent parked caller — the app's join leg (its outbound
// call to our DID, From = DID) is bridged into this same room.
let lastConferenceRoom = null;

// Initialize Firebase Admin SDK if credentials are provided
let firebaseInitialized = false;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  firebaseInitialized = true;
  console.log('[STARTUP] Firebase Admin SDK initialized successfully');
} catch (e) {
  console.warn('[STARTUP] Firebase Admin SDK initialization failed (FCM will be disabled):', e.message);
  console.warn('[STARTUP] FCM notifications will be disabled. Provide valid FIREBASE_SERVICE_ACCOUNT to enable.');
}

// Phase 1 (default): 'dial' = normal direct call (Vobiz <Dial> bridges caller
// straight to the app's SIP endpoint). Phase 2 (AI): 'conference' = park caller
// in a conference + FCM wake, app joins the bridge.
const ANSWER_MODE = process.env.ANSWER_MODE || 'dial';

// --- Endpoint 1: Vobiz Answer Webhook ---
// Vobiz may deliver via GET (query string) or POST (form body) depending on the
// application's answer_method; accept both and normalize params.
const handleAnswer = async (req, res) => {
  const { CallUUID, From, To, Direction } = { ...req.query, ...req.body };
  console.log(`[ANSWER] ${req.method} CallUUID=${CallUUID} From=${From} To=${To} Direction=${Direction} mode=${ANSWER_MODE}`);

  // App join-leg: the app's outbound call to our DID (callerId = DID) comes
  // back through this same webhook. Join the parked caller's room instead of
  // creating a new one, and skip the FCM wake (the app is already in a call).
  const fromDigits = String(From || '').replace(/\D/g, '');
  if (fromDigits === '917965850027' && lastConferenceRoom) {
    console.log(`[ANSWER] join-leg From=${From} -> joining room=${lastConferenceRoom}`);
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Conference startConferenceOnEnter="true"
                endConferenceOnExit="true"
                maxMembers="2">
        ${lastConferenceRoom}
    </Conference>
</Response>`);
  }

  // Generate a unique conference name
  const conferenceName = `vobiz-dialer-${CallUUID}-${Date.now()}`;
  if (ANSWER_MODE === 'conference') lastConferenceRoom = conferenceName;

  // Send FCM to all registered devices (only in conference mode; in dial mode
  // the SIP INVITE itself rings the app, so an FCM wake would duplicate UI)
  const tokens = Array.from(deviceTokens.values());
  if (ANSWER_MODE === 'conference') {
    console.log(`[ANSWER] Sending FCM to ${tokens.length} devices`);

    if (tokens.length > 0 && firebaseInitialized) {
      const message = {
        data: {
          type: 'incoming_call',
          conference_name: conferenceName,
          caller_number: From || 'Unknown',
          call_uuid: CallUUID || ''
        },
        android: { priority: 'high' },
        tokens: tokens
      };

      try {
        const response = await getMessaging().sendEachForMulticast(message);
        console.log(`[ANSWER] FCM sent: ${response.successCount} success, ${response.failureCount} failed`);
      } catch (e) {
        console.error('[ANSWER] FCM send failed:', e);
      }
    } else if (tokens.length > 0 && !firebaseInitialized) {
      console.warn('[ANSWER] Firebase not initialized, skipping FCM send');
    }
  }

  // Phase 1: bridge the caller directly to the registered app endpoint
  const xml = ANSWER_MODE === 'conference'
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Conference startConferenceOnEnter="true"
                endConferenceOnExit="true"
                waitSound="https://actions.google.com/sounds/v1/alarms/beep_short.ogg"
                maxMembers="2">
        ${conferenceName}
    </Conference>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="45" dialMusic="real" callerId="+917965850027"
          callbackUrl="https://vobiz-backend-production.up.railway.app/dial-callback" callbackMethod="POST"
          action="https://vobiz-backend-production.up.railway.app/dial-status" method="POST" redirect="false">
        <User>sip:sairam8391265128911238046@registrar.vobiz.ai</User>
    </Dial>
    <Speak>The customer is not available. Please try again later.</Speak>
    <Hangup/>
</Response>`;

  res.type('application/xml').send(xml);
};

app.all('/answer', handleAnswer);

// Dial result diagnostic (action= URL of the <Dial> element)
app.all('/dial-status', (req, res) => {
  const b = { ...req.query, ...req.body };
  console.log(`[DIAL-STATUS] ${JSON.stringify(b)}`);
  recentDialStatus.push({ ts: new Date().toISOString(), src: 'action', data: b });
  if (recentDialStatus.length > 50) recentDialStatus.shift();
  res.status(200).send('OK');
});

// Real-time B-leg lifecycle events (callbackUrl of the <Dial> element):
// DialAnswer / DialConnected / hangup. Answers when the B-leg answered, which
// is what decides whether the platform will ever send a BYE for it.
app.all('/dial-callback', (req, res) => {
  const b = { ...req.query, ...req.body };
  console.log(`[DIAL-CALLBACK] ${JSON.stringify(b)}`);
  recentDialStatus.push({ ts: new Date().toISOString(), src: 'callback', data: b });
  if (recentDialStatus.length > 50) recentDialStatus.shift();
  res.status(200).send('OK');
});

// Retrieve recent dial-status events
app.get('/dial-log', (req, res) => {
  res.json(recentDialStatus);
});

// Probe route: returns Speak+Hangup so a successful route is visible in CDR
app.all('/probe-answer', (req, res) => {
  console.log(`[PROBE] answered CallUUID=${req.body?.CallUUID || req.query?.CallUUID} From=${req.body?.From || req.query?.From} To=${req.body?.To || req.query?.To}`);
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Speak>probe ok</Speak><Hangup/></Response>');
});

// --- Endpoint 2: Register FCM Token ---
app.post('/register-token', (req, res) => {
  const { token, deviceId } = req.body;
  if (!token || !deviceId) {
    return res.status(400).json({ error: 'Missing token or deviceId' });
  }
  deviceTokens.set(deviceId, token);
  console.log(`[REGISTER] Device ${deviceId} registered`);
  res.json({ success: true });
});

// --- Endpoint 3: Hangup Webhook ---
app.post('/hangup', (req, res) => {
  const { CallUUID, Duration, HangupCause } = req.body;
  console.log(`[HANGUP] CallUUID=${CallUUID} Duration=${Duration} Cause=${HangupCause}`);
  res.status(200).send('OK');
});

// --- Health Check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', devices: deviceTokens.size, firebase: firebaseInitialized });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));