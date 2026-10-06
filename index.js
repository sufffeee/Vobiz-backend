const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const Redis = require('ioredis');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Persistent store.
//
// Memory is always the read path (single instance, zero latency). Redis, when
// REDIS_URL is configured, is the durability layer: every write is mirrored
// there and state is rehydrated from it on boot, so a redeploy no longer wipes
// FCM tokens, the dial log or the parked conference room. If Redis is absent
// or errors, the app keeps running on memory alone - a cache outage must never
// take down live calls.
// ---------------------------------------------------------------------------
const REDIS_URL = process.env.REDIS_URL || null;
const KEY_TOKENS = 'vobiz:fcm:tokens';   // hash: deviceId -> FCM token
const KEY_DIALLOG = 'vobiz:dial:log';    // list: newest 50 dial/callback events
const KEY_CONFERENCE = 'vobiz:conference:last'; // string: parked room name
const DIAL_LOG_MAX = 50;

let redis = null;
let redisState = REDIS_URL ? 'connecting' : 'disabled';

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 1000, 10000),
    lazyConnect: false,
  });
  redis.on('ready', () => {
    redisState = 'connected';
    console.log('[STARTUP] Redis connected');
  });
  redis.on('error', (e) => {
    if (redisState !== 'error') console.warn('[REDIS] error:', e.message);
    redisState = 'error';
  });
  redis.on('close', () => {
    if (redisState === 'connected') redisState = 'reconnecting';
  });
} else {
  console.log('[STARTUP] REDIS_URL not set - state is in-memory only (lost on restart)');
}

// Fire-and-forget write to Redis; failures are logged, never thrown.
const persist = (fn) => {
  if (!redis) return;
  Promise.resolve()
    .then(() => fn(redis))
    .catch((e) => console.warn('[REDIS] persist failed:', e.message));
};

// In-memory mirrors (read path).
const deviceTokens = new Map();
const recentDialStatus = [];
let lastConferenceRoom = null;

// Rehydrate memory from Redis after a restart.
const hydrate = async () => {
  if (!redis) return;
  try {
    const tokens = await redis.hgetall(KEY_TOKENS);
    for (const [deviceId, token] of Object.entries(tokens || {})) {
      deviceTokens.set(deviceId, token);
    }
    const raw = await redis.lrange(KEY_DIALLOG, 0, -1);
    for (const line of raw) {
      try { recentDialStatus.push(JSON.parse(line)); } catch (_) { /* skip bad entry */ }
    }
    lastConferenceRoom = await redis.get(KEY_CONFERENCE);
    console.log(
      `[STARTUP] Redis hydrated: tokens=${deviceTokens.size} ` +
      `dialLog=${recentDialStatus.length} conference=${lastConferenceRoom || 'none'}`
    );
  } catch (e) {
    console.warn('[STARTUP] Redis hydrate failed (continuing with memory):', e.message);
  }
};
hydrate();

// Process start time - surfaced on /health to confirm a redeploy/restart.
const STARTED_AT = new Date().toISOString();

// Append a dial/callback event: memory keeps the newest DIAL_LOG_MAX, Redis
// mirrors it (RPUSH + LTRIM so the list never grows past the cap).
const recordDialEvent = (entry) => {
  recentDialStatus.push(entry);
  if (recentDialStatus.length > DIAL_LOG_MAX) recentDialStatus.shift();
  persist(async (r) => {
    await r.rpush(KEY_DIALLOG, JSON.stringify(entry));
    await r.ltrim(KEY_DIALLOG, -DIAL_LOG_MAX, -1);
  });
};

// Initialize Firebase Admin SDK if credentials are provided
let firebaseInitialized = false;
let firebaseProject = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  firebaseInitialized = true;
  firebaseProject = serviceAccount.project_id || null;
  console.log(`[STARTUP] Firebase Admin SDK initialized successfully (project=${firebaseProject})`);
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
  if (ANSWER_MODE === 'conference') {
    lastConferenceRoom = conferenceName;
    persist((r) => r.set(KEY_CONFERENCE, conferenceName));
  }

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
  recordDialEvent({ ts: new Date().toISOString(), src: 'action', data: b });
  res.status(200).send('OK');
});

// Real-time B-leg lifecycle events (callbackUrl of the <Dial> element):
// DialAnswer / DialConnected / hangup. Answers when the B-leg answered, which
// is what decides whether the platform will ever send a BYE for it.
app.all('/dial-callback', (req, res) => {
  const b = { ...req.query, ...req.body };
  console.log(`[DIAL-CALLBACK] ${JSON.stringify(b)}`);
  recordDialEvent({ ts: new Date().toISOString(), src: 'callback', data: b });
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
  persist((r) => r.hset(KEY_TOKENS, deviceId, token));
  console.log(`[REGISTER] Device ${deviceId} registered`);
  res.json({ success: true });
});

// --- Endpoint 3: Hangup Webhook ---
app.post('/hangup', (req, res) => {
  const { CallUUID, Duration, HangupCause } = req.body;
  console.log(`[HANGUP] CallUUID=${CallUUID} Duration=${Duration} Cause=${HangupCause}`);
  res.status(200).send('OK');
});

// --- Health Check / config verification ---
//   firebase  -> service account parsed + accepted by firebase-admin
//   project   -> which Firebase project the key belongs to; must equal the
//                app's google-services.json project_id (currently vobiz-fire)
//   mode      -> ANSWER_MODE actually in effect
//   redis     -> disabled | connecting | connected | error
//   startedAt -> proves the service restarted after a variable change
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    devices: deviceTokens.size,
    firebase: firebaseInitialized,
    project: firebaseProject,
    mode: ANSWER_MODE,
    redis: redisState,
    startedAt: STARTED_AT,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));