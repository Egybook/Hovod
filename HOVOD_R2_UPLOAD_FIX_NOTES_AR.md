# Hovod R2 Upload Stability Patch

## What changed

1. The dashboard now uses S3 multipart uploads for files at or above 5 MiB, rather than waiting until 16 MiB. This lets a 9.8 MB video upload as two independently retryable parts instead of one fragile browser PUT.
2. Multipart parts are 5 MiB (the S3-compatible minimum for non-final parts) and are uploaded sequentially to reduce mobile-browser/network pressure. Existing per-part retry and resume logic is retained.
3. Small single-PUT uploads now retry up to three times with a fresh presigned URL per attempt. The signed and sent Content-Type is consistently `video/mp4`.
4. Hovod no longer attempts `PutBucketCors` on every boot. The bucket CORS policy is managed manually in Cloudflare R2, so the startup `Access Denied` warning is avoided without broadening token permissions or making the bucket public.

## Preserved

- R2 remains private.
- Existing R2 credentials and environment variable names are unchanged.
- Existing private playback proxy and token validation are unchanged.
- Existing CORS policy is not overwritten by Hovod.

## Deployment

Build and deploy this Hovod source/image through the existing Altare deployment workflow. Do not paste secrets into source files or commit them. Keep the existing Cloudflare R2 CORS policy with the exact EgyBook and Hovod origins, `PUT` allowed, and `ETag` exposed.

## Validation still required

A source patch cannot prove the live Altare/R2 upload works. After deployment, test a small MP4 (under 5 MiB) and a 9–10 MiB MP4. Confirm the latter shows two parts and reaches `Uploaded`, then start processing and verify the output. Do not treat the previous `Hovod is ready` startup banner as proof of upload success.
