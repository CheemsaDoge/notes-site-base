/**
 * Strict fail-closed allowlist HTML sanitizer for KaTeX/MathML/prose note quotes.
 * Preserves KaTeX visual output (including MathML & KaTeX SVG sqrt/arrows) while
 * eliminating scripts, event handlers, javascript:/data: URLs, dangerous CSS, and
 * unbalanced tag breakout (mXSS).
 */

const MAX_HTML_INPUT_LENGTH = 128 * 1024;
const MAX_HTML_OUTPUT_LENGTH = 64 * 1024;
const MAX_NESTING_DEPTH = 64;

const DROP_SUBTREE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'textarea',
  'title',
  'xmp',
  'foreignobject',
  'head',
  'meta',
  'link',
  'base',
  'form',
  'input',
  'button',
  'select',
  'option',
  'audio',
  'video',
  'source',
  'canvas',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'use',
  'image',
  'feimage',
]);

const VOID_TAGS = new Set(['br', 'wbr']);

const MATHML_TAGS = new Set([
  'math',
  'semantics',
  'mrow',
  'mi',
  'mn',
  'mo',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mover',
  'munder',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'mtext',
  'mspace',
  'mstyle',
  'mpadded',
  'annotation',
]);

const PROSE_TAGS = new Set([
  'span',
  'div',
  'p',
  'br',
  'wbr',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'sub',
  'sup',
  'mark',
  'del',
  's',
  'small',
  'ul',
  'ol',
  'li',
]);

const SVG_TAGS = new Set(['svg', 'path', 'circle']);

const ALLOWED_TAGS = new Set([...PROSE_TAGS, ...MATHML_TAGS, ...SVG_TAGS]);

const GLOBAL_SAFE_ATTRS = new Set(['class', 'aria-hidden', 'role', 'title']);

const MATHML_SAFE_ATTRS = new Set([
  'xmlns',
  'display',
  'encoding',
  'mathvariant',
  'fence',
  'separator',
  'stretchy',
  'lspace',
  'rspace',
  'maxsize',
  'minsize',
  'accent',
  'accentunder',
  'linethickness',
  'width',
  'displaystyle',
  'scriptlevel',
  'columnalign',
  'columnspacing',
  'rowspacing',
  'columnlines',
  'rowlines',
  'frame',
  'symmetric',
  'movablelimits',
  'largeop',
  'form',
]);

const SVG_ATTRS = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'focusable',
  'class',
  'aria-hidden',
  'style',
]);

const PATH_ATTRS = new Set(['d', 'fill', 'stroke', 'stroke-width', 'class']);
const CIRCLE_ATTRS = new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'class']);

// Canonical SVG camelCase attribute names when serializing
const CANONICAL_ATTR_NAMES = new Map([
  ['viewbox', 'viewBox'],
  ['preserveaspectratio', 'preserveAspectRatio'],
]);

const ALLOWED_STYLE_PROPS = new Set([
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'top',
  'bottom',
  'left',
  'right',
  'vertical-align',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-bottom-width',
  'border-top-width',
  'border-right-width',
  'border-left-width',
  'border-color',
  'border-bottom-style',
  'border-top-style',
  'color',
  'background-color',
  'position',
  'display',
  'font-size',
  'letter-spacing',
  'opacity',
]);

