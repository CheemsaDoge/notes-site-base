/**
 * Reusable Cloudflare Worker factory for `notes-site-base` study sites.
 *
 * Routes:
 * - GET  /api/health      -> D1 liveness probe
 * - POST /api/sync        -> Passphrase-hashed bidirectional LWW sync (progress + notes)
 * - POST /api/sync/clear  -> Delete cloud sync space & notes for the hashed passphrase
 * - *    (non-/api/*)     -> Delegate to Static Assets binding (env.ASSETS)
 */

import {
  MAX_NOTES,
  createEmptyProgress,
  mergeNotes,
  mergeProgress,
  rowToNote,
} from './merge.mjs';

export const DEFAULT_SYNC_HASH_PREFIX = 'notes-sync-v1:';

const MAX_BODY_BYTES = 512 * 1024;
const MIN_SYNC_CODE_LEN = 6;
const MAX_SYNC_CODE_LEN = 128;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function apiHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: apiHeaders(extraHeaders),
  });
}

function errorResponse(status, error, message, extraHeaders = {}) {
  return jsonResponse({ ok: false, error, message }, status, extraHeaders);
}

/**
 * Extract, validate, and SHA-256 hash `X-Sync-Code` with the configured namespace prefix.
 * Supports optional `X-Sync-Code-Encoding: uri` so Unicode/CJK passphrases
 * can be safely transported in HTTP headers without `fetch()` ByteString errors.
 */
async function resolveSpaceId(request, syncHashPrefix) {
  const rawHeader = request.headers.get('X-Sync-Code');
  if (!rawHeader) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'missing_sync_code',
        '请先在请求头提供同步码（X-Sync-Code）。'
      ),
    };
  }

  const encoding = (request.headers.get('X-Sync-Code-Encoding') || '').trim().toLowerCase();
  let decoded = rawHeader;
  if (encoding === 'uri') {
    try {
      decoded = decodeURIComponent(rawHeader);
    } catch {
      return {
        ok: false,
        response: errorResponse(400, 'invalid_sync_code', '同步码编码格式无效。'),
      };
    }
  }

  const normalized = decoded.trim();
  if (
    normalized.length < MIN_SYNC_CODE_LEN ||
    normalized.length > MAX_SYNC_CODE_LEN ||
    CONTROL_CHARS_RE.test(normalized)
  ) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'invalid_sync_code',
        '同步码长度需为 6–128 个有效字符，且不能包含控制字符。'
      ),
    };
  }

  const digest = await crypto.subtle.digest(
    'SHA-256',
    TEXT_ENCODER.encode(`${syncHashPrefix}${normalized}`)
  );
  const bytes = new Uint8Array(digest);
  let spaceId = '';
  for (let i = 0; i < bytes.length; i++) {
    spaceId += bytes[i].toString(16).padStart(2, '0');
  }

  return { ok: true, spaceId };
}

/**
 * Stream and bound request JSON body to MAX_BODY_BYTES before parsing.
 * Avoids unbounded buffering in Worker memory.
 */
async function readBoundedJsonBody(request) {
  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return {
        ok: false,
        response: errorResponse(
          413,
          'payload_too_large',
          '同步请求体积超过 512 KiB 上限。'
        ),
      };
    }
  }

  if (!request.body) {
    return {
      ok: false,
      response: errorResponse(400, 'empty_body', '同步请求体不能为空。'),
    };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          response: errorResponse(
            413,
            'payload_too_large',
            '同步请求体积超过 512 KiB 上限。'
          ),
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return {
      ok: false,
      response: errorResponse(400, 'empty_body', '同步请求体不能为空。'),
    };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(combined));
  } catch {
    return {
      ok: false,
      response: errorResponse(400, 'invalid_json', '同步请求不是合法的 JSON 格式。'),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      response: errorResponse(400, 'invalid_payload', '同步请求体必须为 JSON 对象。'),
    };
  }

  return { ok: true, data: parsed };
}

