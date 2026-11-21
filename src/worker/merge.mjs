/**
 * Pure validation, normalization, and deterministic bidirectional LWW merge
 * for cross-device study progress + notebook sync.
 */

import { sanitizeQuoteHtml } from './sanitizer.mjs';

export const MAX_NOTES = 500;
export const MAX_SLUGS = 200;
export const MAX_FUTURE_SKEW_MS = 60_000;
export const VALID_PRIORITY_MODES = new Set(['all', 'core', 'important']);
export const VALID_READING_STYLES = new Set(['explained', 'axiomatic']);
export const VALID_FONT_THEMES = new Set(['serif', 'wenkai', 'sans']);
export const VALID_NOTE_TAGS = new Set(['摘录', '必背', '易错', '疑问', '概念']);

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,95}$/i;
const NOTE_ID_RE = /^[a-zA-Z0-9_.:-]{1,128}$/;

function toTimestamp(val, fallback = 0, maxTs = null) {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    return fallback;
  }
  const floored = Math.floor(val);
  return maxTs !== null && floored > maxTs ? maxTs : floored;
}

function clampString(val, maxLen) {
  if (typeof val !== 'string') return '';
  const cleaned = val.replace(/\u0000/g, '');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export function createEmptyProgress() {
  return {
    resetAt: 0,
    readPages: {},
    readTombstones: {},
    scrollPositions: {},
    lastVisited: null,
    priorityMode: { value: 'all', updatedAt: 0 },
    readingStyle: { value: 'explained', updatedAt: 0 },
    fontTheme: { value: 'serif', updatedAt: 0 },
  };
}

/**
 * Normalize and bound an untrusted progress object.
 * @param {unknown} raw
 * @param {number | null} [maxTs=null] Optional upper timestamp ceiling (e.g. serverTime + 60_000)
 */
export function normalizeProgress(raw, maxTs = null) {
  const base = createEmptyProgress();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }

  base.resetAt = toTimestamp(raw.resetAt, 0, maxTs);

  if (raw.readPages && typeof raw.readPages === 'object' && !Array.isArray(raw.readPages)) {
    let count = 0;
    for (const [slug, ts] of Object.entries(raw.readPages)) {
      if (count >= MAX_SLUGS) break;
      if (!SLUG_RE.test(slug)) continue;
      // Gracefully accept legacy boolean `true` as timestamp 1 if ever sent
      const parsedTs = ts === true ? 1 : toTimestamp(ts, 0, maxTs);
      if (parsedTs > 0) {
        base.readPages[slug] = parsedTs;
        count++;
      }
    }
  }

  if (
    raw.readTombstones &&
    typeof raw.readTombstones === 'object' &&
    !Array.isArray(raw.readTombstones)
  ) {
    let count = 0;
    for (const [slug, ts] of Object.entries(raw.readTombstones)) {
      if (count >= MAX_SLUGS) break;
      if (!SLUG_RE.test(slug)) continue;
      const parsedTs = toTimestamp(ts, 0, maxTs);
      if (parsedTs > 0) {
        base.readTombstones[slug] = parsedTs;
        count++;
      }
    }
  }

  if (
    raw.scrollPositions &&
    typeof raw.scrollPositions === 'object' &&
    !Array.isArray(raw.scrollPositions)
  ) {
    let count = 0;
    for (const [slug, entry] of Object.entries(raw.scrollPositions)) {
      if (count >= MAX_SLUGS) break;
      if (!SLUG_RE.test(slug) || !entry || typeof entry !== 'object') continue;
      const updatedAt = toTimestamp(entry.updatedAt, 0, maxTs);
      if (updatedAt <= 0) continue;
      const y =
        typeof entry.y === 'number' && Number.isFinite(entry.y) && entry.y >= 0
          ? Math.round(entry.y)
          : 0;
      const ratio =
        typeof entry.ratio === 'number' && Number.isFinite(entry.ratio)
          ? Math.max(0, Math.min(1, Number(entry.ratio.toFixed(4))))
          : 0;
      const headingId = clampString(entry.headingId, 160);
      base.scrollPositions[slug] = { y, ratio, headingId, updatedAt };
      count++;
    }
  }

  if (raw.lastVisited && typeof raw.lastVisited === 'object' && !Array.isArray(raw.lastVisited)) {
    const slug = clampString(raw.lastVisited.slug, 96);
    const timestamp = toTimestamp(raw.lastVisited.timestamp, 0, maxTs);
    if (SLUG_RE.test(slug) && timestamp > 0) {
      base.lastVisited = {
        slug,
        title: clampString(raw.lastVisited.title, 200),
        shortTitle: clampString(raw.lastVisited.shortTitle, 120),
        chapterTitle: clampString(raw.lastVisited.chapterTitle, 160),
        partTitle: clampString(raw.lastVisited.partTitle, 160),
        timestamp,
      };
    }
  }

  if (raw.priorityMode && typeof raw.priorityMode === 'object' && !Array.isArray(raw.priorityMode)) {
    const val = raw.priorityMode.value;
    if (VALID_PRIORITY_MODES.has(val)) {
      base.priorityMode = {
        value: val,
        updatedAt: toTimestamp(raw.priorityMode.updatedAt, 0, maxTs),
      };
    }
  }

  if (raw.readingStyle && typeof raw.readingStyle === 'object' && !Array.isArray(raw.readingStyle)) {
    const val = raw.readingStyle.value;
    if (VALID_READING_STYLES.has(val)) {
      base.readingStyle = {
        value: val,
        updatedAt: toTimestamp(raw.readingStyle.updatedAt, 0, maxTs),
      };
    }
  }

  if (raw.fontTheme && typeof raw.fontTheme === 'object' && !Array.isArray(raw.fontTheme)) {
    const val = raw.fontTheme.value;
    if (VALID_FONT_THEMES.has(val)) {
      base.fontTheme = {
        value: val,
        updatedAt: toTimestamp(raw.fontTheme.updatedAt, 0, maxTs),
      };
    }
  }

  return base;
}

