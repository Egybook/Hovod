# Secure Playback V1.2 validation checklist

## Source-level changes
- Ticket requires `aud`, `iss`, `pid`, `sub`, `jti`, `iat`, and `exp`.
- `iss` must be `egybook`; `pid` must match the requested playback ID.
- `sub` must be a non-empty user identifier no longer than 128 characters.
- `jti` must be a 16–128 character URL-safe unique token identifier.
- Ticket lifetime must be positive and no longer than 600 seconds; issued-at skew is limited to 15 seconds.
- Secure metadata responses set `private, no-store`, `Pragma: no-cache`, and `Referrer-Policy: no-referrer`.
- Fastify request URLs are redacted in application logs. Reverse proxy/CDN logging must redact the `ticket` query parameter too.

## Required runtime tests before production
1. Run `npm ci` with Node.js version meeting the repository engine requirement (>=22.23.4).
2. Run `npm run build` and `npm run typecheck`.
3. Verify anonymous direct GET of source and playback objects from R2 returns 403/404.
4. Verify valid ticket works only for its `pid`; wrong playback ID, invalid signature, malformed claims, expired ticket, >600s lifetime, and future `iat` are rejected.
5. Verify all nested HLS playlists and URI attributes are rewritten to the secure proxy.
6. Verify `.ts`, `.m4s`, `.mp4`, subtitles, thumbnails, and byte-range requests.
7. Verify request URLs/tickets are absent from application, reverse-proxy, and CDN logs.
8. Verify Safari native HLS and hls.js on Android/desktop.
9. Change a post's audience or block relationship during an active ticket and document the remaining revocation window (up to ticket expiry).

## Important
V1.2 does not implement online per-segment authorization or instant ticket revocation. The EgyBook backend must perform the complete authorization check before minting each ticket. Do not deploy until the R2 bucket and every public custom domain/r2.dev endpoint are confirmed private.
