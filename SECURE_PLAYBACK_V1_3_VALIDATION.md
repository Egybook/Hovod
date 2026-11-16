# Secure Playback V1.3 validation status

Date: 2026-11-16
Base: Hovod GitHub ZIP supplied by the project owner (V1.2.1)

## Implemented in this patch
- Added `POST /v1/secure-playback/:playbackId/refresh`.
- Refresh requires a still-valid current ticket.
- Renewal is delegated to the configured EgyBook authorization endpoint.
- Hovod verifies the replacement ticket signature and checks that playback ID
  and user subject are unchanged, JTI is new, and expiry is extended.
- Refresh fails closed on callback timeout, service error, or authorization denial.
- Private mode requires the refresh URL and a separate callback shared secret.
- Production callback URLs must use HTTPS.

## Checks performed
- `node --experimental-strip-types --check` passed for the modified API TypeScript
  route and environment schema files using the available Node.js 22.16 runtime.
- ZIP integrity test passed after packaging.

## Checks not completed
- Full TypeScript build was attempted with global `tsc`, but dependencies and
  workspace package type declarations are not installed in this environment.
  The output therefore contains missing-module/type-definition errors and is
  not a successful build.
- No live EgyBook authorization callback is available in this Hovod-only ZIP.
- No Cloudflare R2 bucket or real HLS player was available for end-to-end tests.
- No Android or iOS Safari playback test was run.

## Required before production
1. Implement the documented refresh callback in the EgyBook backend.
2. Use the same playback-ticket HMAC secret on both trusted backends, and a
   different random secret for `EGYBOOK_PLAYBACK_REFRESH_SECRET`.
3. Update the EgyBook player to refresh proactively before ticket expiry and
   reload the manifest while restoring current time and play/pause state.
4. Run full workspace build and integration tests with the repository's required
   Node.js version (>=22.23.4) and installed dependencies.
5. Verify R2 is private at the bucket/account policy level; disabling ACL alone
   is not proof that the bucket is private.

This release adds Hovod-side renewal support; it does not, by itself, make
continuous playback work until the EgyBook callback and player are integrated.