/**
 * Deterministic bidirectional LWW merge of server and client progress.
 * When `nowMs` is provided, incoming client timestamps are clamped to
 * `nowMs + MAX_FUTURE_SKEW_MS` to prevent future clock-skew poisoning.
 */
export function mergeProgress(serverRaw, clientRaw, nowMs = null) {
  const maxClientTs =
    typeof nowMs === 'number' && Number.isFinite(nowMs)
      ? Math.floor(nowMs) + MAX_FUTURE_SKEW_MS
      : null;
  const server = normalizeProgress(serverRaw);
  const client = normalizeProgress(clientRaw, maxClientTs);

  const resetAt = Math.max(server.resetAt, client.resetAt);

  // 1. Merge readPages & readTombstones under resetAt floor
  const readPages = {};
  const readTombstones = {};
  const readSlugs = new Set([
    ...Object.keys(server.readPages),
    ...Object.keys(client.readPages),
    ...Object.keys(server.readTombstones),
    ...Object.keys(client.readTombstones),
  ]);

  for (const slug of [...readSlugs].sort()) {
    const readTs = Math.max(server.readPages[slug] || 0, client.readPages[slug] || 0);
    const tombTs = Math.max(
      server.readTombstones[slug] || 0,
      client.readTombstones[slug] || 0
    );
    const deleteFloor = Math.max(resetAt, tombTs);
    if (readTs > deleteFloor) {
      readPages[slug] = readTs;
    } else if (tombTs > resetAt) {
      readTombstones[slug] = tombTs;
    }
  }

  // 2. Merge scrollPositions per slug LWW, pruning anything <= resetAt
  const scrollPositions = {};
  const scrollSlugs = new Set([
    ...Object.keys(server.scrollPositions),
    ...Object.keys(client.scrollPositions),
  ]);

  for (const slug of [...scrollSlugs].sort()) {
    const s = server.scrollPositions[slug];
    const c = client.scrollPositions[slug];
    let winner = null;
    if (s && c) {
      winner = c.updatedAt >= s.updatedAt ? c : s;
    } else {
      winner = c || s;
    }
    if (winner && winner.updatedAt > resetAt) {
      scrollPositions[slug] = winner;
    }
  }

  // 3. Merge lastVisited LWW, pruning if <= resetAt
  let lastVisited = null;
  const sLast = server.lastVisited;
  const cLast = client.lastVisited;
  if (sLast && cLast) {
    lastVisited = cLast.timestamp >= sLast.timestamp ? cLast : sLast;
  } else {
    lastVisited = cLast || sLast;
  }
  if (lastVisited && lastVisited.timestamp <= resetAt) {
    lastVisited = null;
  }

  // 4. Merge priorityMode LWW (preserved across reading-progress resets)
  const priorityMode =
    client.priorityMode.updatedAt >= server.priorityMode.updatedAt
      ? { ...client.priorityMode }
      : { ...server.priorityMode };

  // 5. Merge readingStyle LWW (preserved across reading-progress resets)
  const readingStyle =
    client.readingStyle.updatedAt >= server.readingStyle.updatedAt
      ? { ...client.readingStyle }
      : { ...server.readingStyle };

  // 6. Merge fontTheme LWW (preserved across reading-progress resets)
  const fontTheme =
    client.fontTheme.updatedAt >= server.fontTheme.updatedAt
      ? { ...client.fontTheme }
      : { ...server.fontTheme };

  return {
    resetAt,
    readPages,
    readTombstones,
    scrollPositions,
    lastVisited,
    priorityMode,
    readingStyle,
    fontTheme,
  };
}

