(() => {
  'use strict';

  const app = window.NotesSiteApp || window.__NOTES_SITE_APP__ || window.__ALGEBRA_APP__;
  if (!app) return;

  const storagePrefix =
    app.storagePrefix || document.body?.dataset?.storagePrefix || 'notes:v1';
  const exportPrefix =
    app.exportPrefix ||
    document.body?.dataset?.exportPrefix ||
    document.body?.dataset?.siteTitle ||
    '学习讲义';

  const NB_STORAGE = {
    notes: `${storagePrefix}:notes`,
    syncCode: `${storagePrefix}:syncCode`,
    syncMeta: `${storagePrefix}:syncMeta`,
  };

  const VALID_TAGS = ['摘录', '必背', '易错', '疑问', '概念'];
  const MAX_NOTES = 500;
  const reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointerMql = window.matchMedia('(pointer: fine)');
  const narrowMql = window.matchMedia('(max-width: 640px)');

  /* ========================================================================
     1. Strict DOM Allowlist Sanitizer (sanitize-untrusted-html guidance)
     Rebuilds clean DOM fragments via createElement/createElementNS and mounts
     via replaceChildren() — zero raw innerHTML on untrusted content.
     ======================================================================== */

  const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ALLOWED_HTML_TAGS = new Set([
    'span', 'div', 'p', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'sub', 'sup', 'br', 'small',
  ]);
  const ALLOWED_MATHML_TAGS = new Set([
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'mtext', 'msup', 'msub', 'msubsup',
    'mfrac', 'msqrt', 'mroot', 'mspace', 'mstyle', 'mtable', 'mtr', 'mtd',
    'mover', 'munder', 'munderover', 'mpadded', 'mphantom', 'menclose', 'annotation',
  ]);
  const ALLOWED_SVG_TAGS = new Set(['svg', 'path', 'line', 'rect', 'circle', 'g']);

  const ALLOWED_HTML_ATTRS = new Set(['class', 'aria-hidden', 'style']);
  const ALLOWED_MATHML_ATTRS = new Set([
    'xmlns', 'encoding', 'display', 'mathvariant', 'stretchy', 'fence', 'separator',
    'lspace', 'rspace', 'linethickness', 'columnalign', 'columnspacing',
    'rowspacing', 'scriptlevel', 'displaystyle', 'accent', 'accentunder',
    'width', 'minsize', 'maxsize', 'aria-hidden',
  ]);
  const ALLOWED_SVG_ATTRS = new Set([
    'xmlns', 'class', 'style', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'd',
    'x1', 'y1', 'x2', 'y2', 'x', 'y', 'cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width',
    'transform', 'aria-hidden', 'focusable',
  ]);

  const ALLOWED_CSS_PROPS = new Set([
    'top', 'bottom', 'left', 'right', 'height', 'min-height', 'max-height',
    'width', 'min-width', 'max-width', 'margin', 'margin-top', 'margin-bottom',
    'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom',
    'padding-left', 'padding-right', 'border-bottom-width', 'border-top-width',
    'border-right-width', 'border-left-width', 'border-color', 'border-style',
    'vertical-align', 'font-size', 'line-height', 'display', 'position',
    'color', 'background-color', 'opacity', 'text-align', 'white-space',
  ]);

  const UNSAFE_CSS_VALUE_RE = /url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding|javascript:|data:|\\|\/\*|<|>|"|'/i;
  const SAFE_SVG_PAINT_RE = /^(?:none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/;
  const SAFE_SVG_NUM_RE = /^-?\d+(?:\.\d+)?(?:%|px|em|ex)?$/;

  function sanitizeInlineStyle(styleText) {
    if (!styleText || typeof styleText !== 'string') return '';
    const safeDecls = [];
    for (const part of styleText.split(';')) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      const prop = part.slice(0, idx).trim().toLowerCase();
      const val = part.slice(idx + 1).trim();
      if (!prop || !val || !ALLOWED_CSS_PROPS.has(prop)) continue;
      if (UNSAFE_CSS_VALUE_RE.test(val)) continue;
      if (prop === 'position' && !/^(?:relative|absolute|static)$/i.test(val)) continue;
      safeDecls.push(`${prop}:${val}`);
    }
    return safeDecls.join(';');
  }

  function sanitizeNodeInto(srcNode, targetParent, currentNs) {
    if (srcNode.nodeType === Node.TEXT_NODE) {
      targetParent.appendChild(document.createTextNode(srcNode.nodeValue || ''));
      return;
    }
    if (srcNode.nodeType !== Node.ELEMENT_NODE) return;

    const tag = srcNode.tagName.toLowerCase();
    let nextNs = currentNs;
    let outEl = null;

    if (tag === 'math' || (currentNs === MATHML_NS && ALLOWED_MATHML_TAGS.has(tag))) {
      nextNs = MATHML_NS;
      outEl = document.createElementNS(MATHML_NS, tag);
      for (const attr of Array.from(srcNode.attributes)) {
        const name = attr.name;
        if (ALLOWED_MATHML_ATTRS.has(name) && !/^on/i.test(name)) {
          outEl.setAttribute(name, attr.value);
        }
      }
    } else if (tag === 'svg' || (currentNs === SVG_NS && ALLOWED_SVG_TAGS.has(tag))) {
      nextNs = SVG_NS;
      outEl = document.createElementNS(SVG_NS, tag);
      for (const attr of Array.from(srcNode.attributes)) {
        const name = attr.name;
        if (!ALLOWED_SVG_ATTRS.has(name) || /^on/i.test(name)) continue;
        if (name === 'style') {
          const cleanStyle = sanitizeInlineStyle(attr.value);
          if (cleanStyle) outEl.setAttribute('style', cleanStyle);
          continue;
        }
        if ((name === 'fill' || name === 'stroke') && !SAFE_SVG_PAINT_RE.test(attr.value.trim())) {
          continue;
        }
        if ((name === 'cx' || name === 'cy' || name === 'r') && !SAFE_SVG_NUM_RE.test(attr.value.trim())) {
          continue;
        }
        if (name === 'transform' && /url\s*\(|javascript:/i.test(attr.value)) continue;
        outEl.setAttribute(name, attr.value);
      }
    } else if (ALLOWED_HTML_TAGS.has(tag)) {
      nextNs = null;
      outEl = document.createElement(tag);
      for (const attr of Array.from(srcNode.attributes)) {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_HTML_ATTRS.has(name) || name.startsWith('on')) continue;
        if (name === 'style') {
          const cleanStyle = sanitizeInlineStyle(attr.value);
          if (cleanStyle) outEl.setAttribute('style', cleanStyle);
        } else {
          outEl.setAttribute(name, attr.value);
        }
      }
    } else if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'iframe' ||
      tag === 'object' ||
      tag === 'embed' ||
      tag === 'foreignobject' ||
      tag === 'template'
    ) {
      // Drop dangerous subtrees completely
      return;
    } else {
      // Unwrap benign prose wrappers (e.g. a, li, mark) into their children
      for (const child of Array.from(srcNode.childNodes)) {
        sanitizeNodeInto(child, targetParent, currentNs);
      }
      return;
    }

    for (const child of Array.from(srcNode.childNodes)) {
      sanitizeNodeInto(child, outEl, nextNs);
    }
    targetParent.appendChild(outEl);
  }

  function sanitizeHtmlToFragment(rawHtml) {
    const frag = document.createDocumentFragment();
    if (!rawHtml || typeof rawHtml !== 'string') return frag;
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');
    for (const child of Array.from(doc.body.childNodes)) {
      sanitizeNodeInto(child, frag, null);
    }
    return frag;
  }

  function sanitizeHtmlString(rawHtml) {
    const frag = sanitizeHtmlToFragment(rawHtml);
    const holder = document.createElement('div');
    holder.appendChild(frag);
    return holder.innerHTML;
  }

  /* ========================================================================
     2. Accessible Clipboard Helper (copy-button guidance)
     Never disables buttons during feedback; appends \u00A0 on repeat for VoiceOver.
     ======================================================================== */

  let lastCopyStatusMessage = '';
  const copyStatusTimers = new WeakMap();

  function legacyCopyText(text) {
    const field = Object.assign(document.createElement('textarea'), { value: text });
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
    document.body.append(field);
    field.select();
    try {
      return document.execCommand('copy');
    } finally {
      field.remove();
    }
  }

  function showStatusMessage(statusEl, message, isError = false, durationMs = 2400) {
    if (!statusEl) return;
    clearTimeout(copyStatusTimers.get(statusEl));
    let msg = message;
    if (msg === lastCopyStatusMessage) msg += '\u00A0';
    lastCopyStatusMessage = msg;

    statusEl.classList.toggle('is-error', isError);
    statusEl.classList.add('is-visible');
    statusEl.textContent = '';
    requestAnimationFrame(() => {
      statusEl.textContent = msg;
    });
    copyStatusTimers.set(
      statusEl,
      setTimeout(() => {
        statusEl.classList.remove('is-visible', 'is-error');
        statusEl.textContent = '';
      }, durationMs)
    );
  }

  async function copyTextWithFeedback(text, statusEl, okLabel = '已复制', failLabel = '复制失败') {
    let ok = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopyText(text);
      }
    } catch {
      try {
        ok = legacyCopyText(text);
      } catch {
        ok = false;
      }
    }

    showStatusMessage(statusEl, ok ? okLabel : failLabel, !ok, 2400);
    return ok;
  }

  /* ========================================================================
     3. Smart KaTeX Text & Sanitized HTML Extractor
     ======================================================================== */

  function extractPlainWithLatexFromNode(rootEl) {
    const clone = rootEl.cloneNode(true);
    for (const junk of clone.querySelectorAll('.heading-anchor, .sr-only, script, style')) {
      junk.remove();
    }

    // Replace display math first so inner .katex isn't double-processed
    for (const disp of clone.querySelectorAll('.katex-display')) {
      const ann = disp.querySelector('annotation[encoding="application/x-tex"]');
      const tex = ann?.textContent?.trim();
      if (tex) {
        disp.replaceWith(document.createTextNode(`\n$$${tex}$$\n`));
      }
    }

    for (const inline of clone.querySelectorAll('.katex')) {
      const ann = inline.querySelector('annotation[encoding="application/x-tex"]');
      const tex = ann?.textContent?.trim();
      if (tex) {
        inline.replaceWith(document.createTextNode(`$${tex}$`));
      } else {
        const mathml = inline.querySelector('.katex-mathml');
        if (mathml) mathml.remove();
      }
    }

    // Preserve line breaks and table cell boundaries before reading textContent
    for (const br of clone.querySelectorAll('br')) {
      br.replaceWith(document.createTextNode('\n'));
    }
    for (const cell of clone.querySelectorAll('td, th')) {
      if (cell.nextElementSibling) {
        cell.after(document.createTextNode(' | '));
      }
    }
    for (const row of clone.querySelectorAll('tr, p, li, h2, h3, h4')) {
      if (row.nextElementSibling) {
        row.after(document.createTextNode('\n'));
      }
    }

    return (clone.textContent || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function extractPlainWithLatexFromHtml(htmlStr) {
    if (!htmlStr) return '';
    const holder = document.createElement('div');
    holder.appendChild(sanitizeHtmlToFragment(htmlStr));
    return extractPlainWithLatexFromNode(holder);
  }

  function findNearestPrecedingHeading(articleEl, targetNode) {
    const headings = Array.from(
      articleEl.querySelectorAll('h2[id], h3[id], h4[id]')
    );
    let found = null;
    for (const h of headings) {
      if (h === targetNode || h.contains(targetNode)) {
        found = h;
        break;
      }
      const rel = h.compareDocumentPosition(targetNode);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
        found = h;
      } else {
        break;
      }
    }
    if (!found) return { headingId: '', headingText: '' };
    const clone = found.cloneNode(true);
    for (const anchor of clone.querySelectorAll('.heading-anchor, .sr-only')) {
      anchor.remove();
    }
    return {
      headingId: found.id || '',
      headingText: (clone.textContent || '').trim(),
    };
  }

  function extractSelectionSnapshot(rawRange, articleEl) {
    if (!rawRange || rawRange.collapsed || !articleEl) return null;

    // Clone and clip end to articleEl to support triple-click spillover (copy-button guide)
    const range = rawRange.cloneRange();
    if (!articleEl.contains(range.startContainer)) return null;
    if (!articleEl.contains(range.endContainer)) {
      range.setEnd(articleEl, articleEl.childNodes.length);
      if (range.toString().trim() !== rawRange.toString().trim()) {
        return null;
      }
    }

    // Ignore selections starting inside interactive controls or disclosure summaries
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    if (
      !startEl ||
      startEl.closest('input, textarea, button, summary, .heading-anchor, [popover], dialog')
    ) {
      return null;
    }

    // Expand boundaries if selection starts or ends mid-formula inside .katex
    const startKatex = startEl.closest('.katex-display') || startEl.closest('.katex');
    if (startKatex && articleEl.contains(startKatex)) {
      range.setStartBefore(startKatex);
    }
    const endEl =
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement;
    const endKatex = endEl?.closest('.katex-display') || endEl?.closest('.katex');
    if (endKatex && articleEl.contains(endKatex)) {
      range.setEndAfter(endKatex);
    }

    const holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    for (const junk of holder.querySelectorAll('.heading-anchor, .sr-only')) {
      junk.remove();
    }

    const quoteText = extractPlainWithLatexFromNode(holder);
    if (!quoteText || quoteText.length < 2) return null;

    const quoteHtml = sanitizeHtmlString(holder.innerHTML);
    const { headingId, headingText } = findNearestPrecedingHeading(
      articleEl,
      range.startContainer
    );

    const rect = range.getBoundingClientRect();
    return {
      quoteText: quoteText.slice(0, 8000),
      // Never slice raw HTML mid-tag (corrupts large KaTeX matrices); drop to '' so quoteText renders cleanly
      quoteHtml: quoteHtml.length <= 48000 ? quoteHtml : '',
      headingId,
      headingText,
      rect,
    };
  }

  /* ========================================================================
     4. Local Notes Store & Deterministic LWW Merge (matching Worker #97/#98)
     ======================================================================== */

  function generateNoteId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `n-${crypto.randomUUID()}`;
    }
    return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeTag(tag) {
    return VALID_TAGS.includes(tag) ? tag : '摘录';
  }

  function normalizeNote(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id) return null;
    const createdAt = Number(raw.createdAt) || Date.now();
    const updatedAt = Number(raw.updatedAt) || createdAt;
    const deletedAt =
      raw.deletedAt !== null && raw.deletedAt !== undefined && Number(raw.deletedAt) > 0
        ? Number(raw.deletedAt)
        : null;
    const rawHtml = String(raw.quoteHtml || '');
    return {
      id: String(raw.id).slice(0, 128),
      pageSlug: String(raw.pageSlug || '').slice(0, 120),
      pageTitle: String(raw.pageTitle || '').slice(0, 200),
      headingId: String(raw.headingId || '').slice(0, 120),
      headingText: String(raw.headingText || '').slice(0, 200),
      quoteText: String(raw.quoteText || '').slice(0, 8000),
      // Match Worker 65536 cap; never truncate mid-HTML tag
      quoteHtml: rawHtml.length <= 65536 ? rawHtml : '',
      note: String(raw.note || '').slice(0, 8000),
      tag: normalizeTag(raw.tag),
      conceptId: String(raw.conceptId || '').slice(0, 100),
      createdAt,
      updatedAt,
      deletedAt,
    };
  }

  function getAllNotesRaw() {
    const raw = app.readStorageJson(NB_STORAGE.notes, []);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const n = normalizeNote(item);
      if (n) out.push(n);
    }
    return out;
  }

  function getActiveNotes() {
    return getAllNotesRaw()
      .filter((n) => !n.deletedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function saveAllNotesRaw(notes) {
    const list = notes.slice(0, MAX_NOTES);
    app.writeStorageJson(NB_STORAGE.notes, list);
  }

  function mergeNotesLists(localList, remoteList) {
    const byId = new Map();
    const ingest = (item) => {
      const n = normalizeNote(item);
      if (!n) return;
      const existing = byId.get(n.id);
      if (!existing) {
        byId.set(n.id, n);
        return;
      }
      const existingVer = Math.max(existing.updatedAt, existing.deletedAt || 0);
      const nextVer = Math.max(n.updatedAt, n.deletedAt || 0);
      if (nextVer > existingVer) {
        byId.set(n.id, n);
      } else if (nextVer === existingVer && n.deletedAt && !existing.deletedAt) {
        byId.set(n.id, n);
      }
    };
    for (const item of localList || []) ingest(item);
    for (const item of remoteList || []) ingest(item);

    const merged = Array.from(byId.values());
    if (merged.length > MAX_NOTES) {
      // Prune oldest tombstones first, then oldest notes
      merged.sort((a, b) => {
        const aDel = a.deletedAt ? 1 : 0;
        const bDel = b.deletedAt ? 1 : 0;
        if (aDel !== bDel) return aDel - bDel; // keep active before deleted
        return b.updatedAt - a.updatedAt;
      });
      return merged.slice(0, MAX_NOTES);
    }
    return merged;
  }

  function mergeProgressStates(local, remote) {
    const a = local || {};
    const b = remote || {};
    const resetAt = Math.max(Number(a.resetAt) || 0, Number(b.resetAt) || 0);

    // Merge readPages & readTombstones honoring resetAt ceiling
    const slugs = new Set([
      ...Object.keys(a.readPages || {}),
      ...Object.keys(b.readPages || {}),
      ...Object.keys(a.readTombstones || {}),
      ...Object.keys(b.readTombstones || {}),
    ]);
    const readPages = {};
    const readTombstones = {};
    for (const slug of slugs) {
      const readTs = Math.max(
        Number(a.readPages?.[slug]) || 0,
        Number(b.readPages?.[slug]) || 0
      );
      const tombTs = Math.max(
        Number(a.readTombstones?.[slug]) || 0,
        Number(b.readTombstones?.[slug]) || 0
      );
      if (readTs > Math.max(resetAt, tombTs)) {
        readPages[slug] = readTs;
      } else if (tombTs > resetAt) {
        readTombstones[slug] = tombTs;
      }
    }

    // Merge scrollPositions LWW honoring resetAt
    const scrollPositions = {};
    const scrollSlugs = new Set([
      ...Object.keys(a.scrollPositions || {}),
      ...Object.keys(b.scrollPositions || {}),
    ]);
    for (const slug of scrollSlugs) {
      const sa = a.scrollPositions?.[slug];
      const sb = b.scrollPositions?.[slug];
      const ta = Number(sa?.updatedAt) || 0;
      const tb = Number(sb?.updatedAt) || 0;
      const winner = tb > ta ? sb : sa;
      const wt = Math.max(ta, tb);
      if (winner && wt > resetAt) {
        scrollPositions[slug] = winner;
      }
    }

    // Merge lastVisited LWW honoring resetAt
    const la = a.lastVisited;
    const lb = b.lastVisited;
    const lta = Number(la?.timestamp) || 0;
    const ltb = Number(lb?.timestamp) || 0;
    const lastWinner = ltb > lta ? lb : la;
    const lastVisited = lastWinner && Math.max(lta, ltb) > resetAt ? lastWinner : null;

    // Merge priorityMode LWW (preserved across resetAt)
    const pa = a.priorityMode || { value: 'all', updatedAt: 0 };
    const pb = b.priorityMode || { value: 'all', updatedAt: 0 };
    const priorityMode =
      (Number(pb.updatedAt) || 0) > (Number(pa.updatedAt) || 0) ? pb : pa;

    // Merge readingStyle LWW (preserved across resetAt, matching Worker merge.mjs)
    const defStyle = app.defaultReadingStyle || 'explained';
    const ra = a.readingStyle || { value: defStyle, updatedAt: 0 };
    const rb = b.readingStyle || { value: defStyle, updatedAt: 0 };
    const readingStyle =
      (Number(rb.updatedAt) || 0) > (Number(ra.updatedAt) || 0) ? rb : ra;

    // Merge fontTheme LWW (preserved across resetAt, matching Worker merge.mjs)
    const defFont = app.defaultFontTheme || 'serif';
    const fa = a.fontTheme || { value: defFont, updatedAt: 0 };
    const fb = b.fontTheme || { value: defFont, updatedAt: 0 };
    const fontTheme =
      (Number(fb.updatedAt) || 0) > (Number(fa.updatedAt) || 0) ? fb : fa;

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

  /* ========================================================================
     5. Notebook Badges, Markdown Export & Undo State
     ======================================================================== */

  let lastDeletedNoteId = null;

  function formatLocalDate(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function updateNotebookBadges() {
    const count = getActiveNotes().length;
    const label = count > 0 ? `打开我的笔记本（共 ${count} 条）` : '打开我的笔记本';
    for (const el of document.querySelectorAll('[data-notebook-count]')) {
      el.textContent = String(count);
      if (el.classList.contains('icon-badge') || el.closest('.sidebar-tool-btn')) {
        el.hidden = count === 0;
      }
    }
    for (const btn of document.querySelectorAll('[data-open-notebook]')) {
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
    updateSyncLocalStats();
  }

  function buildMarkdownExport(notes) {
    const nowStr = formatLocalDate();
    const lines = [
      `# ${exportPrefix} · 我的复习笔记本`,
      ``,
      `> 导出日期：${nowStr} · 共 ${notes.length} 条笔记`,
      ``,
    ];

    const byPage = new Map();
    for (const n of notes) {
      const key = n.pageTitle || (n.pageSlug ? n.pageSlug : '通用笔记');
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key).push(n);
    }

    for (const [pageLabel, items] of byPage.entries()) {
      lines.push(`## ${pageLabel}`, ``);
      for (const n of items) {
        const headingPart = n.headingText ? ` · ${n.headingText}` : '';
        lines.push(`### [${n.tag}]${headingPart}`, ``);
        if (n.quoteText) {
          const quoted = n.quoteText
            .split('\n')
            .map((line) => (line.trim() ? `> ${line}` : '>'))
            .join('\n');
          lines.push(quoted, ``);
        }
        if (n.note) {
          const formattedNote = n.note.replace(/\r\n?/g, '\n').replace(/\n/g, '  \n');
          lines.push(`**批注**：${formattedNote}`, ``);
        }
      }
    }
    return lines.join('\n').trim() + '\n';
  }

  function triggerFileDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ========================================================================
     6. Cloud Sync Engine (Cloudflare Workers + D1, Passphrase-Based)
     ======================================================================== */

  let syncState = 'idle'; // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  let syncStatusDetail = '';
  let syncDirty = false;
  let localMutationSeq = 0;
  let syncDebounceTimer = null;
  let syncInFlight = false;
  let maskCodeVisible = false;

  function getSyncCode() {
    try {
      const raw = localStorage.getItem(NB_STORAGE.syncCode);
      return raw ? raw.trim() : '';
    } catch {
      return '';
    }
  }

  function setSyncCode(code) {
    try {
      const clean = String(code || '').trim();
      if (clean) {
        localStorage.setItem(NB_STORAGE.syncCode, clean);
      } else {
        localStorage.removeItem(NB_STORAGE.syncCode);
      }
    } catch {
      // Ignore storage errors.
    }
  }

  function getSyncMeta() {
    return app.readStorageJson(NB_STORAGE.syncMeta, { revision: 0, lastSyncedAt: 0 });
  }

  function setSyncMeta(meta) {
    app.writeStorageJson(NB_STORAGE.syncMeta, meta);
  }

  function generatePassphrase() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(12);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
    return `sync-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
  }

  function maskPassphrase(code) {
    if (!code) return '';
    if (code.length <= 6) return '••••••';
    return `${code.slice(0, 4)}••••${code.slice(-4)}`;
  }

  function updateSyncLocalStats() {
    const statsEl = document.getElementById('sync-local-stats');
    if (!statsEl) return;
    const readCount = Object.keys(app.getProgressState().readPages || {}).length;
    const noteCount = getActiveNotes().length;
    statsEl.textContent = `已读 ${readCount} 节 · 笔记 ${noteCount} 条`;
  }

  function renderSyncUI() {
    const code = getSyncCode();
    const meta = getSyncMeta();
    const effectiveState = code ? syncState : 'idle';

    for (const dot of document.querySelectorAll('[data-sync-dot]')) {
      dot.dataset.syncState = effectiveState;
    }

    const syncAriaSuffix = !code
      ? '未绑定'
      : effectiveState === 'syncing'
        ? '正在同步…'
        : effectiveState === 'synced'
          ? '已同步'
          : effectiveState === 'offline'
            ? '离线仅存本机'
            : effectiveState === 'error'
              ? '同步异常'
              : '已绑定';
    const syncBtnLabel = `云端同步设置（${syncAriaSuffix}）`;
    for (const btn of document.querySelectorAll('[data-open-sync]')) {
      btn.setAttribute('aria-label', syncBtnLabel);
      btn.setAttribute('title', syncBtnLabel);
    }

    const statusTextEl = document.getElementById('sync-status-text');
    if (statusTextEl) {
      if (!code) {
        statusTextEl.textContent = '未绑定同步码（仅本机存储）';
      } else if (syncState === 'syncing') {
        statusTextEl.textContent = '正在与云端合并同步…';
      } else if (syncState === 'synced') {
        const rel = meta.lastSyncedAt ? app.formatRelativeTime(meta.lastSyncedAt) : '刚刚';
        statusTextEl.textContent = `已云端同步 · ${rel.replace('刚刚阅读', '刚刚')}`;
      } else if (syncState === 'offline') {
        statusTextEl.textContent =
          syncStatusDetail || '当前为离线/纯静态环境，改动已保存在本机';
      } else if (syncState === 'error') {
        statusTextEl.textContent = syncStatusDetail || '同步暂不可用，数据已保存在本机';
      } else {
        statusTextEl.textContent = '已绑定同步码';
      }
    }

    const boundSection = document.getElementById('sync-bound-section');
    const codeDisplay = document.getElementById('sync-code-display');
    const toggleMaskBtn = document.getElementById('sync-toggle-mask');
    if (boundSection) boundSection.hidden = !code;
    if (codeDisplay) {
      codeDisplay.textContent = maskCodeVisible ? code : maskPassphrase(code);
    }
    if (toggleMaskBtn) {
      toggleMaskBtn.textContent = maskCodeVisible ? '隐藏' : '显示';
      toggleMaskBtn.setAttribute(
        'aria-label',
        maskCodeVisible ? '隐藏同步码明文' : '显示同步码明文'
      );
    }
    updateSyncLocalStats();
  }

  function buildSyncPayload() {
    return {
      clientTime: Date.now(),
      progress: app.getProgressState(),
      notes: getAllNotesRaw(),
    };
  }

  async function performSync({ announce = false, keepalive = false } = {}) {
    const code = getSyncCode();
    if (!code || code.length < 6) return { ok: false, reason: 'unbound' };
    if (window.location.protocol === 'file:') {
      syncState = 'offline';
      syncStatusDetail = '本地 file:// 模式（仅本机存储）';
      renderSyncUI();
      return { ok: false, reason: 'file-protocol' };
    }
    if (syncInFlight && !keepalive) return { ok: false, reason: 'busy' };

    const apiUrl = `${app.assetBase}api/sync`;
    const sentSeq = localMutationSeq;
    const bodyStr = JSON.stringify(buildSyncPayload());

    if (keepalive) {
      // keepalive requests have ~64 KiB browser limit
      if (new Blob([bodyStr]).size > 58000) return { ok: false, reason: 'too-large-keepalive' };
      try {
        fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sync-Code': encodeURIComponent(code),
            'X-Sync-Code-Encoding': 'uri',
          },
          body: bodyStr,
          keepalive: true,
        })
          .then((r) => {
            if (r.ok && localMutationSeq === sentSeq) {
              syncDirty = false;
            }
          })
          .catch(() => {});
      } catch {
        // Ignore flush failures on unload.
      }
      return { ok: true, keepalive: true };
    }

    syncInFlight = true;
    syncState = 'syncing';
    syncStatusDetail = '';
    renderSyncUI();
    let syncSucceeded = false;

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sync-Code': encodeURIComponent(code),
          'X-Sync-Code-Encoding': 'uri',
        },
        body: bodyStr,
      });

      if (res.status === 404 || res.status === 405) {
        syncState = 'offline';
        syncStatusDetail = '当前托管环境未启用云端同步 API（数据保存在本机）';
        renderSyncUI();
        return { ok: false, reason: 'unavailable' };
      }

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        syncState = 'error';
        syncStatusDetail = data?.message || `同步失败（HTTP ${res.status}）`;
        renderSyncUI();
        if (announce) app.showToast(syncStatusDetail, { autoHideMs: 3600 });
        return { ok: false, reason: 'server-error' };
      }

      // Apply merged state cleanly back to localStorage & live UI
      if (data.progress) {
        const mergedProg = mergeProgressStates(app.getProgressState(), data.progress);
        app.applyMergedProgress(mergedProg);
      }
      if (Array.isArray(data.notes)) {
        const mergedNotes = mergeNotesLists(getAllNotesRaw(), data.notes);
        saveAllNotesRaw(mergedNotes);
        updateNotebookBadges();
        renderNotebookList();
      }

      setSyncMeta({
        revision: Number(data.revision) || 0,
        lastSyncedAt: Date.now(),
      });
      syncSucceeded = true;
      if (localMutationSeq === sentSeq) {
        syncDirty = false;
      }
      syncState = 'synced';
      syncStatusDetail = '';
      renderSyncUI();

      if (announce) {
        app.showToast('云端同步完成', { autoHideMs: 2800 });
      }
      return { ok: true, data };
    } catch {
      syncState = 'offline';
      syncStatusDetail = '网络不可用，已保存在本机，联网后将自动同步';
      renderSyncUI();
      if (announce) app.showToast(syncStatusDetail, { autoHideMs: 3400 });
      return { ok: false, reason: 'network' };
    } finally {
      syncInFlight = false;
      if (syncSucceeded && syncDirty && localMutationSeq !== sentSeq && getSyncCode()) {
        scheduleSync(300, { isMutation: false });
      }
    }
  }

  function scheduleSync(delayMs = 800, { isMutation = true } = {}) {
    if (!getSyncCode()) return;
    if (isMutation) {
      localMutationSeq += 1;
    }
    syncDirty = true;
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      syncDebounceTimer = null;
      if (syncDirty) performSync({ announce: false });
    }, delayMs);
  }

  async function clearCloudSpace() {
    const code = getSyncCode();
    const actionStatusEl = document.getElementById('sync-action-status');
    if (!code) return;
    if (!window.confirm('确定要永久清空该同步码对应的云端数据吗？（不会删除当前设备的本地记录）')) {
      return;
    }
    try {
      const res = await fetch(`${app.assetBase}api/sync/clear`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sync-Code': encodeURIComponent(code),
          'X-Sync-Code-Encoding': 'uri',
        },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setSyncCode('');
        setSyncMeta({ revision: 0, lastSyncedAt: 0 });
        syncDirty = false;
        syncState = 'idle';
        syncStatusDetail = '';
        renderSyncUI();
        showStatusMessage(actionStatusEl, '已清空云端数据并解除本机绑定', false, 3600);
      } else {
        syncState = 'error';
        syncStatusDetail = data?.message || '清空云端数据失败';
        renderSyncUI();
        showStatusMessage(actionStatusEl, syncStatusDetail, true, 3600);
      }
    } catch {
      syncState = 'offline';
      syncStatusDetail = '当前离线，无法清空云端数据';
      renderSyncUI();
      showStatusMessage(actionStatusEl, syncStatusDetail, true, 3600);
    }
  }

  // Handle #sync=<encoded_code> auto-bind URL fragment (never query string!)
  function handleAutoBindHash() {
    const rawHash = window.location.hash || '';
    if (!/^#sync=/i.test(rawHash)) return false;
    let decoded = '';
    try {
      decoded = decodeURIComponent(rawHash.slice(6)).trim();
    } catch {
      decoded = rawHash.slice(6).trim();
    }
    // Strip immediately from URL bar & history
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // Ignore if restricted.
    }
    if (decoded.length >= 6 && decoded.length <= 128) {
      setSyncCode(decoded);
      renderSyncUI();
      performSync({ announce: false }).then((res) => {
        if (res.ok) {
          app.showToast('已通过链接自动绑定同步码并完成同步', { autoHideMs: 4000 });
        }
      });
      return true;
    }
    return false;
  }

  /* ========================================================================
     7. Notebook Drawer UI ("我的笔记本")
     ======================================================================== */

  const nbDrawer = document.getElementById('notebook-drawer');
  const nbCloseBtn = document.getElementById('notebook-close');
  const nbNewBtn = document.getElementById('nb-new-note-btn');
  const nbExportMdBtn = document.getElementById('nb-export-md');
  const nbCopyMdBtn = document.getElementById('nb-copy-md');
  const nbCopyStatus = document.getElementById('nb-copy-status');
  const nbSearchInput = document.getElementById('nb-search');
  const nbPageOnlyCheckbox = document.getElementById('nb-current-page-only');
  const nbTagFilters = document.getElementById('nb-tag-filters');
  const nbComposer = document.getElementById('nb-composer');
  const nbComposerTitle = document.getElementById('nb-composer-title');
  const nbComposerSource = document.getElementById('nb-composer-source');
  const nbQuotePreview = document.getElementById('nb-quote-preview');
  const nbQuoteInputWrap = document.getElementById('nb-quote-input-wrap');
  const nbComposerQuote = document.getElementById('nb-composer-quote');
  const nbComposerTags = document.getElementById('nb-composer-tags');
  const nbComposerNote = document.getElementById('nb-composer-note');
  const nbComposerCancel = document.getElementById('nb-composer-cancel');
  const nbListEl = document.getElementById('nb-list');
  const nbEmptyEl = document.getElementById('nb-empty');

  let nbFilterTag = '全部';
  let composerDraft = null; // { mode: 'new'|'highlight', pageSlug, pageTitle, headingId, headingText, quoteText, quoteHtml, tag, conceptId }
  let editingNoteId = null;

  function setComposerTagUI(tag) {
    if (!nbComposerTags) return;
    const normalized = normalizeTag(tag);
    for (const btn of nbComposerTags.querySelectorAll('[data-nb-composer-tag]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.nbComposerTag === normalized));
    }
  }

  function openNotebookDrawer() {
    if (!nbDrawer) return;
    document.dispatchEvent(new CustomEvent('notes:overlay-open', { detail: { source: 'notebook-drawer' } }));
    const tocDrawer = document.getElementById('toc-drawer');
    if (tocDrawer?.open) tocDrawer.close();
    const syncDialog = document.getElementById('sync-dialog');
    if (syncDialog?.open) syncDialog.close();

    nbDrawer.removeAttribute('data-closing');
    if (!nbDrawer.open) {
      nbDrawer.showModal();
    }
    renderNotebookList();
  }

  function openComposerWithDraft(draft) {
    composerDraft = {
      mode: draft.mode || 'new',
      pageSlug: draft.pageSlug ?? app.currentSlug ?? '',
      pageTitle:
        draft.pageTitle ??
        (document.body.dataset.pageTitle || (app.pageType === 'home' ? '课程总览' : '')),
      headingId: draft.headingId || '',
      headingText: draft.headingText || '',
      quoteText: draft.quoteText || '',
      quoteHtml: draft.quoteHtml || '',
      tag: normalizeTag(draft.tag || '摘录'),
      conceptId: draft.conceptId || '',
    };

    if (!nbComposer) return;
    nbComposerTitle.textContent =
      composerDraft.mode === 'highlight' ? '带批注收藏划词摘录' : '新建学习笔记';
    nbComposerSource.textContent = [composerDraft.pageTitle, composerDraft.headingText]
      .filter(Boolean)
      .join(' · ');

    if (composerDraft.quoteHtml || composerDraft.quoteText) {
      if (composerDraft.quoteHtml) {
        nbQuotePreview.replaceChildren(sanitizeHtmlToFragment(composerDraft.quoteHtml));
      } else {
        nbQuotePreview.textContent = composerDraft.quoteText;
      }
      nbQuotePreview.hidden = false;
      nbQuoteInputWrap.hidden = true;
      nbComposerQuote.value = '';
    } else {
      nbQuotePreview.replaceChildren();
      nbQuotePreview.hidden = true;
      nbQuoteInputWrap.hidden = false;
      nbComposerQuote.value = '';
    }

    setComposerTagUI(composerDraft.tag);
    nbComposerNote.value = draft.note || '';
    nbComposer.hidden = false;
    openNotebookDrawer();
    requestAnimationFrame(() => {
      (composerDraft.mode === 'highlight' ? nbComposerNote : nbComposerQuote || nbComposerNote)?.focus();
    });
  }

  function closeComposer() {
    composerDraft = null;
    if (nbComposer) nbComposer.hidden = true;
  }

  function createOrUpdateNote(fields) {
    const now = Date.now();
    const all = getAllNotesRaw();

    // Deduplicate concept bookmarks cleanly
    if (fields.conceptId) {
      const existing = all.find((n) => !n.deletedAt && n.conceptId === fields.conceptId);
      if (existing) {
        existing.updatedAt = now;
        if (fields.note && !existing.note) existing.note = fields.note;
        saveAllNotesRaw(all);
        updateNotebookBadges();
        renderNotebookList();
        scheduleSync(500);
        return { note: existing, deduplicated: true };
      }
    }

    const newNote = normalizeNote({
      id: generateNoteId(),
      pageSlug: fields.pageSlug || '',
      pageTitle: fields.pageTitle || '',
      headingId: fields.headingId || '',
      headingText: fields.headingText || '',
      quoteText: fields.quoteText || '',
      quoteHtml: fields.quoteHtml || '',
      note: fields.note || '',
      tag: normalizeTag(fields.tag || '摘录'),
      conceptId: fields.conceptId || '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    all.unshift(newNote);
    saveAllNotesRaw(all);
    updateNotebookBadges();
    renderNotebookList();
    scheduleSync(500);
    return { note: newNote, deduplicated: false };
  }

  function softDeleteNote(noteId) {
    const all = getAllNotesRaw();
    const target = all.find((n) => n.id === noteId);
    if (!target || target.deletedAt) return;
    const now = Date.now();
    target.deletedAt = now;
    target.updatedAt = now;
    lastDeletedNoteId = noteId;
    saveAllNotesRaw(all);
    updateNotebookBadges();
    renderNotebookList();
    scheduleSync(600);
  }

  function undoDeleteNote() {
    if (!lastDeletedNoteId) return;
    const all = getAllNotesRaw();
    const target = all.find((n) => n.id === lastDeletedNoteId);
    if (target) {
      target.deletedAt = null;
      target.updatedAt = Date.now();
      saveAllNotesRaw(all);
    }
    lastDeletedNoteId = null;
    updateNotebookBadges();
    renderNotebookList();
    scheduleSync(500);
  }

  function renderNotebookList() {
    if (!nbListEl || !nbEmptyEl) return;

    const query = nbSearchInput ? nbSearchInput.value.trim().toLowerCase() : '';
    const onlyCurrentPage = Boolean(nbPageOnlyCheckbox?.checked && app.currentSlug);
    const active = getActiveNotes();

    const filtered = active.filter((n) => {
      if (onlyCurrentPage && n.pageSlug !== app.currentSlug) return false;
      if (nbFilterTag !== '全部' && n.tag !== nbFilterTag) return false;
      if (query) {
        const hay = `${n.quoteText} ${n.note} ${n.pageTitle} ${n.headingText} ${n.tag}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    const frag = document.createDocumentFragment();

    // Accessible inline Undo banner inside open modal drawer (per persistent-toast-notifications)
    if (lastDeletedNoteId) {
      const undoBar = document.createElement('div');
      undoBar.className = 'sync-status-card';
      undoBar.setAttribute('role', 'status');
      const msg = document.createElement('span');
      msg.textContent = '已删除 1 条笔记';
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'btn btn-primary btn-sm';
      undoBtn.textContent = '撤销删除';
      undoBtn.addEventListener('click', undoDeleteNote);
      undoBar.append(msg, undoBtn);
      frag.appendChild(undoBar);
    }

    for (const n of filtered) {
      const card = document.createElement('article');
      card.className = 'nb-card';
      card.dataset.noteId = n.id;

      // Top metadata row (tag + clickable source link)
      const top = document.createElement('div');
      top.className = 'nb-card-top';
      const meta = document.createElement('div');
      meta.className = 'nb-card-meta';

      const tagChip = document.createElement('span');
      tagChip.className = 'nb-tag-chip';
      tagChip.dataset.tag = n.tag;
      tagChip.textContent = n.tag;
      meta.appendChild(tagChip);

      if (n.pageSlug) {
        const srcLink = document.createElement('a');
        srcLink.className = 'nb-source-link';
        const hashPart = n.headingId ? `#${encodeURIComponent(n.headingId)}` : '';
        srcLink.href = `${app.pageBase}${encodeURIComponent(n.pageSlug)}.html${hashPart}`;
        srcLink.textContent = n.headingText
          ? `${n.pageTitle || n.pageSlug} · ${n.headingText}`
          : n.pageTitle || n.pageSlug;
        srcLink.addEventListener('click', async (event) => {
          if (n.pageSlug === app.currentSlug) {
            event.preventDefault();
            await app.closeDialogAnimated(nbDrawer);
            await app.jumpToArticleHeading?.({
              headingId: n.headingId || '',
              headingText: n.headingText || '',
            });
            return;
          }
          // Plain left-click cross-page jump: store short-lived intent so target page
          // verifies headingText across dual reading modes instead of hitting #sec-N collisions
          if (
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.button === 0 &&
            (n.headingId || n.headingText)
          ) {
            try {
              sessionStorage.setItem(
                app.storageKeys?.jumpIntent || `${storagePrefix}:jumpIntent`,
                JSON.stringify({
                  slug: n.pageSlug,
                  headingId: n.headingId || '',
                  headingText: n.headingText || '',
                  ts: Date.now(),
                })
              );
            } catch {
              // Ignore restricted sessionStorage; href #hash still navigates normally.
            }
          }
        });
        meta.appendChild(srcLink);
      } else if (n.pageTitle) {
        const srcSpan = document.createElement('span');
        srcSpan.className = 'nb-source-link';
        srcSpan.textContent = n.pageTitle;
        meta.appendChild(srcSpan);
      }

      top.appendChild(meta);
      card.appendChild(top);

      // Quote block (sanitized KaTeX DOM via replaceChildren — zero innerHTML)
      if (n.quoteHtml || n.quoteText) {
        const quoteBox = document.createElement('div');
        quoteBox.className = 'nb-note-quote';
        if (n.quoteHtml) {
          quoteBox.replaceChildren(sanitizeHtmlToFragment(n.quoteHtml));
        } else {
          quoteBox.textContent = n.quoteText;
        }
        card.appendChild(quoteBox);
      }

      // Inline editor OR display mode
      if (editingNoteId === n.id) {
        let editTag = n.tag;
        const editWrap = document.createElement('div');
        editWrap.className = 'sync-section';

        const tagRow = document.createElement('div');
        tagRow.className = 'nb-tag-filters';
        tagRow.setAttribute('role', 'group');
        tagRow.setAttribute('aria-label', '修改笔记标签');
        for (const t of VALID_TAGS) {
          const tb = document.createElement('button');
          tb.type = 'button';
          tb.className = 'nb-tag-pill';
          tb.textContent = t;
          tb.setAttribute('aria-pressed', String(t === editTag));
          tb.addEventListener('click', () => {
            editTag = t;
            for (const sib of tagRow.querySelectorAll('.nb-tag-pill')) {
              sib.setAttribute('aria-pressed', String(sib.textContent === editTag));
            }
          });
          tagRow.appendChild(tb);
        }

        const ta = document.createElement('textarea');
        ta.className = 'nb-textarea';
        ta.rows = 3;
        ta.value = n.note || '';
        ta.placeholder = '输入个人批注…';
        ta.setAttribute('aria-label', '编辑个人批注');

        const btnRow = document.createElement('div');
        btnRow.className = 'nb-composer-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-ghost btn-sm';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => {
          editingNoteId = null;
          renderNotebookList();
        });

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = '保存修改';
        saveBtn.addEventListener('click', () => {
          const all = getAllNotesRaw();
          const item = all.find((x) => x.id === n.id);
          if (item) {
            item.note = ta.value.trim();
            item.tag = normalizeTag(editTag);
            item.updatedAt = Date.now();
            saveAllNotesRaw(all);
            scheduleSync(500);
          }
          editingNoteId = null;
          renderNotebookList();
        });

        btnRow.append(cancelBtn, saveBtn);
        editWrap.append(tagRow, ta, btnRow);
        card.appendChild(editWrap);
      } else {
        if (n.note) {
          const noteP = document.createElement('p');
          noteP.className = 'nb-card-note';
          noteP.textContent = n.note;
          card.appendChild(noteP);
        }

        const footer = document.createElement('div');
        footer.className = 'nb-card-footer';
        const timeSpan = document.createElement('span');
        timeSpan.textContent = app.formatRelativeTime(n.updatedAt).replace('刚刚阅读', '刚刚');

        const actions = document.createElement('div');
        actions.className = 'nb-card-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-ghost btn-sm';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', () => {
          editingNoteId = n.id;
          renderNotebookList();
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-ghost btn-sm';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => softDeleteNote(n.id));

        actions.append(editBtn, delBtn);
        footer.append(timeSpan, actions);
        card.appendChild(footer);
      }

      frag.appendChild(card);
    }

    nbListEl.replaceChildren(frag);
    nbEmptyEl.hidden = filtered.length > 0;
    if (filtered.length === 0) {
      const emptyTitle = document.getElementById('nb-empty-title');
      const emptyDesc = document.getElementById('nb-empty-desc');
      if (emptyTitle && emptyDesc) {
        const strong = document.createElement('strong');
        if (active.length > 0) {
          strong.textContent = '当前筛选下暂无匹配笔记';
          emptyTitle.replaceChildren(strong);
          emptyDesc.textContent =
            '可尝试切换上方分类标签、取消勾选「仅看本页」或清空搜索关键词。';
        } else {
          strong.textContent = '笔记本还是空的';
          emptyTitle.replaceChildren(strong);
          emptyDesc.textContent =
            '在讲义正文中选中任意文字或数学公式即可一键「加入笔记本」，也可以在概念弹窗点击「＋ 收藏笔记」或上方手动新建。';
        }
      }
    }
  }

  function initNotebookUI() {
    if (!nbDrawer) return;
    app.bindClosedByFallback(nbDrawer);

    nbDrawer.addEventListener('cancel', (event) => {
      if (event.cancelable && !app.supportsTopLayerExit?.()) {
        event.preventDefault();
        app.closeDialogAnimated(nbDrawer);
      }
    });

    nbDrawer.addEventListener('close', () => {
      lastDeletedNoteId = null;
      editingNoteId = null;
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-notebook]')) {
        openNotebookDrawer();
      }
    });

    if (nbCloseBtn) {
      nbCloseBtn.addEventListener('click', () => app.closeDialogAnimated(nbDrawer));
    }

    if (nbNewBtn) {
      nbNewBtn.addEventListener('click', () => {
        openComposerWithDraft({ mode: 'new', tag: '摘录' });
      });
    }

    if (nbComposerTags) {
      nbComposerTags.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-nb-composer-tag]');
        if (!btn || !composerDraft) return;
        composerDraft.tag = normalizeTag(btn.dataset.nbComposerTag);
        setComposerTagUI(composerDraft.tag);
      });
    }

    if (nbComposerCancel) {
      nbComposerCancel.addEventListener('click', closeComposer);
    }

    if (nbComposer) {
      nbComposer.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!composerDraft) return;
        const manualQuote = nbComposerQuote ? nbComposerQuote.value.trim() : '';
        const noteText = nbComposerNote ? nbComposerNote.value.trim() : '';
        const finalQuoteText = composerDraft.quoteText || manualQuote;
        if (!finalQuoteText && !noteText) {
          nbComposerNote?.focus();
          return;
        }
        createOrUpdateNote({
          ...composerDraft,
          quoteText: finalQuoteText,
          note: noteText,
        });
        closeComposer();
      });
    }

    if (nbSearchInput) {
      nbSearchInput.addEventListener('input', renderNotebookList);
    }
    if (nbPageOnlyCheckbox) {
      nbPageOnlyCheckbox.addEventListener('change', renderNotebookList);
    }
    if (nbTagFilters) {
      nbTagFilters.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-nb-tag-filter]');
        if (!btn) return;
        nbFilterTag = btn.dataset.nbTagFilter || '全部';
        for (const b of nbTagFilters.querySelectorAll('[data-nb-tag-filter]')) {
          b.setAttribute('aria-pressed', String(b.dataset.nbTagFilter === nbFilterTag));
        }
        renderNotebookList();
      });
    }

    if (nbExportMdBtn) {
      nbExportMdBtn.addEventListener('click', () => {
        const notes = getActiveNotes();
        if (notes.length === 0) {
          showStatusMessage(nbCopyStatus, '暂无笔记可导出', true);
          return;
        }
        const md = buildMarkdownExport(notes);
        const date = formatLocalDate();
        triggerFileDownload(`${exportPrefix}-我的笔记-${date}.md`, md, 'text/markdown;charset=utf-8');
        showStatusMessage(nbCopyStatus, `已导出全部 ${notes.length} 条笔记 (.md)`, false);
      });
    }

    if (nbCopyMdBtn) {
      nbCopyMdBtn.addEventListener('click', () => {
        const notes = getActiveNotes();
        if (notes.length === 0) {
          showStatusMessage(nbCopyStatus, '暂无笔记可复制', true);
          return;
        }
        copyTextWithFeedback(
          buildMarkdownExport(notes),
          nbCopyStatus,
          `已复制全部 ${notes.length} 条 Markdown 笔记`,
          '复制失败'
        );
      });
    }

    // Concept Recall Card "＋ 收藏笔记" button (#recall-save-note)
    const recallSaveBtn = document.getElementById('recall-save-note');
    if (recallSaveBtn) {
      recallSaveBtn.addEventListener('click', () => {
        const concept = app.getActiveConcept?.();
        if (!concept) return;
        const briefPlain = extractPlainWithLatexFromHtml(concept.briefHtml || '');
        const formulaPlain = extractPlainWithLatexFromHtml(concept.formulaHtml || '');
        const quoteText = [
          `【${concept.term}】${briefPlain}`,
          formulaPlain,
        ]
          .filter(Boolean)
          .join('\n\n');
        const safeTerm = String(concept.term || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const rawHtml = `<strong>${safeTerm}</strong>：${concept.briefHtml || ''}${concept.formulaHtml ? `<div>${concept.formulaHtml}</div>` : ''}`;
        const res = createOrUpdateNote({
          pageSlug: concept.targetPage || app.currentSlug || '',
          pageTitle: concept.targetPageTitle || concept.category || '',
          headingId: '',
          headingText: concept.category || '',
          quoteText,
          quoteHtml: sanitizeHtmlString(rawHtml),
          note: '',
          tag: '概念',
          conceptId: concept.id || '',
        });
        app.hideRecallPopover?.();
        app.showToast(
          res.deduplicated
            ? `概念「${concept.term}」已在笔记本中，已置顶`
            : `已收藏概念「${concept.term}」到笔记本`,
          {
            actionLabel: '查看笔记',
            onAction: openNotebookDrawer,
            autoHideMs: 4200,
          }
        );
      });
    }
  }

  /* ========================================================================
     8. Highlight-to-Notebook Selection Action Bar (#selection-toolbar)
     ======================================================================== */

  function initSelectionCapture() {
    const articleEl = document.getElementById('article-body');
    const toolbar = document.getElementById('selection-toolbar');
    if (!articleEl || !toolbar) return;

    const quickSaveBtn = document.getElementById('sel-quick-save');
    const annotateBtn = document.getElementById('sel-annotate-save');
    const dismissBtn = document.getElementById('sel-dismiss');

    let pendingSelection = null;
    let isDraggingSelection = false;
    let toolbarPressInProgress = false;
    let selectionTimer = null;

    function isToolbarOpen() {
      return app.hasNativePopover
        ? toolbar.matches(':popover-open')
        : toolbar.classList.contains(':popover-open');
    }

    function hideToolbar() {
      pendingSelection = null;
      if (isToolbarOpen()) {
        app.hidePopoverAnimated(toolbar);
      }
    }

    function positionToolbar(rect) {
      const dockBottom = narrowMql.matches || !finePointerMql.matches;
      if (dockBottom) {
        toolbar.style.top = '';
        toolbar.style.left = '';
        return;
      }
      const tbRect = toolbar.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 10;
      const margin = 12;

      let top = rect.top - tbRect.height - gap;
      if (top < 60) {
        top = rect.bottom + gap;
      }
      top = Math.max(margin, Math.min(top, vh - tbRect.height - margin));

      let left = rect.left + rect.width / 2 - tbRect.width / 2;
      left = Math.max(margin, Math.min(left, vw - tbRect.width - margin));

      toolbar.style.top = `${Math.round(top)}px`;
      toolbar.style.left = `${Math.round(left)}px`;
    }

    function evaluateSelection() {
      if (isDraggingSelection || toolbarPressInProgress) return;
      if (document.querySelector('dialog[open]') || app.isRecallPopoverOpen?.()) {
        hideToolbar();
        return;
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (!toolbar.matches(':focus-within')) {
          hideToolbar();
        }
        return;
      }

      const snapshot = extractSelectionSnapshot(sel.getRangeAt(0), articleEl);
      if (!snapshot) {
        hideToolbar();
        return;
      }

      // Prevent bottom-docked collision with #reading-toast on mobile / touch
      if (narrowMql.matches || !finePointerMql.matches) {
        app.dismissToast?.();
      }

      pendingSelection = snapshot;
      toolbar.removeAttribute('data-closing');
      if (app.hasNativePopover) {
        try {
          if (!toolbar.matches(':popover-open')) {
            toolbar.showPopover();
          }
        } catch {
          // Ignore if already open.
        }
      } else {
        toolbar.classList.add(':popover-open');
      }
      positionToolbar(snapshot.rect);
    }

    document.addEventListener('notes:overlay-open', hideToolbar);

    function scheduleEvaluation(delay = 140) {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(evaluateSelection, delay);
    }

    articleEl.addEventListener('pointerdown', () => {
      isDraggingSelection = true;
    });

    document.addEventListener('pointerup', () => {
      if (isDraggingSelection) {
        isDraggingSelection = false;
        scheduleEvaluation(40);
      }
      if (toolbarPressInProgress) {
        setTimeout(() => {
          toolbarPressInProgress = false;
        }, 80);
      }
    });

    document.addEventListener('pointercancel', () => {
      isDraggingSelection = false;
      toolbarPressInProgress = false;
    });

    document.addEventListener('selectionchange', () => {
      scheduleEvaluation(160);
    });

    // Keep text selection alive on pointerdown inside the action bar (copy-button guide)
    toolbar.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      toolbarPressInProgress = true;
    });

    toolbar.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (!toolbar.matches(':focus-within')) {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) hideToolbar();
        }
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isToolbarOpen()) {
        const hadFocus = toolbar.contains(document.activeElement);
        hideToolbar();
        if (hadFocus) {
          articleEl.setAttribute('tabindex', '-1');
          articleEl.focus({ preventScroll: true });
          articleEl.addEventListener(
            'blur',
            () => articleEl.removeAttribute('tabindex'),
            { once: true }
          );
        }
      }
    });

    if (quickSaveBtn) {
      quickSaveBtn.addEventListener('click', () => {
        const snap = pendingSelection;
        toolbarPressInProgress = false;
        if (!snap) return;
        createOrUpdateNote({
          pageSlug: app.currentSlug,
          pageTitle: document.body.dataset.pageTitle || document.title,
          headingId: snap.headingId,
          headingText: snap.headingText,
          quoteText: snap.quoteText,
          quoteHtml: snap.quoteHtml,
          note: '',
          tag: '摘录',
        });
        window.getSelection()?.removeAllRanges();
        hideToolbar();
        app.showToast('已加入笔记本', {
          actionLabel: '查看笔记',
          onAction: openNotebookDrawer,
          autoHideMs: 4200,
        });
      });
    }

    if (annotateBtn) {
      annotateBtn.addEventListener('click', () => {
        const snap = pendingSelection;
        toolbarPressInProgress = false;
        if (!snap) return;
        window.getSelection()?.removeAllRanges();
        hideToolbar();
        openComposerWithDraft({
          mode: 'highlight',
          pageSlug: app.currentSlug,
          pageTitle: document.body.dataset.pageTitle || document.title,
          headingId: snap.headingId,
          headingText: snap.headingText,
          quoteText: snap.quoteText,
          quoteHtml: snap.quoteHtml,
          tag: '摘录',
        });
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        toolbarPressInProgress = false;
        hideToolbar();
      });
    }

    window.addEventListener(
      'scroll',
      () => {
        if (isToolbarOpen() && pendingSelection && finePointerMql.matches && !narrowMql.matches) {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
            positionToolbar(sel.getRangeAt(0).getBoundingClientRect());
          } else {
            hideToolbar();
          }
        }
      },
      { passive: true }
    );
  }

  /* ========================================================================
     9. Sync Modal UI ("云端同步与本机备份")
     ======================================================================== */

  function initSyncDialogUI() {
    const syncDialog = document.getElementById('sync-dialog');
    if (!syncDialog) return;

    app.bindClosedByFallback(syncDialog);

    syncDialog.addEventListener('cancel', (event) => {
      if (event.cancelable && !app.supportsTopLayerExit?.()) {
        event.preventDefault();
        app.closeDialogAnimated(syncDialog);
      }
    });

    const closeBtn = document.getElementById('sync-close');
    const bindForm = document.getElementById('sync-bind-form');
    const codeInput = document.getElementById('sync-code-input');
    const genBtn = document.getElementById('sync-gen-btn');
    const toggleMaskBtn = document.getElementById('sync-toggle-mask');
    const copyCodeBtn = document.getElementById('sync-copy-code');
    const copyLinkBtn = document.getElementById('sync-copy-link');
    const copyStatusEl = document.getElementById('sync-copy-status');
    const actionStatusEl = document.getElementById('sync-action-status');
    const backupStatusEl = document.getElementById('sync-backup-status');
    const syncNowBtn = document.getElementById('sync-now-btn');
    const unlinkBtn = document.getElementById('sync-unlink-btn');
    const clearCloudBtn = document.getElementById('sync-clear-cloud-btn');
    const exportJsonBtn = document.getElementById('sync-export-json');
    const importBtn = document.getElementById('sync-import-btn');
    const importFileInput = document.getElementById('sync-import-file');

    function openSyncDialog() {
      document.dispatchEvent(new CustomEvent('notes:overlay-open', { detail: { source: 'sync-dialog' } }));
      const tocDrawer = document.getElementById('toc-drawer');
      if (tocDrawer?.open) tocDrawer.close();
      if (nbDrawer?.open) nbDrawer.close();

      maskCodeVisible = false;
      if (codeInput) codeInput.value = '';
      renderSyncUI();
      syncDialog.removeAttribute('data-closing');
      if (!syncDialog.open) syncDialog.showModal();
    }

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-sync]')) {
        openSyncDialog();
      }
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => app.closeDialogAnimated(syncDialog));
    }

    if (genBtn && codeInput) {
      genBtn.addEventListener('click', () => {
        codeInput.value = generatePassphrase();
        codeInput.focus();
      });
    }

    if (bindForm && codeInput) {
      bindForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const val = codeInput.value.trim();
        if (val.length < 6 || val.length > 128) {
          codeInput.setCustomValidity('请输入 6 至 128 位字符的同步码');
          codeInput.reportValidity();
          return;
        }
        codeInput.setCustomValidity('');
        setSyncCode(val);
        codeInput.value = '';
        renderSyncUI();
        const res = await performSync({ announce: false });
        if (res.ok) {
          showStatusMessage(actionStatusEl, '同步码已绑定并完成云端同步', false, 3200);
        } else {
          showStatusMessage(actionStatusEl, syncStatusDetail || '已绑定同步码，当前暂存本机', true, 3600);
        }
      });
      codeInput.addEventListener('input', () => codeInput.setCustomValidity(''));
    }

    if (toggleMaskBtn) {
      toggleMaskBtn.addEventListener('click', () => {
        maskCodeVisible = !maskCodeVisible;
        renderSyncUI();
      });
    }

    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', () => {
        const code = getSyncCode();
        if (code) copyTextWithFeedback(code, copyStatusEl, '已复制同步码', '复制失败');
      });
    }

    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => {
        const code = getSyncCode();
        if (!code) return;
        const base = `${window.location.origin}${window.location.pathname}`;
        const url = `${base}#sync=${encodeURIComponent(code)}`;
        copyTextWithFeedback(
          url,
          copyStatusEl,
          '已复制免输绑定链接（请勿公开分享）',
          '复制失败'
        );
      });
    }

    if (syncNowBtn) {
      syncNowBtn.addEventListener('click', async () => {
        const res = await performSync({ announce: false });
        if (res.ok) {
          showStatusMessage(actionStatusEl, '云端同步完成', false, 2800);
        } else if (res.reason !== 'busy') {
          showStatusMessage(actionStatusEl, syncStatusDetail || '同步暂不可用，请稍后重试', true, 3400);
        }
      });
    }

    if (unlinkBtn) {
      unlinkBtn.addEventListener('click', () => {
        setSyncCode('');
        setSyncMeta({ revision: 0, lastSyncedAt: 0 });
        syncDirty = false;
        syncState = 'idle';
        syncStatusDetail = '';
        renderSyncUI();
        showStatusMessage(actionStatusEl, '已解除云端绑定，本地数据已保留', false, 3200);
      });
    }

    if (clearCloudBtn) {
      clearCloudBtn.addEventListener('click', clearCloudSpace);
    }

    if (exportJsonBtn) {
      exportJsonBtn.addEventListener('click', () => {
        const payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          progress: app.getProgressState(),
          notes: getAllNotesRaw(),
        };
        const date = formatLocalDate();
        triggerFileDownload(
          `${exportPrefix}-学习备份-${date}.json`,
          JSON.stringify(payload, null, 2),
          'application/json;charset=utf-8'
        );
        showStatusMessage(backupStatusEl, '已导出离线备份 JSON', false, 3000);
      });
    }

    if (importBtn && importFileInput) {
      importBtn.addEventListener('click', () => importFileInput.click());
      importFileInput.addEventListener('change', async () => {
        const file = importFileInput.files?.[0];
        importFileInput.value = '';
        if (!file) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');
          if (parsed.progress) {
            const mergedProg = mergeProgressStates(app.getProgressState(), parsed.progress);
            app.applyMergedProgress(mergedProg);
          }
          if (Array.isArray(parsed.notes)) {
            const mergedNotes = mergeNotesLists(getAllNotesRaw(), parsed.notes);
            saveAllNotesRaw(mergedNotes);
            updateNotebookBadges();
            renderNotebookList();
          }
          renderSyncUI();
          scheduleSync(400);
          showStatusMessage(backupStatusEl, '备份已导入并合并', false, 3200);
        } catch {
          showStatusMessage(backupStatusEl, '导入失败：无效的 JSON 备份文件', true, 3600);
        }
      });
    }
  }

  /* ========================================================================
     10. Bootstrap, Cross-Tab Sync & Auto-Sync Lifecycle
     ======================================================================== */

  updateNotebookBadges();
  renderSyncUI();
  initNotebookUI();
  initSelectionCapture();
  initSyncDialogUI();

  // Auto-sync on progress changes from app.js
  app.onProgressChange((reason) => {
    updateSyncLocalStats();
    const delay = reason === 'scroll' ? 2400 : 700;
    scheduleSync(delay);
  });

  // Flush dirty state cleanly when leaving page or reconnecting
  window.addEventListener('online', () => {
    if (syncDirty && app.pageType !== '404' && getSyncCode()) {
      scheduleSync(300, { isMutation: false });
    }
  });
  window.addEventListener('pagehide', () => {
    if (syncDirty && getSyncCode()) {
      performSync({ keepalive: true });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && syncDirty && getSyncCode()) {
      performSync({ keepalive: true });
    }
  });

  // Cross-tab sync for notes & sync code
  window.addEventListener('storage', (event) => {
    if (event.key === NB_STORAGE.notes) {
      updateNotebookBadges();
      if (nbDrawer?.open) renderNotebookList();
    } else if (event.key === NB_STORAGE.syncCode || event.key === NB_STORAGE.syncMeta) {
      renderSyncUI();
    }
  });

  // Handle #sync= fragment auto-bind OR pull latest cloud state on load (skip 404)
  const autoBound = handleAutoBindHash();
  if (!autoBound && app.pageType !== '404' && getSyncCode()) {
    performSync({ announce: false });
  }
})();
