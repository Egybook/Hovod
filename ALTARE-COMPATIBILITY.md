# Hovod Altare compatibility build

The Altare image uses `Dockerfile.altare` and `docker/rootfs/altare-entrypoint.sh`.
In Altare, select the published image and leave the Start command set to **The image's command**; do not override it with `/init`.

The Altare launcher runs the shared Hovod configuration/secret preparation hook, then supervises the selected API and/or FFmpeg worker processes directly. Embedded MariaDB and Redis are started only when their corresponding external connection URLs are not configured in `allinone` mode. Mount persistent storage at `/data`.

The Docker healthcheck is role-aware:
- `allinone`: API `/health/ready` succeeds and the worker PID is alive and not a zombie.
- `api`: API `/health/ready` succeeds.
- `worker`: the worker PID is alive and not a zombie.

`/health/ready` checks database connectivity. The healthcheck does not claim to verify successful FFmpeg transcoding or external S3/R2 write permissions; those require an end-to-end deployment test.

Required S3 settings and role-specific external DB/Redis settings are validated by the shared boot hook. Never place credentials in source control.
