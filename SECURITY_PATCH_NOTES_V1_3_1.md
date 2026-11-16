# EgyBook Secure Playback patch V1.3.1

## Changes in this patch
- API and worker now default to `PLAYBACK_SECURITY_MODE=private`; the API refuses to start in private mode unless the playback ticket secret and EgyBook refresh callback settings are present.
- Worker defaults `S3_PUBLIC_ACL=false`, preventing accidental `public-read` object ACLs.
- Development MinIO initialization no longer grants anonymous download access to the `playback/` prefix. The separate `settings/` policy remains unchanged.
- Malformed percent-encoded playback paths now fail with a not-found response instead of an unhandled URI decoding exception.
- Existing Fastify request URL redaction is retained because HLS-compatible playback tickets are carried in query strings.

## Important deployment requirements
- Keep the R2 bucket private: do not enable public bucket access, public custom domains, or public-read policies for playback objects.
- Set private mode explicitly for both API and worker containers.
- Configure the EgyBook refresh callback and shared signing configuration before startup.
- These Hovod changes do not implement the EgyBook callback or update the EgyBook player. Immediate revocation and seamless ticket renewal remain incomplete until EgyBook is integrated.

## Validation limits
- This patch has not been built or tested against a live R2 bucket, live EgyBook callback, or real HLS client.
- A full workspace build requires the repository's Node.js >=22.23.4 and installed dependencies; the available environment has Node.js 22.16.
- Do not deploy as production-ready until those integration tests pass.
