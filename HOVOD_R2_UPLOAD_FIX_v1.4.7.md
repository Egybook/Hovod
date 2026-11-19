# Hovod R2 Upload Fix v1.4.7

## Fixed
- Corrected the multipart pagination marker type in `apps/api/src/routes/assets.ts`.
- `ListPartsCommand.PartNumberMarker` and `NextPartNumberMarker` use strings in the installed AWS SDK type definitions. The local marker is now `string | undefined`, resolving the TypeScript errors at the `ListPartsCommand` call and marker assignment.

## Validation status
- Source-level correction applied.
- Full TypeScript/Docker CI validation was not completed in this environment: the package declares Node.js `>=22.23.4`, while the available runtime is Node.js `22.16.0`; dependency installation also timed out.
- Re-run the repository's Typecheck & build and Docker workflows using the required Node.js version before deploying.

## Changed files
- Modified: `apps/api/src/routes/assets.ts`
- Added: `HOVOD_R2_UPLOAD_FIX_v1.4.7.md`
