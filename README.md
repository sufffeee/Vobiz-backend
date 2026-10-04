# Vobiz Dialer Backend

Backend service for Vobiz Dialer - handles inbound call routing via Vobiz Voice XML.

## Architecture

```
PSTN → Vobiz DID (+917965850027) 
    → Vobiz Application (webhook) 
    → This backend (/answer) 
    → Returns Dial XML 
    → Platform sends SIP INVITE to registered Android app
```

## Deploy to Railway (Free Tier)

1. **Fork/clone this repo**
2. **Create Railway project** → "Deploy from GitHub repo"
3. **Add Environment Variables** in Railway dashboard:
   ```
   FIREBASE_SERVICE_ACCOUNT=<full JSON from .env>
   VOBIZ_AUTH_ID=MA_4272LINL
   VOBIZ_AUTH_TOKEN=<your Vobiz API token>
   PORT=3000
   ```
3. **Deploy** → Get stable HTTPS URL (e.g., `https://your-app.railway.app`)
4. **Update Vobiz Application** with webhook URLs:
   ```
   POST https://api.vobiz.ai/api/v1/Account/MA_4272LINL/Application/85076776948601220/
   Body: {
     "answer_url": "https://your-app.railway.app/answer",
     "hangup_url": "https://your-app.railway.app/hangup"
   }
   ```

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/answer` | POST/GET | Vobiz Answer webhook - returns Dial XML |
| `/hangup` | POST | Vobiz Hangup webhook - logs call end |
| `/register-token` | POST | Register FCM device token |
| `/health` | GET | Health check (`{status, devices, firebase}`) |
| `/dial-status` | POST | Dial action callback (diagnostic) |

## Answer Webhook Response (Dial XML)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="45" dialMusic="real" callerId="+917965850027"
          action="https://your-app.railway.app/dial-status" method="POST" redirect="false">
        <User>sip:sairam8391265128911238046@registrar.vobiz.ai</User>
    </Dial>
    <Speak>The customer is not available. Please try again later.</Speak>
    <Hangup/>
</Response>
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Full Firebase Admin SDK JSON |
| `VOBIZ_AUTH_ID` | Yes | Vobiz Account Auth ID |
| `VOBIZ_AUTH_TOKEN` | Yes | Vobiz API Token |
| `PORT` | No | Server port (default 3000) |
| `ANSWER_MODE` | No | `dial` (default) or `conference` |

## Vobiz Configuration

- **Account**: `MA_4272LINL`
- **Endpoint**: `sairam8391265128911238046@registrar.vobiz.ai` (ID: 269321988178847)
- **DID**: `+917965850027`
- **Application**: `85076776948601220` (Vobiz WebRTC Playground)
- **Trunk (Outbound)**: `08ecd76e.sip.vobiz.ai` (credential: `dialer_trunk_auth`)

## Quick Test

```bash
# Health check
curl https://your-app.railway.app/health

# Trigger test call via Vobiz API
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_4272LINL/Call/" \
  -H "X-Auth-ID: MA_4272LINL" \
  -H "X-Auth-Token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "+917965850027", "to": "+919123151351", "answer_url": "https://your-app.railway.app/answer"}'
```

## Call Flow (Standard Vobiz Pattern)

1. User calls DID `+917965850027`
2. Vobiz routes to Application → `POST /answer`
3. Backend returns `<Dial><User>endpoint@registrar.vobiz.ai</User></Dial>`
4. Platform sends SIP INVITE to registered Android app
5. App rings → User answers → Two-way audio
6. Call ends → Vobiz calls `POST /hangup`

This is the **standard Vobiz pattern** used by rtc-demo, Vapi, Retell, and all production apps.