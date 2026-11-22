#!/usr/bin/env node
/**
 * Unit & integration tests for `notes-site-base` Worker runtime:
 * - sanitizer.mjs (XSS/mXSS blocking + KaTeX MathML/SVG preservation)
 * - merge.mjs (LWW progress/readingStyle/fontTheme/notes merge, legacy compat, clock-skew clamp)
 * - index.mjs (`createWorker` factory, default `notes-sync-v1:`, custom `syncHashPrefix`, namespace isolation)
 * - prepare-deploy.mjs (Build Output Spec v1 bundling for both thin entrypoint and zero-entrypoint modes)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { sanitizeQuoteHtml } from './sanitizer.mjs';
import { MAX_FUTURE_SKEW_MS, MAX_NOTES, mergeNotes, mergeProgress } from './merge.mjs';
import defaultWorker, { DEFAULT_SYNC_HASH_PREFIX, createWorker } from './index.mjs';
import { loadCloudflareConfig, prepareDeploy } from './prepare-deploy.mjs';

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function createMockD1() {
  const spaces = new Map();
  const notes = new Map(); // key: `${space_id}::${id}`
  let batchCalls = 0;

  class MockStmt {
    constructor(sql, params = []) {
      this.sql = sql.trim();
      this.params = params;
    }
    bind(...params) {
      return new MockStmt(this.sql, params);
    }
    async first() {
      if (/^SELECT 1 AS ok/i.test(this.sql)) {
        return { ok: 1 };
      }
      throw new Error(`Unsupported first(): ${this.sql}`);
    }
    _exec() {
      const s = this.sql;
      if (s.startsWith('SELECT space_id, revision')) {
        const row = spaces.get(this.params[0]);
        return { success: true, results: row ? [row] : [] };
      }
      if (s.startsWith('SELECT id, page_slug')) {
        const spaceId = this.params[0];
        const rows = [];
        for (const r of notes.values()) {
          if (r.space_id === spaceId) rows.push({ ...r });
        }
        return { success: true, results: rows };
      }
      if (s.startsWith('INSERT INTO sync_spaces')) {
        const [space_id, revision, progress_json, created_at, updated_at] = this.params;
        const prev = spaces.get(space_id);
        spaces.set(space_id, {
          space_id,
          revision,
          progress_json,
          created_at: prev ? prev.created_at : created_at,
          updated_at,
        });
        return { success: true, results: [] };
      }
      if (s.startsWith('INSERT INTO notebook_notes')) {
        const [
          space_id,
          id,
          page_slug,
          page_title,
          heading_id,
          heading_text,
          quote_text,
          quote_html,
          note,
          tag,
          concept_id,
          created_at,
          updated_at,
          deleted_at,
        ] = this.params;
        notes.set(`${space_id}::${id}`, {
          space_id,
          id,
          page_slug,
          page_title,
          heading_id,
          heading_text,
          quote_text,
          quote_html,
          note,
          tag,
          concept_id,
          created_at,
          updated_at,
          deleted_at,
        });
        return { success: true, results: [] };
      }
      if (s.startsWith('DELETE FROM notebook_notes WHERE space_id = ? AND id = ?')) {
        notes.delete(`${this.params[0]}::${this.params[1]}`);
        return { success: true, results: [] };
      }
      if (s.startsWith('DELETE FROM notebook_notes WHERE space_id = ?')) {
        const sid = this.params[0];
        for (const k of [...notes.keys()]) {
          if (k.startsWith(`${sid}::`)) notes.delete(k);
        }
        return { success: true, results: [] };
      }
      if (s.startsWith('DELETE FROM sync_spaces WHERE space_id = ?')) {
        spaces.delete(this.params[0]);
        return { success: true, results: [] };
      }
      throw new Error(`Unsupported SQL in mock D1: ${s}`);
    }
  }

  return {
    spaces,
    notes,
    getBatchCalls: () => batchCalls,
    prepare: (sql) => new MockStmt(sql),
    batch: async (stmts) => {
      batchCalls++;
      return stmts.map((st) => st._exec());
    },
  };
}

function testSanitizer() {
  const xssPayloads = [
    '<script>alert(1)</script><span>safe</span>',
    '<img src=x onerror="alert(1)">ok',
    '<svg onload="alert(1)"><script>alert(2)</script><path d="M0 0L10 10"/></svg>',
    '<a href="javascript:alert(1)">click</a>',
    '<span onclick="alert(1)" onmouseover="evil()" style="position:fixed;background:url(javascript:alert(1));top:0.2em;color:#333">math</span>',
    '<span style="width:expression(alert(1));margin-right:0.2em">x</span>',
    '<svg><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>',
    '<span class="katex"><b>unclosed',
    '<!-- <script>alert(1)</script> --><span>hi</span>',
    '<span style="&#x75;rl(javascript:alert(1))">enc</span>',
  ];

  for (const payload of xssPayloads) {
    const clean = sanitizeQuoteHtml(payload);
    assert.ok(!/<script/i.test(clean), `script leaked: ${clean}`);
    assert.ok(!/<iframe/i.test(clean), `iframe leaked: ${clean}`);
    assert.ok(!/<foreignobject/i.test(clean), `foreignObject leaked: ${clean}`);
    assert.ok(!/\bon[a-z]+\s*=/i.test(clean), `event handler leaked: ${clean}`);
    assert.ok(!/javascript:/i.test(clean), `javascript: leaked: ${clean}`);
    assert.ok(!/expression\s*\(/i.test(clean), `expression() leaked: ${clean}`);
    assert.ok(!/url\s*\(/i.test(clean), `url() leaked: ${clean}`);
    assert.ok(!/position\s*:\s*fixed/i.test(clean), `position:fixed leaked: ${clean}`);
  }

  // Safe inline style properties preserved
  assert.equal(
    sanitizeQuoteHtml(
      '<span onclick="x" style="position:fixed;top:0.2em;margin-right:0.15em">ok</span>'
    ),
    '<span style="top:0.2em;margin-right:0.15em">ok</span>'
  );

  // Unclosed tags cleanly balanced
  assert.equal(
    sanitizeQuoteHtml('<span class="katex"><b>unclosed'),
    '<span class="katex"><b>unclosed</b></span>'
  );

  // SVG <circle> & MathML KaTeX preservation
  assert.equal(
    sanitizeQuoteHtml(
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2.5" fill="currentColor" stroke="#111" stroke-width="1" class="dot" onclick="alert(1)"/></svg>'
    ),
    '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2.5" fill="currentColor" stroke="#111" stroke-width="1" class="dot"></circle></svg>'
  );
  assert.equal(
    sanitizeQuoteHtml(
      '<svg viewBox="0 0 10 10"><circle cx="5px;evil" cy="5" r="2" fill="url(https://evil.test/#p)" stroke="javascript:1"/></svg>'
    ),
    '<svg viewBox="0 0 10 10"><circle cy="5" r="2"></circle></svg>'
  );

  const katexSample =
    '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msqrt><mi>x</mi></msqrt></mrow><annotation encoding="application/x-tex">\\sqrt{x}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="400em" height="1.08em" viewBox="0 0 400000 1080" preserveAspectRatio="xMinYMin slice"><path d="M95 702L145 500"/></svg></span></span>';
  const cleanKatex = sanitizeQuoteHtml(katexSample);
  assert.ok(cleanKatex.includes('xmlns="http://www.w3.org/1998/Math/MathML"'));
  assert.ok(cleanKatex.includes('encoding="application/x-tex"'));
  assert.ok(cleanKatex.includes('preserveAspectRatio="xMinYMin slice"'));
  assert.ok(cleanKatex.includes('<path d="M95 702L145 500"></path>'));

  // Table with KaTeX, colspan/rowspan (1..20), and cell style (text-align/white-space)
  const katexTable =
    '<table onclick="alert(1)"><caption>乘法表</caption><thead><tr><th style="text-align:center;white-space:nowrap" colspan="2" rowspan="1">运算</th></tr></thead><tbody><tr><td style="text-align:right;line-height:1.4;border-style:solid;max-height:10em"><span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mo>⋅</mo><mi>b</mi></math></span></td><td style="text-align:left"><u>单位元</u></td></tr></tbody><tfoot><tr><td colspan="2">注</td></tr></tfoot></table>';
  const cleanTable = sanitizeQuoteHtml(katexTable);
  assert.ok(!cleanTable.includes('onclick'), 'table onclick must be stripped');
  assert.equal(
    cleanTable,
    '<table><caption>乘法表</caption><thead><tr><th style="text-align:center;white-space:nowrap" colspan="2" rowspan="1">运算</th></tr></thead><tbody><tr><td style="text-align:right;line-height:1.4;border-style:solid;max-height:10em"><span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mo>⋅</mo><mi>b</mi></math></span></td><td style="text-align:left"><u>单位元</u></td></tr></tbody><tfoot><tr><td colspan="2">注</td></tr></tfoot></table>'
  );

  // Table & cell XSS / out-of-range colspan/rowspan / dangerous style blocking
  const hostileTable =
    '<table colspan="2"><tr><td colspan="1&quot; onload=alert(1)" rowspan="21" style="position:fixed;text-align:center;background:url(javascript:alert(1));white-space:bogus;border-style:evil">x</td><th colspan="0" rowspan="-1" style="text-align:left;width:expression(1)">y</th></tr></table>';
  const cleanHostileTable = sanitizeQuoteHtml(hostileTable);
  assert.ok(!cleanHostileTable.includes('onload'), 'onload must be blocked');
  assert.ok(!cleanHostileTable.includes('colspan='), 'invalid/non-cell colspan must be stripped');
  assert.ok(!cleanHostileTable.includes('rowspan='), 'out-of-range rowspan must be stripped');
  assert.ok(!cleanHostileTable.includes('position:fixed'), 'position:fixed on td must be stripped');
  assert.ok(!cleanHostileTable.includes('expression('), 'expression() on th must be stripped');
  // NOTE: because raw style on td contained url(...), fail-closed DANGEROUS_CSS_RE rejects the entire style string!
  assert.equal(
    cleanHostileTable,
    '<table><tr><td>x</td><th>y</th></tr></table>'
  );

  // Mixed safe + invalid (non-dangerous) properties on td keep only valid safe properties
  assert.equal(
    sanitizeQuoteHtml(
      '<table><tr><td style="position:fixed;text-align:center;white-space:bogus">z</td></tr></table>'
    ),
    '<table><tr><td style="text-align:center">z</td></tr></table>'
  );

  // Nested lists with KaTeX, headings, blockquote, pre/code, and self-terminating <hr>
  const richProse =
    '<h3>判定步骤</h3><blockquote><p>满足三条即可</p></blockquote><hr><ul><li>第一条：<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><mphantom><mi>x</mi></mphantom><menclose notation="updiagonalstrike"><mi>y</mi></menclose></math></span><ol><li>子步骤</li></ol></li></ul><pre><code>x = 1</code></pre>';
  const cleanRichProse = sanitizeQuoteHtml(richProse);
  assert.equal(cleanRichProse, richProse);
  assert.ok(!cleanRichProse.includes('</hr>'), '<hr> must be void and never emit </hr>');

  // SVG <g>, <line>, <rect> valid attrs preserved & hostile attrs stripped
  const svgExtended =
    '<svg viewBox="0 0 20 20"><g transform="translate(2, 3)" fill="none" stroke="currentColor" style="opacity:0.8"><line x1="0" y1="0" x2="10" y2="10" stroke="#111" stroke-width="1"/><rect x="1" y="2" width="8" height="4" rx="1" fill="#333"/></g></svg>';
  assert.equal(
    sanitizeQuoteHtml(svgExtended),
    '<svg viewBox="0 0 20 20"><g transform="translate(2, 3)" fill="none" stroke="currentColor" style="opacity:0.8"><line x1="0" y1="0" x2="10" y2="10" stroke="#111" stroke-width="1"></line><rect x="1" y="2" width="8" height="4" rx="1" fill="#333"></rect></g></svg>'
  );
  const svgHostile =
    '<svg viewBox="0 0 20 20"><g transform="url(https://evil.test)" onclick="alert(1)"><line x1="javascript:1" y1="0" x2="10" y2="10" stroke="url(#bad)"/><rect x="1" y="2" width="expression(1)" height="4"/></g></svg>';
  assert.equal(
    sanitizeQuoteHtml(svgHostile),
    '<svg viewBox="0 0 20 20"><g><line y1="0" x2="10" y2="10"></line><rect x="1" y="2" height="4"></rect></g></svg>'
  );

  console.log('✓ sanitizer tests passed');
}

function testMerge() {
  // 1. resetAt floor vs readPages / readTombstones / scroll / lastVisited / preferences
  const server = {
    resetAt: 1000,
    readPages: { p01: 900, p02: 1500, p03: 1200 },
    readTombstones: { p03: 1300 },
    scrollPositions: {
      p01: { y: 100, ratio: 0.1, headingId: 'h1', updatedAt: 950 },
      p02: { y: 200, ratio: 0.2, headingId: 'h2', updatedAt: 1500 },
    },
    lastVisited: { slug: 'p01', title: 'P01', timestamp: 950 },
    priorityMode: { value: 'core', updatedAt: 500 },
  };
  const client = {
    resetAt: 1100,
    readPages: { p02: 1400, p04: 2000 },
    readTombstones: { p02: 1600 },
    scrollPositions: {
      p02: { y: 350, ratio: 0.35, headingId: 'h3', updatedAt: 1700 },
    },
    lastVisited: { slug: 'p04', title: 'P04', timestamp: 2000 },
    priorityMode: { value: 'important', updatedAt: 800 },
  };

  const merged = mergeProgress(server, client);
  assert.equal(merged.resetAt, 1100);
  assert.deepEqual(merged.readPages, { p04: 2000 });
  assert.deepEqual(merged.readTombstones, { p02: 1600, p03: 1300 });
  assert.deepEqual(merged.scrollPositions, {
    p02: { y: 350, ratio: 0.35, headingId: 'h3', updatedAt: 1700 },
  });
  assert.equal(merged.lastVisited.slug, 'p04');
  assert.deepEqual(merged.priorityMode, { value: 'important', updatedAt: 800 });

  // 2. Notes LWW + tombstone tie-break + 500 cap pruning oldest tombstones
  const sNotes = [
    {
      id: 'n1',
      pageSlug: 'p01',
      pageTitle: 'P01',
      headingId: 'h1',
      headingText: 'H1',
      quoteText: 'old',
      quoteHtml: '<span>old</span>',
      note: '',
      tag: '摘录',
      conceptId: null,
      createdAt: 100,
      updatedAt: 200,
      deletedAt: null,
    },
    {
      id: 'n2',
      pageSlug: 'p01',
      pageTitle: 'P01',
      headingId: '',
      headingText: '',
      quoteText: 'keep',
      quoteHtml: '',
      note: '',
      tag: '必背',
      conceptId: null,
      createdAt: 100,
      updatedAt: 300,
      deletedAt: null,
    },
  ];
  const cNotes = [
    {
      id: 'n1',
      pageSlug: 'p01',
      pageTitle: 'P01',
      headingId: 'h1',
      headingText: 'H1',
      quoteText: 'old',
      quoteHtml: '<span>old</span>',
      note: '',
      tag: '摘录',
      conceptId: null,
      createdAt: 100,
      updatedAt: 200,
      deletedAt: 200,
    },
  ];
  const res = mergeNotes(sNotes, cNotes, 500);
  assert.equal(res.mergedNotes.find((n) => n.id === 'n1').deletedAt, 200);
  assert.equal(res.toUpsert.length, 1);

  const manyServer = [];
  for (let i = 0; i < MAX_NOTES; i++) {
    manyServer.push({
      id: `s-${i}`,
      pageSlug: 'p01',
      pageTitle: 'P01',
      headingId: '',
      headingText: '',
      quoteText: `q${i}`,
      quoteHtml: '',
      note: '',
      tag: '摘录',
      conceptId: null,
      createdAt: 100 + i,
      updatedAt: 100 + i,
      deletedAt: i < 5 ? 100 + i : null,
    });
  }
  const capped = mergeNotes(
    manyServer,
    [
      {
        id: 'c-new-1',
        pageSlug: 'p01',
        pageTitle: 'P01',
        quoteText: 'new',
        quoteHtml: '',
        note: '',
        tag: '易错',
        createdAt: 9999,
        updatedAt: 9999,
        deletedAt: null,
      },
    ],
    10000
  );
  assert.equal(capped.mergedNotes.length, MAX_NOTES);
  assert.deepEqual(capped.toDeleteIds, ['s-0']);
  assert.ok(capped.mergedNotes.some((n) => n.id === 'c-new-1'));

  // 3. Future clock-skew ceiling (serverTime + 60_000)
  const nowMs = 1_700_000_000_000;
  const ceiling = nowMs + MAX_FUTURE_SKEW_MS;
  const farFuture = nowMs + 86_400_000 * 365;
  const clampedProg = mergeProgress(
    {},
    {
      resetAt: farFuture,
      readPages: { p01: farFuture + 10 },
      readTombstones: { p02: farFuture + 20 },
      scrollPositions: { p03: { y: 50, ratio: 0.2, headingId: 'h1', updatedAt: farFuture + 30 } },
      lastVisited: { slug: 'p01', title: 'P01', timestamp: farFuture + 40 },
      priorityMode: { value: 'core', updatedAt: farFuture + 50 },
      readingStyle: { value: 'axiomatic', updatedAt: farFuture + 60 },
      fontTheme: { value: 'wenkai', updatedAt: farFuture + 70 },
    },
    nowMs
  );
  assert.equal(clampedProg.resetAt, ceiling);
  assert.deepEqual(clampedProg.readPages, {});
  assert.deepEqual(clampedProg.readTombstones, {});
  assert.deepEqual(clampedProg.scrollPositions, {});
  assert.equal(clampedProg.lastVisited, null);
  assert.deepEqual(clampedProg.priorityMode, { value: 'core', updatedAt: ceiling });
  assert.deepEqual(clampedProg.readingStyle, { value: 'axiomatic', updatedAt: ceiling });
  assert.deepEqual(clampedProg.fontTheme, { value: 'wenkai', updatedAt: ceiling });

  const clampedNotes = mergeNotes(
    [],
    [
      {
        id: 'future-note',
        pageSlug: 'p01',
        pageTitle: 'P01',
        quoteText: 'skew',
        quoteHtml: '',
        note: '',
        tag: '摘录',
        createdAt: farFuture,
        updatedAt: farFuture + 1000,
        deletedAt: farFuture + 2000,
      },
    ],
    nowMs
  );
  assert.equal(clampedNotes.mergedNotes[0].createdAt, ceiling);
  assert.equal(clampedNotes.mergedNotes[0].updatedAt, ceiling);
  assert.equal(clampedNotes.mergedNotes[0].deletedAt, ceiling);

  // 4. readingStyle & fontTheme legacy compat + invalid fallbacks
  const legacyBoth = mergeProgress(
    { resetAt: 100, readPages: { p01: 200 }, priorityMode: { value: 'core', updatedAt: 200 } },
    { resetAt: 100, readPages: { p01: 200 } },
    nowMs
  );
  assert.deepEqual(legacyBoth.readingStyle, { value: 'explained', updatedAt: 0 });
  assert.deepEqual(legacyBoth.fontTheme, { value: 'serif', updatedAt: 0 });

  const legacyClientPreservesServer = mergeProgress(
    {
      readingStyle: { value: 'axiomatic', updatedAt: 500 },
      fontTheme: { value: 'sans', updatedAt: 500 },
    },
    { resetAt: 1000 },
    nowMs
  );
  assert.deepEqual(legacyClientPreservesServer.readingStyle, { value: 'axiomatic', updatedAt: 500 });
  assert.deepEqual(legacyClientPreservesServer.fontTheme, { value: 'sans', updatedAt: 500 });

  const invalidPrefs = mergeProgress(
    {
      readingStyle: { value: 'axiomatic', updatedAt: 500 },
      fontTheme: { value: 'wenkai', updatedAt: 500 },
    },
    {
      readingStyle: { value: 'bogus', updatedAt: 9999 },
      fontTheme: { value: 'comic-sans', updatedAt: 9999 },
    },
    nowMs
  );
  assert.deepEqual(invalidPrefs.readingStyle, { value: 'axiomatic', updatedAt: 500 });
  assert.deepEqual(invalidPrefs.fontTheme, { value: 'wenkai', updatedAt: 500 });

  console.log('✓ merge tests passed');
}

async function testWorkerFactoryAndIsolation() {
  // 0. Invalid syncHashPrefix throws TypeError
  assert.throws(() => createWorker({ syncHashPrefix: '' }), TypeError);
  assert.throws(() => createWorker({ syncHashPrefix: '   ' }), TypeError);
  assert.throws(() => createWorker({ syncHashPrefix: 123 }), TypeError);
  assert.equal(DEFAULT_SYNC_HASH_PREFIX, 'notes-sync-v1:');

  const db = createMockD1();
  const env = {
    DB: db,
    ASSETS: {
      fetch: async (req) => new Response(`ASSET:${new URL(req.url).pathname}`, { status: 200 }),
    },
  };

  // 1. GET /api/health
  const healthRes = await defaultWorker.fetch(new Request('https://example.test/api/health'), env);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get('Cache-Control'), 'no-store');
  assert.equal(healthRes.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await healthRes.json()).d1, true);

  // 2. Reject short sync code (400), >512 KiB body (413), wrong method (405), unknown endpoint (404)
  const badCodeRes = await defaultWorker.fetch(
    new Request('https://example.test/api/sync', {
      method: 'POST',
      headers: { 'X-Sync-Code': '12345', 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: {}, notes: [] }),
    }),
    env
  );
  assert.equal(badCodeRes.status, 400);

  const hugeRes = await defaultWorker.fetch(
    new Request('https://example.test/api/sync', {
      method: 'POST',
      headers: { 'X-Sync-Code': 'notes-1234-5678', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'a'.repeat(520 * 1024) }),
    }),
    env
  );
  assert.equal(hugeRes.status, 413);

  const wrongMethodRes = await defaultWorker.fetch(
    new Request('https://example.test/api/sync', { method: 'GET' }),
    env
  );
  assert.equal(wrongMethodRes.status, 405);

  const notFoundApiRes = await defaultWorker.fetch(
    new Request('https://example.test/api/unknown'),
    env
  );
  assert.equal(notFoundApiRes.status, 404);

  // 3. Default worker (`notes-sync-v1:`) with Chinese URI-encoded passphrase + XSS sanitization
  const sharedCode = '期末复习同步码2026';
  const expectedDefaultSpaceId = sha256Hex(`notes-sync-v1:${sharedCode}`);
  const expectedAlgebraSpaceId = sha256Hex(`algebra-sync-v1:${sharedCode}`);
  assert.notEqual(expectedDefaultSpaceId, expectedAlgebraSpaceId);

  const syncDefaultRes = await defaultWorker.fetch(
    new Request('https://example.test/api/sync', {
      method: 'POST',
      headers: {
        'X-Sync-Code': encodeURIComponent(sharedCode),
        'X-Sync-Code-Encoding': 'uri',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientTime: 1000,
        progress: {
          resetAt: 0,
          readPages: { 'lesson-01': 1000 },
          priorityMode: { value: 'core', updatedAt: 1000 },
          readingStyle: { value: 'axiomatic', updatedAt: 1000 },
          fontTheme: { value: 'wenkai', updatedAt: 1000 },
        },
        notes: [
          {
            id: 'note-default-1',
            pageSlug: 'lesson-01',
            pageTitle: '示例讲义',
            headingId: 'sec-1',
            headingText: '定义',
            quoteText: '定理 $f(x) = x^2$',
            quoteHtml: '<span class="katex" onclick="alert(1)">x^2</span><script>evil()</script>',
            note: '重点',
            tag: '必背',
            conceptId: null,
            createdAt: 1000,
            updatedAt: 1000,
            deletedAt: null,
          },
        ],
      }),
    }),
    env
  );
  assert.equal(syncDefaultRes.status, 200);
  const bodyDefault = await syncDefaultRes.json();
  assert.equal(bodyDefault.ok, true);
  assert.equal(bodyDefault.revision, 1);
  assert.deepEqual(bodyDefault.progress.readingStyle, { value: 'axiomatic', updatedAt: 1000 });
  assert.deepEqual(bodyDefault.progress.fontTheme, { value: 'wenkai', updatedAt: 1000 });
  assert.equal(bodyDefault.notes[0].quoteHtml, '<span class="katex">x^2</span>');
  assert.ok(db.spaces.has(expectedDefaultSpaceId), 'default worker must hash with notes-sync-v1:');

  // 4. Idle repeat sync skips write batch
  const callsBeforeIdle = db.getBatchCalls();
  const idleRes = await defaultWorker.fetch(
    new Request('https://example.test/api/sync', {
      method: 'POST',
      headers: {
        'X-Sync-Code': encodeURIComponent(sharedCode),
        'X-Sync-Code-Encoding': 'uri',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientTime: 1001,
        progress: bodyDefault.progress,
        notes: bodyDefault.notes,
      }),
    }),
    env
  );
  assert.equal((await idleRes.json()).revision, 1);
  assert.equal(db.getBatchCalls(), callsBeforeIdle + 1, 'idle sync should perform read batch only');

  // 5. Custom `syncHashPrefix: 'algebra-sync-v1:'` — exact backward compat & strict space isolation!
  const algebraWorker = createWorker({ syncHashPrefix: 'algebra-sync-v1:' });
  const syncAlgebraRes = await algebraWorker.fetch(
    new Request('https://example.test/api/sync', {
      method: 'POST',
      headers: {
        'X-Sync-Code': encodeURIComponent(sharedCode),
        'X-Sync-Code-Encoding': 'uri',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientTime: 2000,
        progress: {
          resetAt: 0,
          readPages: { 'p03-01-group-definitions': 2000 },
          priorityMode: { value: 'important', updatedAt: 2000 },
          fontTheme: { value: 'serif', updatedAt: 2000 },
        },
        notes: [],
      }),
    }),
    env
  );
  assert.equal(syncAlgebraRes.status, 200);
  const bodyAlgebra = await syncAlgebraRes.json();
  assert.equal(bodyAlgebra.revision, 1, 'algebra-sync-v1: space must be completely isolated from notes-sync-v1:');
  assert.equal(bodyAlgebra.notes.length, 0, 'algebra-sync-v1: must NOT see notes from notes-sync-v1:');
  assert.deepEqual(bodyAlgebra.progress.readPages, { 'p03-01-group-definitions': 2000 });
  assert.ok(db.spaces.has(expectedAlgebraSpaceId), 'custom worker must hash with algebra-sync-v1:');
  assert.equal(db.spaces.size, 2);

  // Clearing algebra-sync-v1: must NOT delete notes-sync-v1:
  const clearAlgebra = await algebraWorker.fetch(
    new Request('https://example.test/api/sync/clear', {
      method: 'POST',
      headers: {
        'X-Sync-Code': encodeURIComponent(sharedCode),
        'X-Sync-Code-Encoding': 'uri',
      },
    }),
    env
  );
  assert.equal(clearAlgebra.status, 200);
  assert.ok(!db.spaces.has(expectedAlgebraSpaceId));
  assert.ok(db.spaces.has(expectedDefaultSpaceId), 'clearing one namespace must never affect another');
  assert.equal(db.notes.size, 1);

  // Clear default space cleanly
  const clearDefault = await defaultWorker.fetch(
    new Request('https://example.test/api/sync/clear', {
      method: 'POST',
      headers: {
        'X-Sync-Code': encodeURIComponent(sharedCode),
        'X-Sync-Code-Encoding': 'uri',
      },
    }),
    env
  );
  assert.equal(clearDefault.status, 200);
  assert.equal(db.spaces.size, 0);
  assert.equal(db.notes.size, 0);

  // 6. Static asset fallthrough
  const assetRes = await defaultWorker.fetch(new Request('https://example.test/pages/lesson-01'), env);
  assert.equal(assetRes.status, 200);
  assert.equal(await assetRes.text(), 'ASSET:/pages/lesson-01');

  console.log('✓ worker factory & namespace isolation tests passed');
}

async function testPrepareDeploy() {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-site-base-deploy-'));
  try {
    // Mode A: Consumer with thin `src/worker.mjs` importing `notes-site-base/worker`
    const projA = path.join(tmpBase, 'proj-thin-entry');
    await fs.mkdir(path.join(projA, 'dist'), { recursive: true });
    await fs.mkdir(path.join(projA, 'src'), { recursive: true });
    await fs.writeFile(path.join(projA, 'dist', 'index.html'), '<h1>Hello</h1>', 'utf8');
    await fs.writeFile(
      path.join(projA, 'src', 'worker.mjs'),
      `import { createWorker } from 'notes-site-base/worker';\nexport default createWorker({ syncHashPrefix: 'custom-course-v1:' });\n`,
      'utf8'
    );
    await fs.writeFile(
      path.join(projA, 'cloudflare.config.ts'),
      `export default {
  worker: {
    name: "sample-course",
    entrypoint: "./src/worker.mjs",
    compatibilityDate: "2026-11-15",
    workersDev: true,
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page", runWorkerFirst: ["/api/*"] },
    env: { DB: { type: "d1", name: "sample-db", id: "00000000-0000-0000-0000-000000000000" }, ASSETS: { type: "assets" } },
  },
};\n`,
      'utf8'
    );

    const resA = await prepareDeploy({ rootDir: projA, quiet: true });
    assert.equal(resA.workerConfig.manifest.mainModule, 'index.mjs');
    assert.ok(resA.workerConfig.manifest.modules['index.mjs']);
    assert.ok(resA.workerConfig.manifest.modules['_notes_base/index.mjs']);
    assert.ok(resA.workerConfig.manifest.modules['_notes_base/merge.mjs']);
    assert.ok(resA.workerConfig.manifest.modules['_notes_base/sanitizer.mjs']);

    // Explicitly verify Node 20.x ERR_UNKNOWN_FILE_EXTENSION fallback loader on cloudflare.config.ts
    const fallbackCfg = await loadCloudflareConfig(path.join(projA, 'cloudflare.config.ts'), {
      forceFallback: true,
    });
    assert.equal(fallbackCfg.worker.name, 'sample-course');
    assert.equal(fallbackCfg.worker.entrypoint, './src/worker.mjs');

    // Dynamically import bundled index.mjs directly from /tmp (ZERO node_modules!) and verify runtime execution!
    const bundledA = (
      await import(`${pathToFileURL(path.join(resA.bundleDir, 'index.mjs')).href}?t=${Date.now()}`)
    ).default;
    const dbA = createMockD1();
    const envA = { DB: dbA, ASSETS: { fetch: async () => new Response('OK') } };
    const rA = await bundledA.fetch(
      new Request('https://sample.test/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Code': 'course-code-999' },
        body: JSON.stringify({ progress: { readPages: { p01: 100 } }, notes: [] }),
      }),
      envA
    );
    assert.equal(rA.status, 200);
    assert.ok(
      dbA.spaces.has(sha256Hex('custom-course-v1:course-code-999')),
      'bundled thin entrypoint must preserve custom syncHashPrefix without node_modules'
    );

    // Mode B: Zero-entrypoint consumer configured purely via `site.config.json`
    const projB = path.join(tmpBase, 'proj-zero-entry');
    await fs.mkdir(path.join(projB, 'dist'), { recursive: true });
    await fs.writeFile(path.join(projB, 'dist', 'index.html'), '<h1>Zero Entry</h1>', 'utf8');
    await fs.writeFile(
      path.join(projB, 'site.config.json'),
      JSON.stringify({ storage: { syncHashPrefix: 'algebra-sync-v1:' } }),
      'utf8'
    );
    await fs.writeFile(
      path.join(projB, 'cloudflare.config.ts'),
      `export default {
  worker: {
    name: "zero-entry-course",
    compatibilityDate: "2026-11-15",
    workersDev: true,
  },
};\n`,
      'utf8'
    );

    const resB = await prepareDeploy({ rootDir: projB, quiet: true });
    const bundledB = (
      await import(`${pathToFileURL(path.join(resB.bundleDir, 'index.mjs')).href}?t=${Date.now()}`)
    ).default;
    const dbB = createMockD1();
    const rB = await bundledB.fetch(
      new Request('https://sample.test/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Code': 'course-code-999' },
        body: JSON.stringify({ progress: {}, notes: [] }),
      }),
      { DB: dbB, ASSETS: { fetch: async () => new Response('OK') } }
    );
    assert.equal(rB.status, 200);
    assert.ok(
      dbB.spaces.has(sha256Hex('algebra-sync-v1:course-code-999')),
      'zero-entrypoint bundle must pick up storage.syncHashPrefix from site.config.json'
    );

    console.log('✓ prepare-deploy bundling tests passed');
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
}

testSanitizer();
testMerge();
await testWorkerFactoryAndIsolation();
await testPrepareDeploy();
console.log('ALL NOTES-SITE-BASE WORKER TESTS PASSED!');
