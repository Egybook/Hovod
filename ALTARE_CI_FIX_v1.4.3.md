# Altare CI fix v1.4.3

## Scope
Document the three private playback routes implemented by `apps/api/src/routes/secure-playback.ts` so the repository endpoint-documentation check recognizes them.

## Changed files
- `docs/api-reference.md` — added route purpose, ticket requirements, request/response shape, relevant status codes, caching behavior, and security constraints for:
  - `GET /v1/secure-playback/:playbackId`
  - `GET /v1/secure-playback/:playbackId/*`
  - `POST /v1/secure-playback/:playbackId/refresh`

## Validation performed
- `node scripts/check-endpoint-docs.mjs` — PASS; 57 route paths found, all documented, no stale documented paths.

## Not run in this environment
- TypeScript typecheck, application build, full unit test suite, Docker build, and Altare runtime test.

No application route implementation, authentication behavior, secrets, database schema, or storage configuration was changed.
