# Hovod Altare compatibility build

This adds a separate Altare-specific Docker entrypoint. The original `Dockerfile` remains unchanged. Build with `docker build -f Dockerfile.altare -t YOUR_DOCKERHUB_USER/hovod-altare:1.3.1 .` and publish the image as a public Docker Hub repository. In Altare select that image and leave Start command set to **The image’s command** (do not set `/init`).

The alternate launcher runs the existing Hovod boot hook and MariaDB initializer, then supervises the embedded MariaDB, Redis, API and worker without requiring s6-overlay to be PID 1. `/data` and the existing Hovod database layout are retained.

## Not production-verified

Only `bash -n` syntax validation is possible in this environment; Docker build and runtime tests have not been run. Do not switch production traffic until the image builds and logs confirm every service starts.

The supplied API env schema requires `S3_PUBLIC_BASE_URL` to be a valid URL; it is missing from the Altare variables shown. Also `EGYBOOK_PLAYBACK_REFRESH_SECRET` has a minimum length of 32 characters in this source, so the previously entered shorter value will fail validation. Set a new 32+ character secret in both Hovod and Supabase `EGYBOOK_PLAYBACK_AUTH_SECRET`. Keep the R2 bucket private.