async function handleHealth(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, 'method_not_allowed', '仅支持 GET/HEAD 请求。', {
      Allow: 'GET, HEAD',
    });
  }

  const serverTime = Date.now();
  const row = await env.DB.prepare('SELECT 1 AS ok').first();
  const d1Healthy = Boolean(row && Number(row.ok) === 1);

  if (!d1Healthy) {
    return jsonResponse({ ok: false, d1: false, serverTime }, 503);
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: apiHeaders() });
  }
  return jsonResponse({ ok: true, d1: true, serverTime }, 200);
}

async function handleSync(request, env, syncHashPrefix) {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', '同步接口仅支持 POST 请求。', {
      Allow: 'POST',
    });
  }

  const startedAt = Date.now();
  const spaceRes = await resolveSpaceId(request, syncHashPrefix);
  if (!spaceRes.ok) return spaceRes.response;
  const { spaceId } = spaceRes;

  const bodyRes = await readBoundedJsonBody(request);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.data;

  if (body.notes !== undefined && !Array.isArray(body.notes)) {
    return errorResponse(400, 'invalid_notes', 'notes 字段必须为数组。');
  }
  const clientNotesRaw = body.notes || [];
  if (clientNotesRaw.length > MAX_NOTES) {
    return errorResponse(
      413,
      'too_many_notes',
      `单次同步笔记数量不能超过 ${MAX_NOTES} 条。`
    );
  }

  if (
    body.progress !== undefined &&
    (typeof body.progress !== 'object' || body.progress === null || Array.isArray(body.progress))
  ) {
    return errorResponse(400, 'invalid_progress', 'progress 字段必须为对象。');
  }

  // 1. Atomic read of space metadata and existing notes (counts as 1 D1 query)
  const [spaceQuery, notesQuery] = await env.DB.batch([
    env.DB.prepare(
      'SELECT space_id, revision, progress_json, created_at, updated_at FROM sync_spaces WHERE space_id = ?'
    ).bind(spaceId),
    env.DB.prepare(
      'SELECT id, page_slug, page_title, heading_id, heading_text, quote_text, quote_html, note, tag, concept_id, created_at, updated_at, deleted_at FROM notebook_notes WHERE space_id = ?'
    ).bind(spaceId),
  ]);

  const existingSpace = spaceQuery.results?.[0] || null;
  let serverProgress = createEmptyProgress();
  if (existingSpace && typeof existingSpace.progress_json === 'string') {
    try {
      serverProgress = JSON.parse(existingSpace.progress_json);
    } catch {
      serverProgress = createEmptyProgress();
    }
  }

  const serverNotes = (notesQuery.results || []).map(rowToNote);
  const serverTime = Date.now();

  // 2. Deterministic bidirectional LWW merge (with future clock-skew ceiling)
  const mergedProgress = mergeProgress(serverProgress, body.progress, serverTime);
  const nextProgressJson = JSON.stringify(mergedProgress);
  const { mergedNotes, toUpsert, toDeleteIds } = mergeNotes(
    serverNotes,
    clientNotesRaw,
    serverTime
  );

  const progressChanged =
    !existingSpace || existingSpace.progress_json !== nextProgressJson;
  const notesChanged = toUpsert.length > 0 || toDeleteIds.length > 0;

  let revision = existingSpace ? Number(existingSpace.revision) || 1 : 1;

  // 3. Persist atomically only when creating space or state actually changed
  if (!existingSpace || progressChanged || notesChanged) {
    revision = existingSpace ? revision + 1 : 1;

    const writeStmts = [
      env.DB.prepare(
        `INSERT INTO sync_spaces (space_id, revision, progress_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(space_id) DO UPDATE SET
           revision = excluded.revision,
           progress_json = excluded.progress_json,
           updated_at = excluded.updated_at`
      ).bind(spaceId, revision, nextProgressJson, serverTime, serverTime),
    ];

    const upsertNoteStmt = env.DB.prepare(
      `INSERT INTO notebook_notes (
         space_id, id, page_slug, page_title, heading_id, heading_text,
         quote_text, quote_html, note, tag, concept_id,
         created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(space_id, id) DO UPDATE SET
         page_slug = excluded.page_slug,
         page_title = excluded.page_title,
         heading_id = excluded.heading_id,
         heading_text = excluded.heading_text,
         quote_text = excluded.quote_text,
         quote_html = excluded.quote_html,
         note = excluded.note,
         tag = excluded.tag,
         concept_id = excluded.concept_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at`
    );

    for (const n of toUpsert) {
      writeStmts.push(
        upsertNoteStmt.bind(
          spaceId,
          n.id,
          n.pageSlug,
          n.pageTitle,
          n.headingId,
          n.headingText,
          n.quoteText,
          n.quoteHtml,
          n.note,
          n.tag,
          n.conceptId,
          n.createdAt,
          n.updatedAt,
          n.deletedAt
        )
      );
    }

    if (toDeleteIds.length > 0) {
      const deleteNoteStmt = env.DB.prepare(
        'DELETE FROM notebook_notes WHERE space_id = ? AND id = ?'
      );
      for (const id of toDeleteIds) {
        writeStmts.push(deleteNoteStmt.bind(spaceId, id));
      }
    }

    await env.DB.batch(writeStmts);
  }

  console.log(
    JSON.stringify({
      event: 'sync_ok',
      spaceHashPrefix: spaceId.slice(0, 8),
      revision,
      noteCount: mergedNotes.length,
      changedNotes: toUpsert.length,
      prunedNotes: toDeleteIds.length,
      wroteDb: !existingSpace || progressChanged || notesChanged,
      durationMs: Date.now() - startedAt,
    })
  );

  return jsonResponse(
    {
      ok: true,
      revision,
      serverTime,
      progress: mergedProgress,
      notes: mergedNotes,
    },
    200
  );
}

