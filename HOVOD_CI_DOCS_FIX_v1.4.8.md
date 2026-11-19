# Hovod v1.4.8 — CI endpoint documentation fix

## Problem
The CI endpoint-documentation check found the implemented route
`POST /v1/assets/:id/multipart/status` missing from both `docs/api-reference.md`
and the README endpoint summary. This caused the `Unit tests and documentation
checks` step to exit with code 1 even though the Docker image build and smoke test
had completed successfully.

## Changes
- Documented the multipart status/reconciliation endpoint in the API reference.
- Described its `uploadId` request, `{ completed, parts }` response, and `409`
  behavior when the multipart session is unavailable.
- Added `status` to the README multipart endpoint summary.

## Validation
- `node scripts/check-endpoint-docs.mjs` — PASS (58 route paths; no undocumented
  or stale routes).
- Full GitHub Actions, Docker build, and runtime smoke test must be rerun in CI
  before this release is considered fully verified.
