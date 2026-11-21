import * as cheerio from "cheerio";

const SKIP_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "math",
  "annotation",
  "svg",
  "code",
  "pre",
  "kbd",
  "samp",
  "script",
  "style",
  "a",
  "button",
  "header",
  "summary",
  "noscript",
  "textarea",
  "input",
  "select",
  "option",
]);

const SKIP_CLASSES = new Set([
  "katex",
  "katex-display",
  "katex-mathml",
  "katex-html",
  "math-block",
  "math-inline-scroll",
  "math-quote",
  "page-header",
  "page-meta",
  "page-summary",
  "callout-title",
  "solution-summary",
  "solution-summary-label",
  "heading-anchor",
  "no-concept-links",
]);

const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const ASCII_WORD_START_RE = /^[A-Za-z0-9_]/;
const ASCII_WORD_END_RE = /[A-Za-z0-9_]$/;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalize pattern string for lookup: collapse whitespace and make
 * spaces between CJK and ASCII/Latin optional.
 */
function normalizePatternKey(str) {
  return String(str)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff\uf900-\ufaff])\s+([A-Za-z0-9])/g, "$1$2")
    .replace(/([A-Za-z0-9])\s+([\u3400-\u9fff\uf900-\ufaff])/g, "$1$2");
}

/**
 * Convert a concept term/alias into a boundary-safe regex pattern fragment.
 * - Optional spaces between CJK and ASCII boundaries (e.g. "Taylor 公式" matches "Taylor公式")
 * - Word boundaries around leading/trailing ASCII word chars so English terms never match mid-word
 * - Discipline-specific negation/boundary guards injected cleanly from site.config.json
 */
function patternToRegexSource(rawPattern, { nonNegatedSet, boundaryGuards, suffixGuards }) {
  const normalized = normalizePatternKey(rawPattern);
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const prev = i > 0 ? normalized[i - 1] : "";

    if (
      prev &&
      ((CJK_CHAR_RE.test(prev) && /[A-Za-z0-9]/.test(ch)) ||
        (/[A-Za-z0-9]/.test(prev) && CJK_CHAR_RE.test(ch)))
    ) {
      out += "\\s*";
    }

    if (ch === " ") {
      out += "\\s+";
    } else {
      out += escapeRegex(ch);
    }
  }

  let prefix = ASCII_WORD_START_RE.test(normalized) ? "(?<![A-Za-z0-9_])" : "";
  let suffix = ASCII_WORD_END_RE.test(normalized) ? "(?![A-Za-z0-9_])" : "";

  // Configurable negated-term guard (blocks "非<term>" while preserving "除非<term>")
  if (nonNegatedSet.has(normalized)) {
    prefix = `(?<!(?<!除)非)${prefix}`;
  }

  // Configurable prefix/suffix pattern guards from site.config.json
  for (const rule of suffixGuards) {
    const matchEnd = !rule.endsWith || normalized.endsWith(rule.endsWith);
    const matchStart = !rule.startsWith || normalized.startsWith(rule.startsWith);
    if (!matchEnd || !matchStart) continue;
    if (rule.beforeNot) prefix = `(?<!${rule.beforeNot})${prefix}`;
    if (rule.afterNot) suffix += `(?!${rule.afterNot})`;
  }

  // Configurable exact-term boundary guards from site.config.json
  const exactGuard = boundaryGuards.get(normalized);
  if (exactGuard) {
    if (exactGuard.beforeNot) prefix = `(?<!${exactGuard.beforeNot})${prefix}`;
    if (exactGuard.afterNot) suffix += `(?!${exactGuard.afterNot})`;
  }

  return `${prefix}${out}${suffix}`;
}

/**
 * Determine whether a candidate pattern is safe to auto-match.
 * Rejects 1-character terms to prevent false matches inside unrelated words.
 */
function isMatchablePattern(pattern) {
  const trimmed = String(pattern || "").trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, "");
  return compact.length >= 2;
}

/**
 * Build a reusable longest-first matcher from the course concepts list.
 * All concepts (including self-page ones) are compiled into the matcher so
 * longer compound terms consume their full span and never get split into
 * partial sub-term links.
 *
 * @param {Array} concepts
 * @param {object} [options]
 * @param {Iterable<string>} [options.nonNegatedTerms] - Terms guarded against leading "非" (except "除非")
 * @param {Iterable<string>} [options.inertCompoundBlockers] - Compound words consumed inertly as plain text
 * @param {Record<string, {beforeNot?: string, afterNot?: string}>} [options.boundaryGuards]
 * @param {Array<{endsWith?: string, startsWith?: string, beforeNot?: string, afterNot?: string}>} [options.suffixGuards]
 */
