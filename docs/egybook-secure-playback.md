# EgyBook Secure Playback (Hovod self-hosted extension)

This extension adds a private HLS delivery path. It is opt-in so an ordinary
Hovod deployment can keep its existing public-playback behavior.

## Security boundary

Hovod does **not** decide whether a viewer may see an EgyBook post. The trusted
EgyBook backend must first evaluate the post's audience, friendship/follow
relationship, block state, and account status. Only after that check may it
mint a short-lived HMAC playback ticket for the exact Hovod `playbackId`.

The browser must never receive `PLAYBACK_TOKEN_SECRET`. Store the same random
secret only in the Hovod API environment and the trusted EgyBook server-side
environment. Do not put it in HTML, JavaScript, GitHub Pages, or a public Worker
variable.

## Required configuration

```dotenv
PLAYBACK_SECURITY_MODE=private
PLAYBACK_TOKEN_SECRET=<at-least-32-random-characters>
S3_PUBLIC_ACL=false
```

Set `PLAYBACK_SECURITY_MODE=private` in both API and worker environments. Use a
private R2 bucket: do not enable `r2.dev`, public bucket access, public custom
domain access, or a public bucket policy. `S3_PUBLIC_BASE_URL` remains required
by the upstream application configuration, but private playback does not use
it to deliver HLS objects.

Private mode disables the legacy public playback metadata, public AI metadata,
and public download endpoints. The secure proxy reads playback objects using
server-side S3 credentials and responds with `Cache-Control: private, no-store`.

## Ticket format

Ticket payload (JSON, UTF-8, base64url):

```json
{"aud":"hovod-playback","iss":"egybook","pid":"HOVOD_PLAYBACK_ID","sub":"EGYBOOK_USER_ID","jti":"RANDOM_UNIQUE_TOKEN_ID","iat":1790000000,"exp":1790000600}
```

Token format:

```text
base64url(payload-json).base64url(HMAC-SHA256(payload-part, PLAYBACK_TOKEN_SECRET))
```

Tickets are bound to one playback ID and one EgyBook user (`sub`), carry a unique random token ID (`jti`), identify EgyBook as issuer (`iss`), and expire in no more than 10 minutes. They must be minted only after EgyBook's own authorization check. The user ID and token ID are validated by Hovod for ticket structure and traceability; Hovod does not independently query EgyBook to re-authorize each segment request. The browser then
requests:

```text
GET https://HOVOD_HOST/v1/secure-playback/{playbackId}?ticket={ticket}
```

The response contains a manifest URL. The API rewrites every relative HLS
playlist/segment URI to the secure proxy and carries the same expiring ticket
through the HLS tree. The proxy rejects traversal paths and external playlist
references, supports byte-range requests, and never exposes the source object.

## Example ticket minting (trusted server only)

```js
import { createHmac, randomUUID } from 'node:crypto';

export function mintHovodTicket(playbackId, egybookUserId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: 'hovod-playback', iss: 'egybook', pid: playbackId,
    sub: egybookUserId, jti: randomUUID().replace(/-/g, ''),
    iat: now, exp: now + 600,
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
```

## Important limitations / rollout requirements

- The Hovod ticket proves that the trusted EgyBook backend authorized a
  particular playback ID at ticket-issuance time. It does not continuously
  re-check a friendship change during the ticket's short lifetime; use the
  shortest expiry compatible with playback (maximum 10 minutes in this patch).
- Tickets are bearer credentials. Hovod redacts request URLs in its application logs; configure any reverse-proxy/CDN logs to redact `ticket` query parameters too. `Referrer-Policy: no-referrer` and `private, no-store` headers reduce browser-side leakage and caching.
- Use HTTPS only. Restrict Hovod API CORS to the EgyBook origins and set
  `EMBED_FRAME_ANCESTORS` to the required site origins.
- This proxy is a first security layer, not DRM. An authorized viewer can still
  capture the media while it is playing.
- Before production, test private bucket access from an anonymous browser,
  expired/tampered/wrong-video tickets, nested HLS playlists, TS and fMP4
  segments, Safari native HLS, hls.js, Range requests, and cache behavior.
- Existing public Hovod assets are not automatically made private by changing
  this setting. Revoke any old public bucket/domain policy and verify object
  access independently before placing private media in that bucket.

- In private mode, `/v1/assets/:id/playback` is also disabled. Do not use the ordinary Hovod dashboard playback URL flow for private assets; route playback through EgyBook authorization and the signed secure-playback endpoint.


## V1.2 hardening

- Tickets now require `iss=egybook`, a non-empty `sub` user identifier, and a random `jti` token identifier.
- Maximum ticket lifetime is reduced from 15 minutes to 10 minutes, with a tighter future-issued-time allowance.
- Secure metadata responses now use private no-store headers and `Referrer-Policy: no-referrer`.
- Fastify application logs redact request URLs to avoid persisting bearer tickets carried in query strings. Reverse-proxy/CDN logs must also redact `ticket`.
- These claims improve validation and traceability; they do not provide instant revocation. EgyBook must still authorize before minting, and very sensitive deployments should add online authorization/revocation checks before production.
