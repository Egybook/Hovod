# EgyBook Secure Playback V1.1 - Validation Report

## Changes in V1.1

- Disabled `GET /v1/assets/:id/playback` while `PLAYBACK_SECURITY_MODE=private`.
- This prevents the authenticated Hovod asset-playback endpoint from returning direct S3 playback URLs in private mode.
- Updated the secure playback documentation and patch notes to describe this restriction.

## Static checks completed

- Confirmed the secure route is registered in the API.
- Confirmed the secure route validates HMAC tickets and binds them to one playback ID.
- Confirmed the secure route only serves assets in `ready` state.
- Confirmed private mode suppresses public playback metadata, public download, and public AI metadata endpoints.
- Confirmed worker private mode omits `public-read` ACL and writes private/no-store cache headers.
- Confirmed the authenticated asset playback URL endpoint now returns 404 in private mode.
- Confirmed the HLS proxy rejects traversal and external playlist references and rewrites relative playlist/segment URIs.

## Not yet verified

- Full TypeScript build and automated repository tests were not completed. `npm ci --ignore-scripts --no-audit --no-fund` exceeded the available execution time; the runtime Node version is 22.16.0 while the repository declares Node >=22.23.4.
- No live Cloudflare R2 test was performed.
- No end-to-end HLS playback test was performed on Android, Safari/iPhone, or hls.js.
- No live test was performed for expired, tampered, or wrong-playback tickets.
- The EgyBook backend has not yet been integrated to mint tickets after checking the real post audience and account permissions.

## Deployment status

Development candidate only. Do not deploy to production until the missing build, R2, authorization, and playback tests pass. The R2 bucket must be private at the Cloudflare account/bucket-policy level; application code cannot enforce account-level public-access settings.
