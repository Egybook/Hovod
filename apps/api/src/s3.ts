import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

const s3Config = {
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY
  }
};

// Internal client for server-side operations (uses Docker-internal endpoint)
export const s3Client = new S3Client({ ...s3Config, endpoint: env.S3_ENDPOINT });

// Public client for generating presigned URLs the browser can reach
export const s3PublicClient = new S3Client({
  ...s3Config,
  endpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT
});