const SAFE_POSITION_VALUES = new Set(['relative', 'absolute', 'static']);
const SAFE_DISPLAY_VALUES = new Set([
  'inline',
  'inline-block',
  'block',
  'table',
  'table-row',
  'table-cell',
  'none',
]);
const SAFE_CSS_VALUE_RE = /^[a-zA-Z0-9\s.,%#()+\-]+$/;
const DANGEROUS_CSS_RE =
  /url\s*\(|expression\s*\(|javascript:|vbscript:|data:|@import|-moz-binding|behavior\s*:|\\|\/\*|<|>|"|'/i;

const SAFE_CLASS_RE = /^[a-zA-Z0-9_\-\s]+$/;
const SAFE_VIEWBOX_RE = /^[0-9.+\-\s,]+$/;
const SAFE_PAR_RE = /^[a-zA-Z\s]+$/;
const SAFE_PATH_D_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+\-eE]+$/;
const SAFE_SVG_NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:%|px|em|ex|pt)?$/;
const SAFE_SVG_PAINT_RE = /^(none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/;
const SAFE_ATTR_VALUE_RE = /^[a-zA-Z0-9_.\-+%/,\s:()#]+$/;

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
]);

function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (match, ent) => {
    if (ent[0] === '#') {
      const cp =
        ent[1] === 'x' || ent[1] === 'X'
          ? Number.parseInt(ent.slice(2), 16)
          : Number.parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
      try {
        return String.fromCodePoint(cp);
      } catch {
        return '';
      }
    }
    const lower = ent.toLowerCase();
    return NAMED_ENTITIES.has(lower) ? NAMED_ENTITIES.get(lower) : match;
  });
}

