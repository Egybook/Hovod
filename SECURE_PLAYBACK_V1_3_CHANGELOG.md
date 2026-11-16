# Secure Playback V1.3 — Automatic Renewal Support

## Added
- `POST /v1/secure-playback/:playbackId/refresh`
- Hovod-to-EgyBook authorization callback using a separate shared secret.
- Replacement ticket validation: signature, audience, issuer, playback ID,
  user subject, fresh JTI, and later expiration.
- No-store response headers and fail-closed behavior.

## Configuration
- `EGYBOOK_PLAYBACK_REFRESH_URL`
- `EGYBOOK_PLAYBACK_REFRESH_SECRET`

Both are required when `PLAYBACK_SECURITY_MODE=private`. Production callback URLs
must use HTTPS.

## Not yet complete
- EgyBook must implement the callback described in `docs/egybook-secure-playback.md`.
- EgyBook's HLS player must refresh before ticket expiry and replace the manifest
  while preserving playback time and play/pause state.
- Full build, integration, R2-private-bucket, and Android/iOS Safari tests must
  pass before production use.
