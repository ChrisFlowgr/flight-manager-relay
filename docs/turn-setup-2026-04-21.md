# TURN Setup For Remote Video

## Goal

Keep both remote video modes:

- `Free mode`: direct/STUN first
- `Paid fallback`: TURN only when direct remote is blocked

That is the correct production design for this app.

## What Is Already Done In Code

The repo already supports:

- direct remote WebRTC
- TURN credential issuance from the relay server
- TURN-aware diagnostics in the mobile app and Windows host

The missing part is infrastructure:

1. redeploy the hosted relay so `/turn-credentials` exists
2. stand up one real TURN server

## Final Architecture

Use this structure:

- Keep `relay-server` on Render for pairing, signaling, telemetry, and control messages
- Add one `Coturn` server on a public VM for remote video relay

Do not try to run TURN inside the Render web service. TURN needs extra ports and UDP relay traffic.

## Rollout Order

### Phase 1: Finish The Relay

The hosted relay must be redeployed first.

Your logs currently show:

- `404` on `/turn-credentials`
- HTML returned instead of JSON

That means the Render service is still running older code.

### Phase 2: Test TURN On Google Cloud

Use Google Cloud only as a short test environment.

Reason:

- good for proving TURN fixes the black screen
- not the cheapest long-term place for relay bandwidth

### Phase 3: Move TURN To Cheapest Permanent Host

After Google test succeeds:

- move the TURN VM to a cheaper long-term provider such as Hetzner
- keep the same relay logic and same app code

## Exact Relay Settings

Set these on the deployed `relay-server` service:

```env
TURN_SHARED_SECRET=replace-with-a-long-random-secret
TURN_PUBLIC_HOST=turn.flightmanager.app
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_CREDENTIAL_TTL_SECONDS=600
TURN_ENABLE_UDP=true
TURN_ENABLE_TCP=true
TURN_ENABLE_TLS=true
```

For cloud mode, the bridge uses:

```env
RELAY_URL=wss://flight-manager-relay.onrender.com
RELAY_HTTP_URL=https://flight-manager-relay.onrender.com
USE_RELAY=true
```

## Exact Google Cloud Test Plan

Use this only for testing TURN.

You now have two test options:

### Option A: Fastest Test Without Any Domain

Use the Google VM public IP directly.

This is the fastest way to prove whether TURN fixes the black screen.

Use this when:

- you do not have DNS access yet
- you do not want to buy a domain
- you want a simple proof test first

Limits of IP-only test mode:

- no TLS on `5349`
- TURN runs on `3478` using UDP/TCP only
- good for proof testing, not the best final production setup

### Option B: Domain-Based Test

Use a hostname such as `turn-test.plaz.gr`.

This is closer to final production because it allows TURN over TLS too.

## Exact Google Cloud Test Plan (IP-only)

Use this first if you want the simplest path:

1. Create or log into a Google Cloud account.
2. Start the Google Cloud free trial if you have never used it before.
3. Create one project, for example `flightmanager-turn-test`.
4. Create one Ubuntu VM in a North America region.
5. Give it one public IPv4 address.
6. SSH into that VM.
7. Run the TURN setup script in IP-only mode.
8. Set `TURN_PUBLIC_HOST` on Render to the VM public IP.
9. Set `TURN_ENABLE_TLS=false` on Render.
10. Redeploy the relay service.
11. Restart the Windows host.
12. Test remote watch again from the same failing phone/network path.

## Exact Google Cloud Test Plan (With Domain)

Use this only if you have working DNS access and want TLS too:

1. Create or log into a Google Cloud account.
2. Start the Google Cloud free trial if you have never used it before.
3. Create one project, for example `flightmanager-turn-test`.
4. Create one Ubuntu VM in a North America region.
5. Give it one public IPv4 address.
6. Point a DNS name such as `turn-test.plaz.gr` to that IP.
7. Run the setup script in domain mode.
8. Put the same shared secret into Render environment variables.
9. Redeploy the relay service.
10. Restart the Windows host.
11. Test remote watch again from the same failing phone/network path.

## Google Credentials: What You Actually Need

For the initial Google test, you do **not** need to give me your Google password.

You only need:

1. A Google account with Google Cloud access.
2. A billing account enabled on Google Cloud.
3. A project where you can create one VM.

That is enough if you are willing to click through the Google Cloud web console yourself.

## If You Want Me To Guide You Live

If we use the Google Cloud web console manually:

- no service account key is needed
- no JSON credential file is needed
- no Google password sharing is needed

If we want to automate from your machine using `gcloud`, then the safest path is:

1. install Google Cloud CLI on your PC
2. run `gcloud auth login`
3. sign in in your own browser
4. run `gcloud config set project flightmanager-turn-test`

That still does **not** require sharing your password with me.

## When A Service Account Key Would Be Needed

Only use a service account key if you explicitly want unattended automation later.

For the first TURN test, it is unnecessary.

Avoid it unless we truly need automation.

## What You Need To Prepare Before Google Test

### IP-only Google test mode

Prepare these exact values:

- `TURN_SHARED_SECRET`
- `TURN_PUBLIC_IP`
- `TURN_PUBLIC_HOST`
- `TURN_ENABLE_TLS=false`

Example:

```bash
export TURN_SHARED_SECRET=replace-with-a-long-random-secret
export TURN_PUBLIC_IP=203.0.113.10
export TURN_PUBLIC_HOST=203.0.113.10
export TURN_ENABLE_TLS=false
sudo -E bash setup-turn-ubuntu.sh
```

Then set these on Render:

```env
TURN_SHARED_SECRET=replace-with-a-long-random-secret
TURN_PUBLIC_HOST=203.0.113.10
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_CREDENTIAL_TTL_SECONDS=600
TURN_ENABLE_UDP=true
TURN_ENABLE_TCP=true
TURN_ENABLE_TLS=false
```

### Domain-based mode

Prepare these exact values:

- `TURN_DOMAIN`
- `TURN_EMAIL`
- `TURN_SHARED_SECRET`
- `TURN_PUBLIC_IP`

Example:

```bash
export TURN_DOMAIN=turn-test.flightmanager.app
export TURN_EMAIL=you@example.com
export TURN_SHARED_SECRET=replace-with-a-long-random-secret
export TURN_PUBLIC_IP=203.0.113.10
```

Then run:

```bash
sudo -E bash setup-turn-ubuntu.sh
```

Use the script from:

- [setup-turn-ubuntu.sh](/C:/Users/Chris%20Flow/Flightmanager/infra/turn/setup-turn-ubuntu.sh)

It will:

- install `coturn`
- install `certbot`
- open the required firewall ports
- request the TLS certificate
- write `/etc/turnserver.conf`
- restart Coturn

## Ports To Open On The TURN VM

- `22/tcp` for SSH
- `3478/udp`
- `3478/tcp`
- `49160-49200/udp`

Add these too only when TLS is enabled:

- `80/tcp` for the first Let's Encrypt certificate request
- `5349/tcp`

The extra UDP range is required for the relayed media packets.

## Relay Redeploy Checklist

After the TURN VM is up:

1. Open the Render dashboard.
2. Open the hosted `relay-server` service.
3. Set the TURN environment variables.
4. Trigger a redeploy.
5. Wait for the new version to go live.
6. Open:

```text
https://flight-manager-relay.onrender.com/health
```

Expected:

```json
{
  "status": "ok",
  "turnConfigured": true
}
```

If `turnConfigured` is `false`, stop there. TURN is not ready yet.

## How To Verify The End Result

1. Restart the Windows Sim Bridge host.
2. Connect the phone remotely with the relay code.
3. Open `Watch Flight`.
4. Open `Diagnostics`.

What you want to see:

- `Remote path: TURN-enabled`
- no `Direct only (TURN not configured)`
- no `network_blocks_direct_connection`
- `packetsSent` greater than `0`

## Permanent Low-Cost Production Recommendation

After Google proves the fix:

- move TURN to a small Hetzner cloud server
- keep Render for the relay

That gives the lowest likely long-term cost while keeping the architecture clean.

## What Still Fails Without TURN

Without TURN configured:

- remote controls can still work
- remote telemetry can still work
- remote video can still fail on many mobile/data/router combinations

That is normal WebRTC behavior once diagnostics say the remote path is direct-only.