async function handleSyncClear(request, env, syncHashPrefix) {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', '清空云端数据仅支持 POST 请求。', {
      Allow: 'POST',
    });
  }

  const startedAt = Date.now();
  const spaceRes = await resolveSpaceId(request, syncHashPrefix);
  if (!spaceRes.ok) return spaceRes.response;
  const { spaceId } = spaceRes;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM notebook_notes WHERE space_id = ?').bind(spaceId),
    env.DB.prepare('DELETE FROM sync_spaces WHERE space_id = ?').bind(spaceId),
  ]);

  const serverTime = Date.now();
  console.log(
    JSON.stringify({
      event: 'sync_clear_ok',
      spaceHashPrefix: spaceId.slice(0, 8),
      durationMs: Date.now() - startedAt,
    })
  );

  return jsonResponse({ ok: true, serverTime }, 200);
}

/**
 * Create a Cloudflare Worker handler with an optional sync namespace prefix.
 *
 * @param {{ syncHashPrefix?: string }} [options]
 */
export function createWorker(options = {}) {
  const { syncHashPrefix = DEFAULT_SYNC_HASH_PREFIX } = options || {};
  if (typeof syncHashPrefix !== 'string' || !syncHashPrefix.trim()) {
    throw new TypeError('createWorker({ syncHashPrefix }) requires a non-empty string.');
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const { pathname } = url;

      if (pathname.startsWith('/api/')) {
        try {
          if (pathname === '/api/health') {
            return await handleHealth(request, env);
          }
          if (pathname === '/api/sync') {
            return await handleSync(request, env, syncHashPrefix);
          }
          if (pathname === '/api/sync/clear') {
            return await handleSyncClear(request, env, syncHashPrefix);
          }
          return errorResponse(404, 'not_found', 'API 端点不存在。');
        } catch (err) {
          console.error(
            JSON.stringify({
              event: 'api_error',
              path: pathname,
              errorName: err instanceof Error ? err.name : 'UnknownError',
              message: err instanceof Error ? err.message : String(err),
            })
          );
          return errorResponse(
            500,
            'internal_error',
            '云端同步服务暂时不可用，请稍后重试。'
          );
        }
      }

      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return env.ASSETS.fetch(request);
      }

      return new Response('Not Found', { status: 404 });
    },
  };
}

export default createWorker();