/**
 * Normalize and sanitize a single incoming note.
 * Returns null if the note lacks a valid id.
 */
export function normalizeIncomingNote(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = clampString(raw.id, 128).trim();
  if (!NOTE_ID_RE.test(id)) return null;

  const maxTs =
    typeof nowMs === 'number' && Number.isFinite(nowMs)
      ? Math.floor(nowMs) + MAX_FUTURE_SKEW_MS
      : null;
  const fallbackNow =
    typeof nowMs === 'number' && Number.isFinite(nowMs) ? Math.floor(nowMs) : 0;

  const pageSlugRaw = clampString(raw.pageSlug, 96).trim();
  const pageSlug = SLUG_RE.test(pageSlugRaw) ? pageSlugRaw : '';
  const createdAt = toTimestamp(raw.createdAt, fallbackNow, maxTs) || fallbackNow;
  const updatedAt = Math.max(createdAt, toTimestamp(raw.updatedAt, createdAt, maxTs));
  const deletedAt =
    raw.deletedAt === null || raw.deletedAt === undefined
      ? null
      : toTimestamp(raw.deletedAt, 0, maxTs) || null;

  const rawTag = clampString(raw.tag, 16);
  const tag = VALID_NOTE_TAGS.has(rawTag) ? rawTag : '摘录';

  const conceptIdRaw =
    typeof raw.conceptId === 'string' && raw.conceptId.trim()
      ? clampString(raw.conceptId.trim(), 96)
      : null;

  return {
    id,
    pageSlug,
    pageTitle: clampString(raw.pageTitle, 200),
    headingId: clampString(raw.headingId, 160),
    headingText: clampString(raw.headingText, 240),
    quoteText: clampString(raw.quoteText, 8000),
    quoteHtml: sanitizeQuoteHtml(clampString(raw.quoteHtml, 65536)),
    note: clampString(raw.note, 8000),
    tag,
    conceptId: conceptIdRaw,
    createdAt,
    updatedAt,
    deletedAt,
  };
}

/**
 * Convert a D1 row into canonical API note shape.
 */