function escapeText(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeStyle(rawStyle) {
  const decoded = decodeEntities(rawStyle).replace(/\u0000/g, '').trim();
  if (!decoded || DANGEROUS_CSS_RE.test(decoded)) return '';

  const out = [];
  for (const decl of decoded.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();
    if (!prop || !val) continue;
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (DANGEROUS_CSS_RE.test(val) || !SAFE_CSS_VALUE_RE.test(val)) continue;
    // Block calc/var/attr/env/etc. except safe rgb()/rgba()
    if (/\(/.test(val) && !/^rgba?\(\s*[0-9.,%\s]+\)$/.test(val)) continue;
    if (prop === 'position' && !SAFE_POSITION_VALUES.has(val.toLowerCase())) {
      continue;
    }
    if (prop === 'display' && !SAFE_DISPLAY_VALUES.has(val.toLowerCase())) {
      continue;
    }
    out.push(`${prop}:${val}`);
  }
  return out.join(';');
}

function sanitizeAttribute(tag, rawName, rawValue) {
  const name = rawName.toLowerCase();
  if (name.startsWith('on') || name.startsWith('xlink') || name === 'href' || name === 'src' || name === 'srcdoc') {
    return null;
  }

  const decoded = decodeEntities(rawValue).replace(/\u0000/g, '').trim();

  if (tag === 'svg') {
    if (!SVG_ATTRS.has(name)) return null;
    if (name === 'xmlns') {
      return decoded === 'http://www.w3.org/2000/svg' ? [name, decoded] : null;
    }
    if (name === 'viewbox') {
      return SAFE_VIEWBOX_RE.test(decoded) ? ['viewBox', decoded] : null;
    }
    if (name === 'preserveaspectratio') {
      return SAFE_PAR_RE.test(decoded) ? ['preserveAspectRatio', decoded] : null;
    }
    if (name === 'style') {
      const clean = sanitizeStyle(decoded);
      return clean ? ['style', clean] : null;
    }
    if (name === 'class') {
      return SAFE_CLASS_RE.test(decoded) ? ['class', decoded] : null;
    }
    if (name === 'focusable') {
      return decoded === 'false' ? ['focusable', 'false'] : null;
    }
    if (name === 'aria-hidden') {
      return decoded === 'true' || decoded === 'false' ? [name, decoded] : null;
    }
    if (name === 'width' || name === 'height') {
      return SAFE_CSS_VALUE_RE.test(decoded) ? [name, decoded] : null;
    }
    return null;
  }

  if (tag === 'path') {
    if (!PATH_ATTRS.has(name)) return null;
    if (name === 'd') {
      return decoded.length <= 8192 && SAFE_PATH_D_RE.test(decoded)
        ? ['d', decoded]
        : null;
    }
    if (name === 'fill' || name === 'stroke') {
      return SAFE_SVG_PAINT_RE.test(decoded) ? [name, decoded] : null;
    }
    if (name === 'stroke-width') {
      return SAFE_CSS_VALUE_RE.test(decoded) ? [name, decoded] : null;
    }
    if (name === 'class') {
      return SAFE_CLASS_RE.test(decoded) ? ['class', decoded] : null;
    }
    return null;
  }

  if (tag === 'circle') {
    if (!CIRCLE_ATTRS.has(name)) return null;
    if (name === 'cx' || name === 'cy' || name === 'r') {
      return SAFE_SVG_NUM_RE.test(decoded) ? [name, decoded] : null;
    }
    if (name === 'fill' || name === 'stroke') {
      return SAFE_SVG_PAINT_RE.test(decoded) ? [name, decoded] : null;
    }
    if (name === 'stroke-width') {
      return SAFE_CSS_VALUE_RE.test(decoded) ? [name, decoded] : null;
    }
    if (name === 'class') {
      return SAFE_CLASS_RE.test(decoded) ? ['class', decoded] : null;
    }
    return null;
  }

  if (name === 'style') {
    if (tag !== 'span' && tag !== 'div') return null;
    const clean = sanitizeStyle(decoded);
    return clean ? ['style', clean] : null;
  }

  if (GLOBAL_SAFE_ATTRS.has(name)) {
    if (name === 'class') {
      return SAFE_CLASS_RE.test(decoded) ? ['class', decoded] : null;
    }
    if (name === 'aria-hidden') {
      return decoded === 'true' || decoded === 'false' ? [name, decoded] : null;
    }
    if (name === 'role') {
      return /^[a-z\-]+$/.test(decoded) ? [name, decoded] : null;
    }
    if (name === 'title') {
      return decoded.length <= 200 ? ['title', decoded] : null;
    }
  }

  if (MATHML_TAGS.has(tag) && MATHML_SAFE_ATTRS.has(name)) {
    if (name === 'xmlns') {
      return decoded === 'http://www.w3.org/1998/Math/MathML'
        ? ['xmlns', decoded]
        : null;
    }
    if (name === 'encoding') {
      return decoded === 'application/x-tex' ? ['encoding', decoded] : null;
    }
    if (name === 'display') {
      return decoded === 'block' || decoded === 'inline' ? ['display', decoded] : null;
    }
    if (decoded.length <= 128 && SAFE_ATTR_VALUE_RE.test(decoded)) {
      return [CANONICAL_ATTR_NAMES.get(name) || name, decoded];
    }
  }

  return null;
}

function parseAttributes(attrSource) {
  const attrs = [];
  let i = 0;
  const len = attrSource.length;

  while (i < len) {
    while (i < len && /[\s/]/.test(attrSource[i])) i++;
    if (i >= len) break;

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrSource[i])) i++;
    const name = attrSource.slice(nameStart, i);
    if (!name) {
      i++;
      continue;
    }

    while (i < len && /\s/.test(attrSource[i])) i++;
    let value = '';
    if (i < len && attrSource[i] === '=') {
      i++;
      while (i < len && /\s/.test(attrSource[i])) i++;
      if (i < len && (attrSource[i] === '"' || attrSource[i] === "'")) {
        const quote = attrSource[i++];
        const valStart = i;
        while (i < len && attrSource[i] !== quote) i++;
        value = attrSource.slice(valStart, i);
        if (i < len && attrSource[i] === quote) i++;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(attrSource[i])) i++;
        value = attrSource.slice(valStart, i);
      }
    }

    attrs.push([name, value]);
  }
  return attrs;
}

/**
 * Find closing `>` of a tag while respecting quoted attribute strings.
 */
