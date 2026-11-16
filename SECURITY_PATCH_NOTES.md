# EgyBook Secure Playback patch - v1

Base: Egybook/Hovod `main` source snapshot supplied on 2026-11-16.

This is a separate EgyBook-specific working copy. The original archive is not modified.

## Included changes

- Added optional `PLAYBACK_SECURITY_MODE=private` mode.
- Added HMAC ticket validation bound to a single playback ID, with a maximum 15-minute lifetime.
- Added `/v1/secure-playback/:playbackId` metadata endpoint and an HLS file proxy.
- Rewrites nested HLS playlist URIs and URI attributes so playlists, segments, captions, and thumbnails stay behind the signed proxy.
- Rejects path traversal and external HLS references.
- Supports HTTP byte-range requests for proxied media.
- Disables legacy public playback metadata, public AI metadata, and public playback download endpoints while private mode is enabled.
- Private mode disables public-read ACLs in the worker and uses `private, no-store` object cache headers.
- Removed explicit public-read ACLs from API-side thumbnail and AI metadata writes.
- Added `docs/egybook-secure-playback.md` with the ticket contract and trusted-server minting example.

## Required integration before production

The EgyBook backend must perform its normal post-audience authorization and mint the HMAC ticket. The signing secret must exist only on the EgyBook server and Hovod API; never in browser JavaScript or a public GitHub Pages build.

Private R2 bucket access must be disabled publicly. Revoke any existing public bucket/domain policy; this code cannot revoke Cloudflare account-level settings automatically.

## Validation status

- Source ZIP integrity verified before editing.
- Static source review performed after editing.
- Automated TypeScript build and runtime tests were not completed in this environment because dependency installation did not finish before timeout.
- This patch is therefore a development candidate, not production-certified. Run the repository build and the security test plan in `docs/egybook-secure-playback.md` before deployment.

- V1.1 hardening: the authenticated `/v1/assets/:id/playback` endpoint now also returns 404 in private mode, preventing it from disclosing direct S3 playback URLs to dashboard/API clients. Private playback must use the ticketed secure-playback route.


## V1.2 hardening

- Required `iss=egybook`, `sub` (EgyBook user identifier), and random `jti` claims in playback tickets.
- Reduced maximum ticket lifetime to 10 minutes and tightened issued-at clock skew.
- Added no-store and no-referrer headers to secure playback metadata responses.
- Redacted request URLs in Fastify application logs because tickets are carried in query strings for HLS compatibility.
- Updated the integration contract and ticket-minting example.

Validation status for V1.2: source changes reviewed; full TypeScript build and live R2/browser tests still need to be run in a configured environment. This is not production-certified.