export function rowToNote(row) {
  return {
    id: String(row.id),
    pageSlug: String(row.page_slug || ''),
    pageTitle: String(row.page_title || ''),
    headingId: String(row.heading_id || ''),
    headingText: String(row.heading_text || ''),
    quoteText: String(row.quote_text || ''),
    quoteHtml: String(row.quote_html || ''),
    note: String(row.note || ''),
    tag: VALID_NOTE_TAGS.has(row.tag) ? row.tag : '摘录',
    conceptId: row.concept_id ? String(row.concept_id) : null,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  };
}

function noteVersionTs(note) {
  return Math.max(note.updatedAt || 0, note.deletedAt || 0);
}

function notesEqual(a, b) {
  return (
    a.id === b.id &&
    a.pageSlug === b.pageSlug &&
    a.pageTitle === b.pageTitle &&
    a.headingId === b.headingId &&
    a.headingText === b.headingText &&
    a.quoteText === b.quoteText &&
    a.quoteHtml === b.quoteHtml &&
    a.note === b.note &&
    a.tag === b.tag &&
    a.conceptId === b.conceptId &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.deletedAt === b.deletedAt
  );
}

/**
 * Pick winning note between server and client using deterministic LWW.
 */
function pickWinningNote(serverNote, clientNote) {
  const sTs = noteVersionTs(serverNote);
  const cTs = noteVersionTs(clientNote);
  if (cTs > sTs) return clientNote;
  if (sTs > cTs) return serverNote;

  // Tie-break: tombstone wins over live note at the exact same millisecond
  const sDel = serverNote.deletedAt !== null;
  const cDel = clientNote.deletedAt !== null;
  if (cDel && !sDel) return clientNote;
  if (sDel && !cDel) return serverNote;

  if (clientNote.updatedAt !== serverNote.updatedAt) {
    return clientNote.updatedAt > serverNote.updatedAt ? clientNote : serverNote;
  }
  return clientNote;
}

/**
 * Merge server notes and incoming client notes, enforcing MAX_NOTES cap
 * (pruning oldest tombstones first if combined unique IDs exceed MAX_NOTES).
 *
 * Returns:
 * - mergedNotes: sorted array for API response
 * - toUpsert: notes that are new or changed relative to serverMap
 * - toDeleteIds: server IDs pruned to respect MAX_NOTES cap
 */
export function mergeNotes(serverNotes, clientNotesRaw, nowMs) {
  const serverMap = new Map();
  for (const n of serverNotes) {
    serverMap.set(n.id, n);
  }

  const mergedMap = new Map(serverMap);

  for (const raw of clientNotesRaw) {
    const incoming = normalizeIncomingNote(raw, nowMs);
    if (!incoming) continue;
    const existing = mergedMap.get(incoming.id);
    if (!existing) {
      mergedMap.set(incoming.id, incoming);
    } else {
      mergedMap.set(incoming.id, pickWinningNote(existing, incoming));
    }
  }

  let mergedList = [...mergedMap.values()];
  const prunedIds = new Set();

  if (mergedList.length > MAX_NOTES) {
    // Sort so we keep: all active notes first (newest updatedAt), then newest tombstones
    mergedList.sort((a, b) => {
      const aDel = a.deletedAt !== null ? 1 : 0;
      const bDel = b.deletedAt !== null ? 1 : 0;
      if (aDel !== bDel) return aDel - bDel;
      return noteVersionTs(b) - noteVersionTs(a) || a.id.localeCompare(b.id);
    });
    const dropped = mergedList.slice(MAX_NOTES);
    for (const d of dropped) {
      prunedIds.add(d.id);
    }
    mergedList = mergedList.slice(0, MAX_NOTES);
  }

  // Canonical stable ordering for API output: newest updatedAt descending
  mergedList.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id)
  );

  const toUpsert = [];
  for (const note of mergedList) {
    const prev = serverMap.get(note.id);
    if (!prev || !notesEqual(prev, note)) {
      toUpsert.push(note);
    }
  }

  const toDeleteIds = [];
  for (const id of prunedIds) {
    if (serverMap.has(id)) {
      toDeleteIds.push(id);
    }
  }

  return { mergedNotes: mergedList, toUpsert, toDeleteIds };
}