function findTagEnd(html, startIndex) {
  let quote = null;
  for (let i = startIndex; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Strictly sanitize HTML for notebook quote display.
 * @param {unknown} rawHtml
 * @returns {string}
 */
export function sanitizeQuoteHtml(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml) return '';
  const input = rawHtml
    .replace(/\u0000/g, '')
    .slice(0, MAX_HTML_INPUT_LENGTH);

  const output = [];
  let outputLen = 0;
  const openStack = [];
  let dropDepth = 0;
  let dropTagName = '';

  const pushChunk = (chunk) => {
    if (!chunk) return;
    if (outputLen + chunk.length > MAX_HTML_OUTPUT_LENGTH) return;
    output.push(chunk);
    outputLen += chunk.length;
  };

  let i = 0;
  const len = input.length;

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      if (dropDepth === 0) {
        pushChunk(escapeText(decodeEntities(input.slice(i))));
      }
      break;
    }

    if (lt > i && dropDepth === 0) {
      pushChunk(escapeText(decodeEntities(input.slice(i, lt))));
    }

    // Comments: <!-- ... -->
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // CDATA: <![CDATA[ ... ]]>
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Processing instruction or DOCTYPE: <?...?> or <!...>
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const end = input.indexOf('>', lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(input, lt + 1);
    if (gt === -1) {
      // Unterminated tag — treat `<` as escaped literal text if not dropping
      if (dropDepth === 0) {
        pushChunk('&lt;');
      }
      i = lt + 1;
      continue;
    }

    const rawTagInner = input.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!rawTagInner) continue;

    const isClosing = rawTagInner[0] === '/';
    const selfClosing = !isClosing && rawTagInner.endsWith('/');
    const body = isClosing
      ? rawTagInner.slice(1).trim()
      : selfClosing
        ? rawTagInner.slice(0, -1).trim()
        : rawTagInner;

    const tagMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();

    // Handle dropped subtree boundaries
    if (dropDepth > 0) {
      if (tag === dropTagName) {
        if (isClosing) {
          dropDepth--;
          if (dropDepth === 0) dropTagName = '';
        } else if (!selfClosing) {
          dropDepth++;
        }
      }
      continue;
    }

    if (!isClosing && DROP_SUBTREE_TAGS.has(tag)) {
      if (!selfClosing) {
        dropDepth = 1;
        dropTagName = tag;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Non-allowlisted benign container tag (e.g. <a>, <font>): unwrap silently
      continue;
    }

    if (isClosing) {
      if (VOID_TAGS.has(tag)) continue;
      // Only close if matching tag is currently open on stack
      const idx = openStack.lastIndexOf(tag);
      if (idx !== -1) {
        while (openStack.length > idx) {
          const popped = openStack.pop();
          pushChunk(`</${popped}>`);
        }
      }
      continue;
    }

    // Opening tag
    if (openStack.length >= MAX_NESTING_DEPTH && !VOID_TAGS.has(tag) && !selfClosing) {
      continue;
    }

    const attrSource = body.slice(tagMatch[0].length);
    const parsedAttrs = parseAttributes(attrSource);
    const seenAttrs = new Set();
    let attrOut = '';

    for (const [aName, aVal] of parsedAttrs) {
      const clean = sanitizeAttribute(tag, aName, aVal);
      if (!clean) continue;
      const [outName, outVal] = clean;
      const key = outName.toLowerCase();
      if (seenAttrs.has(key)) continue;
      seenAttrs.add(key);
      attrOut += ` ${outName}="${escapeAttr(outVal)}"`;
    }

    if (VOID_TAGS.has(tag)) {
      pushChunk(`<${tag}${attrOut}>`);
    } else if (selfClosing && (tag === 'path' || tag === 'circle' || MATHML_TAGS.has(tag))) {
      pushChunk(`<${tag}${attrOut}></${tag}>`);
    } else {
      pushChunk(`<${tag}${attrOut}>`);
      openStack.push(tag);
    }
  }

  // Always close any remaining open tags to guarantee balanced DOM output
  while (openStack.length > 0) {
    const popped = openStack.pop();
    output.push(`</${popped}>`);
  }

  return output.join('');
}
