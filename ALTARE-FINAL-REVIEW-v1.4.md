# Altare final static review — v1.4

## Changes in this release
- Corrected role-aware health checks: `allinone` now requires both API readiness and a live worker.
- API readiness has a bounded 4-second request timeout.
- Worker health checks reject malformed/missing PIDs, dead processes, and zombie processes.
- Updated Altare compatibility documentation to describe actual launcher and healthcheck behavior and the limits of static validation.

## Preserved
- Original `Dockerfile` and original s6-based image path.
- Existing API, worker, dashboard, database migrations, MariaDB initialization, Redis configuration, and S3-compatible storage implementation.
- Existing persistent `/data` layout and Docker Hub repository naming.

## Validation performed
- Shell syntax validation (`bash -n`) for the Altare entrypoint and healthcheck.
- Static consistency review of `Dockerfile.altare`, boot hook, MariaDB initializer, API readiness route, and release workflow.

## Not validated in this environment
- Docker image build (Docker CLI/daemon unavailable).
- Runtime behavior on Altare.
- Live MariaDB/Redis startup, FFmpeg transcode, and R2 upload/playback.

Do not treat a successful GitHub Actions image build as proof of a successful Altare deployment. Complete the deployment smoke test before production use.
