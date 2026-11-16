import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { assets, aiJobs, ASSET_STATUS, S3_PATHS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { s3Client } from '../s3.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';

type PlaybackTicket = { aud: 'hovod-playback'; iss: 'egybook'; pid: string; sub: string; jti: string; exp: number; iat: number };

type RefreshRequest = { ticket?: unknown };

type RefreshResponse = { ticket?: unknown };

/**
 * Verify a short-lived HMAC ticket minted by the trusted EgyBook backend.
 * Hovod deliberately does not mint these tickets: only the application that
 * checked post visibility/friend/follower rules should be able to authorize a viewer.
 */
function verifyTicket(token: string, playbackId: string): PlaybackTicket {
  const secret = env.PLAYBACK_TOKEN_SECRET;
  if (!secret || token.length > 2048) throw new AppError(403, 'Invalid playback ticket');
  const parts = token.split('.');
  if (parts.length !== 2) throw new AppError(403, 'Invalid playback ticket');
  const [payloadPart, signaturePart] = parts;
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signaturePart, 'base64url'); }
  catch { throw new AppError(403, 'Invalid playback ticket'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AppError(403, 'Invalid playback ticket');
  }
  let payload: PlaybackTicket;
  try { payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as PlaybackTicket; }
  catch { throw new AppError(403, 'Invalid playback ticket'); }
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== 'hovod-playback' || payload.iss !== 'egybook' || payload.pid !== playbackId ||
      typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 128 ||
      typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(payload.jti) ||
      !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
      payload.iat > now + 15 || payload.exp <= now || payload.exp - payload.iat > 600 ||
      payload.iat < now - 600) {
    throw new AppError(403, 'Playback ticket expired or not valid for this video');
  }
  return payload;
}

function ticketFromRequest(request: { query: unknown }, playbackId: string): string {
  const query = request.query as { ticket?: unknown };
  if (typeof query.ticket !== 'string') throw new AppError(403, 'Playback ticket required');
  verifyTicket(query.ticket, playbackId);
  return query.ticket;
}

function secureFileUrl(playbackId: string, filePath: string, ticket: string): string {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `/v1/secure-playback/${encodeURIComponent(playbackId)}/${encodedPath}?ticket=${encodeURIComponent(ticket)}`;
}

function rewriteManifest(body: string, playbackId: string, currentPath: string, ticket: string): string {
  const base = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  const resolve = (uri: string) => {
    if (!uri || /^(https?:)?\/\//i.test(uri) || uri.startsWith('data:')) {
      throw new AppError(502, 'External HLS references are not allowed in private playback');
    }
    const joined = `${base}${uri}`.split('/');
    const normalized: string[] = [];
    for (const part of joined) {
      if (!part || part === '.') continue;
      if (part === '..') throw new AppError(502, 'Invalid HLS path');
      normalized.push(part);
    }
    return secureFileUrl(playbackId, normalized.join('/'), ticket);
  };

  return body.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${resolve(uri)}"`);
    }
    return resolve(line.trim());
  }).join('\n');
}

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

function validatePlaybackPath(raw: string): string {
  let decoded: string[];
  try { decoded = raw.split('/').map((part) => decodeURIComponent(part)); }
  catch { throw new AppError(404, 'Playback file not found'); }
  if (!decoded.length || decoded.length > 12 || decoded.some((part) =>
    !part || part === '.' || part === '..' || part.includes('\\') || !/^[A-Za-z0-9_.-]{1,180}$/.test(part)
  )) throw new AppError(404, 'Playback file not found');
  const normalized = decoded.join('/');
  if (!/\.(m3u8|ts|m4s|mp4|vtt|json|jpg|jpeg|png|webp)$/i.test(normalized)) {
    throw new AppError(404, 'Playback file not found');
  }
  return normalized;
}

