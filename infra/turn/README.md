# Flight Manager TURN Deployment

This folder is the production TURN deployment package for remote video.

## What It Is For

Use this on a small Ubuntu VPS.

It installs and configures `Coturn` so the app can relay remote video when direct peer-to-peer WebRTC is blocked.

## What You Need

- One Ubuntu VPS with a public IPv4
- One DNS record pointing a hostname such as `turn.flightmanager.app` to that VPS
- One email for Let's Encrypt
- One long random shared secret

## Ports To Open

- `80/tcp` for the first Let's Encrypt certificate request
- `3478/udp`
- `3478/tcp`
- `5349/tcp`
- `49160-49200/udp`

## Fastest Professional Path

1. Create the VPS.
2. Point `turn.flightmanager.app` to the VPS public IP.
3. Copy `setup-turn-ubuntu.sh` to the VPS.
4. Run it with the required environment variables.
5. Put the same shared secret into the relay server environment variables.
6. Restart the relay service.
7. Restart the Windows Sim Bridge host.

## Example

```bash
export TURN_DOMAIN=turn.flightmanager.app
export TURN_EMAIL=you@example.com
export TURN_SHARED_SECRET=replace-with-a-long-random-secret
export TURN_PUBLIC_IP=203.0.113.10

sudo -E bash setup-turn-ubuntu.sh
```

## After Setup

The relay server must have:

- `TURN_SHARED_SECRET`
- `TURN_PUBLIC_HOST`
- `TURN_PORT=3478`
- `TURN_TLS_PORT=5349`
- `TURN_CREDENTIAL_TTL_SECONDS=600`
- `TURN_ENABLE_UDP=true`
- `TURN_ENABLE_TCP=true`
- `TURN_ENABLE_TLS=true`

## Verify

After everything restarts:

- relay `/health` should show `turnConfigured: true`
- app diagnostics should show `Remote path: TURN-enabled`