export function buildConceptMatcher(concepts = [], options = {}) {
  const nonNegatedSet = new Set(
    Array.from(options.nonNegatedTerms || [])
      .map((s) => normalizePatternKey(s))
      .filter(Boolean)
  );
  const inertCompoundBlockers = Array.from(options.inertCompoundBlockers || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const boundaryGuards = new Map();
  if (options.boundaryGuards && typeof options.boundaryGuards === "object") {
    for (const [term, guard] of Object.entries(options.boundaryGuards)) {
      const key = normalizePatternKey(term);
      if (key && guard && typeof guard === "object") {
        boundaryGuards.set(key, guard);
      }
    }
  }
  const suffixGuards = Array.isArray(options.suffixGuards) ? options.suffixGuards : [];

  const keyMap = new Map();
  const entries = [];
  const warnings = [];

  for (const concept of concepts) {
    if (!concept || !concept.id || !concept.targetPage) continue;

    const candidates = [];
    if (concept.term) {
      candidates.push({ raw: concept.term, isPrimary: true });
    }
    if (Array.isArray(concept.aliases)) {
      for (const alias of concept.aliases) {
        if (alias) candidates.push({ raw: alias, isPrimary: false });
      }
    }

    let registeredForConcept = 0;
    for (const { raw, isPrimary } of candidates) {
      if (!isMatchablePattern(raw)) continue;
      const key = normalizePatternKey(raw);
      if (keyMap.has(key)) {
        const existing = keyMap.get(key);
        if (existing.concept.id !== concept.id) {
          // Prefer primary term over alias if collision occurs
          if (isPrimary && !existing.isPrimary) {
            existing.concept = concept;
            existing.isPrimary = true;
          } else {
            warnings.push(
              `Duplicate concept pattern "${raw}" between "${existing.concept.id}" and "${concept.id}" (keeping "${existing.concept.id}").`
            );
          }
        }
        registeredForConcept++;
        continue;
      }

      const entry = {
        key,
        raw: raw.trim(),
        length: key.length,
        isPrimary,
        concept,
        regexSrc: patternToRegexSource(raw, {
          nonNegatedSet,
          boundaryGuards,
          suffixGuards,
        }),
      };
      keyMap.set(key, entry);
      entries.push(entry);
      registeredForConcept++;
    }

    if (registeredForConcept === 0) {
      warnings.push(
        `Concept "${concept.id}" (term: "${concept.term}") has no matchable 2+ char term/alias patterns.`
      );
    }
  }

  // Register configurable inert compound blockers (only when not already defined as a real concept term/alias)
  for (const blocker of inertCompoundBlockers) {
    const key = normalizePatternKey(blocker);
    if (!key || keyMap.has(key)) continue;
    const baseSrc = escapeRegex(key);
    const regexSrc = key.startsWith("非") ? `(?<!除)${baseSrc}` : baseSrc;
    const entry = {
      key,
      raw: blocker,
      length: key.length,
      isPrimary: false,
      inert: true,
      concept: null,
      regexSrc,
    };
    keyMap.set(key, entry);
    entries.push(entry);
  }

  // Sort strictly longest-first; tie-break primary terms first, then deterministic key order
  entries.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  const regex =
    entries.length > 0 ? new RegExp(entries.map((e) => e.regexSrc).join("|"), "g") : null;

  return { regex, keyMap, entries, warnings };
}

function shouldSkipElement(el) {
  if (!el || el.type !== "tag") return false;
  const tag = (el.name || "").toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;

  const attribs = el.attribs || {};
  if ("data-no-concepts" in attribs) return true;

  const classAttr = attribs.class || "";
  if (classAttr) {
    const classes = classAttr.split(/\s+/);
    for (const cls of classes) {
      if (SKIP_CLASSES.has(cls)) return true;
    }
  }
  return false;
}

function isSelfConcept(concept, currentPageSlug) {
  if (!currentPageSlug) return false;
  if (concept.targetPage === currentPageSlug) return true;
  if (Array.isArray(concept.selfPages) && concept.selfPages.includes(currentPageSlug)) {
    return true;
  }
  return false;
}

/**
 * Inject first-mention-only concept recall links into rendered article HTML.
 * Operates strictly on DOM text nodes in reading order via Cheerio, using
 * a two-pass traversal (visible prose first, deferred closed solution boxes second).
 *
 * @param {string} html - Article body HTML fragment (or HTML containing <article>)
 * @param {object} options
 * @param {string} options.currentPageSlug - Slug of the current micro-page
 * @param {Array}  [options.concepts] - Concepts array (used if matcher not passed)
 * @param {object} [options.matcher] - Precompiled matcher from buildConceptMatcher()
 * @param {string} [options.pageBase="./"] - Relative prefix to pages directory
 * @param {string} [options.selector] - Optional CSS selector to scope injection
 * @returns {{ html: string, linkedConceptIds: string[], linkCount: number }}
 */
export function injectConcepts(html, options = {}) {
  const {
    currentPageSlug,
    concepts = [],
    matcher = buildConceptMatcher(concepts, options.matcherOptions),
    pageBase = "./",
    selector = null,
  } = options;

  if (!html || !matcher || !matcher.regex) {
    return { html: html || "", linkedConceptIds: [], linkCount: 0 };
  }

  const $ = cheerio.load(html, null, false);
  const seenConceptIds = new Set();
  const linkedConceptIds = [];

  const normalizedPageBase = pageBase.endsWith("/") ? pageBase : `${pageBase}/`;

  function processTextNode(textNode) {
    const text = textNode.data;
    if (!text || !text.trim()) return;

    const regex = matcher.regex;
    regex.lastIndex = 0;

    let lastIndex = 0;
    let changed = false;
    let outputHtml = "";
    let match;

    while ((match = regex.exec(text)) !== null) {
      const matchedText = match[0];
      if (!matchedText) {
        regex.lastIndex++;
        continue;
      }

      const key = normalizePatternKey(matchedText);
      const entry = matcher.keyMap.get(key);
      if (!entry || entry.inert || !entry.concept) continue;

      const concept = entry.concept;

      // Skip self-page concepts and already-linked concepts, while still
      // consuming the full matched compound token as plain text.
      if (isSelfConcept(concept, currentPageSlug) || seenConceptIds.has(concept.id)) {
        continue;
      }

      // First mention of an eligible concept on this micro-page
      seenConceptIds.add(concept.id);
      linkedConceptIds.push(concept.id);
      changed = true;

      if (match.index > lastIndex) {
        outputHtml += escapeHtml(text.slice(lastIndex, match.index));
      }

      const href = `${normalizedPageBase}${encodeURIComponent(concept.targetPage)}.html`;
      const title = `点击快速回忆：${concept.term}`;
      outputHtml +=
        `<a href="${escapeHtml(href)}" class="concept-ref" ` +
        `data-concept="${escapeHtml(concept.id)}" ` +
        `title="${escapeHtml(title)}">${escapeHtml(matchedText)}</a>`;

      lastIndex = match.index + matchedText.length;
    }

    if (changed) {
      if (lastIndex < text.length) {
        outputHtml += escapeHtml(text.slice(lastIndex));
      }
      $(textNode).replaceWith(outputHtml);
    }
  }

  function isClosedSolutionBox(el) {
    if (!el || el.type !== "tag" || (el.name || "").toLowerCase() !== "details") return false;
    const attribs = el.attribs || {};
    if ("open" in attribs) return false;
    const cls = attribs.class || "";
    return cls.split(/\s+/).includes("solution-box");
  }

  const deferredSolutionBoxes = [];

  function walkNode(node, deferClosedSolutions) {
    if (!node) return;
    if (node.type === "tag" && shouldSkipElement(node)) return;
    if (node.type === "script" || node.type === "style") return;

    if (deferClosedSolutions && isClosedSolutionBox(node)) {
      deferredSolutionBoxes.push(node);
      return;
    }

    if (node.type === "text") {
      processTextNode(node);
      return;
    }

    const children = Array.isArray(node.children) ? [...node.children] : [];
    for (const child of children) {
      walkNode(child, deferClosedSolutions);
    }
  }

  let roots;
  if (selector) {
    roots = $(selector).toArray();
  } else if ($("article").length > 0) {
    roots = $("article").toArray();
  } else {
    roots = $.root().contents().toArray();
  }

  // Pass 1: Walk visible article prose first (deferring collapsed details.solution-box:not([open]))
  for (const root of roots) {
    walkNode(root, true);
  }

  // Pass 2: Walk deferred collapsed solution boxes sharing seenConceptIds (preserving <= 1 per page)
  for (const box of deferredSolutionBoxes) {
    const children = Array.isArray(box.children) ? [...box.children] : [];
    for (const child of children) {
      walkNode(child, false);
    }
  }

  return {
    html: $.html(),
    linkedConceptIds,
    linkCount: linkedConceptIds.length,
  };
}