export async function securePlaybackRoutes(app: FastifyInstance) {
  if (env.PLAYBACK_SECURITY_MODE !== 'private') return;

  // Refresh is delegated to EgyBook, which must re-check the current post
  // audience/friend/follower rules before minting a replacement ticket. Hovod
  // never extends a ticket on its own: that would keep revoked access alive.
  app.post<{ Params: { playbackId: string }; Body: RefreshRequest }>(
    '/v1/secure-playback/:playbackId/refresh', async (request, reply) => {
      const { playbackId } = request.params;
      const currentToken = request.body?.ticket;
      if (typeof currentToken !== 'string' || currentToken.length > 2048) {
        throw new AppError(400, 'A valid current playback ticket is required');
      }
      const current = verifyTicket(currentToken, playbackId);
      if (!env.EGYBOOK_PLAYBACK_REFRESH_URL || !env.EGYBOOK_PLAYBACK_REFRESH_SECRET) {
        throw new AppError(503, 'Playback ticket refresh is not configured');
      }

      let response: Response;
      try {
        response = await fetch(env.EGYBOOK_PLAYBACK_REFRESH_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hovod-refresh-secret': env.EGYBOOK_PLAYBACK_REFRESH_SECRET,
          },
          body: JSON.stringify({
            playbackId,
            userId: current.sub,
            currentTicket: currentToken,
            currentTicketId: current.jti,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        throw new AppError(503, 'Playback authorization service is temporarily unavailable');
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          throw new AppError(403, 'Playback is no longer authorized');
        }
        throw new AppError(503, 'Playback authorization service is temporarily unavailable');
      }

      let data: RefreshResponse;
      try { data = await response.json() as RefreshResponse; }
      catch { throw new AppError(502, 'Invalid playback refresh response'); }
      if (typeof data.ticket !== 'string' || data.ticket.length > 2048) {
        throw new AppError(502, 'Invalid playback refresh response');
      }
      const renewed = verifyTicket(data.ticket, playbackId);
      if (renewed.sub !== current.sub || renewed.jti === current.jti || renewed.exp <= current.exp) {
        throw new AppError(502, 'Playback authorization service returned an invalid replacement ticket');
      }

      reply.header('Cache-Control', 'no-store, private, max-age=0');
      reply.header('Pragma', 'no-cache');
      reply.header('Referrer-Policy', 'no-referrer');
      return { data: { ticket: data.ticket, expiresAt: renewed.exp, refreshAfterSec: Math.max(15, renewed.exp - Math.floor(Date.now() / 1000) - 60) } };
    }
  );

  app.get<{ Params: { playbackId: string }; Querystring: { ticket?: string } }>(
    '/v1/secure-playback/:playbackId', async (request, reply) => {
      const { playbackId } = request.params;
      const ticket = ticketFromRequest(request, playbackId);
      reply.header('Cache-Control', 'private, no-store, max-age=0');
      reply.header('Pragma', 'no-cache');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Vary', 'Authorization, Cookie');
      const [asset] = await db.select().from(assets)
        .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY))).limit(1);
      if (!asset) throw new NotFoundError('Playback not found');

      const [aiJob] = await db.select().from(aiJobs).where(eq(aiJobs.assetId, asset.id))
        .orderBy(desc(aiJobs.createdAt)).limit(1);
      return { data: {
        playbackId,
        title: asset.title,
        description: asset.description ?? null,
        durationSec: asset.durationSec,
        manifestUrl: secureFileUrl(playbackId, S3_PATHS.MASTER_PLAYLIST, ticket),
        thumbnailUrl: secureFileUrl(playbackId, asset.customThumbnailKey
          ? asset.customThumbnailKey.split('/').slice(-1)[0]!
          : S3_PATHS.THUMBNAIL, ticket),
        ai: aiJob && aiJob.status !== 'skipped' ? {
          status: aiJob.status,
          subtitlesUrl: aiJob.subtitlesPath ? secureFileUrl(playbackId, S3_PATHS.AI_SUBTITLES, ticket) : null,
          chaptersUrl: aiJob.chaptersPath ? secureFileUrl(playbackId, S3_PATHS.AI_CHAPTERS, ticket) : null,
          transcriptUrl: aiJob.transcriptPath ? secureFileUrl(playbackId, S3_PATHS.AI_TRANSCRIPT, ticket) : null,
          language: aiJob.language,
        } : null,
      } };
    }
  );

  app.get<{ Params: { playbackId: string; '*': string }; Querystring: { ticket?: string } }>(
    '/v1/secure-playback/:playbackId/*', async (request, reply) => {
      const { playbackId } = request.params;
      const ticket = ticketFromRequest(request, playbackId);
      const filePath = validatePlaybackPath(request.params['*'] ?? '');
      const [asset] = await db.select({ id: assets.id }).from(assets)
        .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY))).limit(1);
      if (!asset) throw new NotFoundError('Playback not found');

      const range = request.headers.range;
      const result = await s3Client.send(new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/${filePath}`,
        ...(range && /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {}),
      })).catch(() => null);
      if (!result?.Body) throw new NotFoundError('Playback file not found');

      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      reply.header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
      reply.header('Cache-Control', 'private, no-store, max-age=0');
      reply.header('Pragma', 'no-cache');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Vary', 'Authorization, Cookie');
      reply.header('X-Content-Type-Options', 'nosniff');
      if (result.ContentLength !== undefined) reply.header('Content-Length', String(result.ContentLength));
      if (result.ContentRange) reply.header('Content-Range', result.ContentRange);
      if (result.AcceptRanges) reply.header('Accept-Ranges', result.AcceptRanges);
      if (result.ETag) reply.header('ETag', result.ETag);
      if (result.ContentRange) reply.code(206);

      if (ext === '.m3u8') {
        const chunks: Buffer[] = [];
        for await (const chunk of result.Body as AsyncIterable<Buffer | Uint8Array | string>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const rewritten = rewriteManifest(Buffer.concat(chunks).toString('utf8'), playbackId, filePath, ticket);
        reply.header('Content-Length', String(Buffer.byteLength(rewritten)));
        return reply.send(rewritten);
      }
      return reply.send(result.Body as NodeJS.ReadableStream);
    }
  );
}
