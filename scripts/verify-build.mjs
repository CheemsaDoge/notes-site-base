import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { loadSiteConfig } from "../src/config.mjs";

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function extractFlatPages(rawSitemap) {
  const pages = [];
  if (Array.isArray(rawSitemap.parts) && rawSitemap.parts.some((p) => Array.isArray(p.chapters))) {
    for (const part of rawSitemap.parts) {
      for (const ch of part.chapters || []) {
        for (const pg of ch.pages || []) {
          pages.push({ ...pg, slug: pg.slug || pg.id });
        }
      }
    }
  } else if (Array.isArray(rawSitemap.pages)) {
    for (const pg of rawSitemap.pages) {
      pages.push({ ...pg, slug: pg.slug || pg.id });
    }
  }
  return pages;
}

const MATH_SKIP_TAGS = new Set(["script", "style", "math", "annotation", "svg", "noscript"]);
const MATH_SKIP_CLASSES = new Set(["katex", "katex-display", "katex-mathml", "katex-html"]);

const RAW_LATEX_CMD_RE =
  /\\(?:mathbb|mathcal|mathfrak|varphi|subseteq|supseteq|subset|supset|implies|iff|cong|ker|frac|begin\{|end\{|langle|rangle|lvert|rvert|cdot|times|circ|oplus|otimes|neq|le\b|ge\b|leq|geq|forall|exists|in\b|notin|cup|cap|varnothing|emptyset|infty|equiv|pmod|bmod|text\{|textbf\{|mathrm\{|dots|cdots|ldots|quad|qquad|mid\b)/;

const PAIRED_INLINE_DOLLAR_RE = /(?:^|[^\\])\$([^$\n]+?)(?:[^\\])\$/;
const SHORT_SINGLE_CHAR_DOLLAR_RE = /(?:^|[^\\])\$([^$\n\\])\$/;

function hasSkipClass(el) {
  const cls = el.attribs?.class || "";
  if (!cls) return false;
  for (const c of cls.split(/\s+/)) {
    if (MATH_SKIP_CLASSES.has(c)) return true;
  }
  return false;
}

function findUnrenderedMathInDom($, rootNodes, label) {
  const findings = [];

  $(".katex-error").each((_, el) => {
    findings.push(`${label}: .katex-error found: "${$(el).text().trim().slice(0, 100)}"`);
  });

  function walk(node, inCode = false) {
    if (!node) return;
    if (node.type === "script" || node.type === "style") return;
    if (node.type === "tag") {
      const tag = (node.name || "").toLowerCase();
      if (MATH_SKIP_TAGS.has(tag) || hasSkipClass(node)) return;
      const nextInCode = inCode || tag === "pre" || tag === "code";
      for (const child of node.children || []) {
        walk(child, nextInCode);
      }
      return;
    }
    if (node.type === "text") {
      const text = node.data || "";
      if (!text.trim()) return;

      if (text.includes("$$")) {
        findings.push(`${label}: unrendered "$$" in text: "${text.trim().slice(0, 120)}"`);
      } else if (PAIRED_INLINE_DOLLAR_RE.test(text) || SHORT_SINGLE_CHAR_DOLLAR_RE.test(text)) {
        findings.push(`${label}: unrendered "$...$" in text: "${text.trim().slice(0, 120)}"`);
      }

      if (RAW_LATEX_CMD_RE.test(text)) {
        findings.push(`${label}: raw LaTeX command in text: "${text.trim().slice(0, 120)}"`);
      }

      if (!inCode && text.includes("**")) {
        findings.push(`${label}: literal "**" bold markdown leak in text: "${text.trim().slice(0, 120)}"`);
      }

      if (!inCode) {
        for (const rawLine of text.split("\n")) {
          const t = rawLine.trim();
          if (/^:{3,}\s*(?:solution|hint|proof|detail|key)\b/i.test(t) || /^:{3,}$/.test(t)) {
            findings.push(`${label}: unclosed/unparsed container fence in text: "${t.slice(0, 120)}"`);
            break;
          }
        }
      }
    }
  }

  for (const node of rootNodes) {
    walk(node, false);
  }

  return findings;
}

function isExternalUrl(url) {
  return /^(?:https?:|mailto:|tel:|data:|javascript:|blob:)/i.test(url);
}

const FORBIDDEN_CONCEPT_ANCESTORS = new Set([
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
  "a",
  "button",
  "header",
  "summary",
]);

const FORBIDDEN_CONCEPT_ANCESTOR_CLASSES = new Set([
  "katex",
  "katex-display",
  "math-block",
  "math-inline-scroll",
  "page-header",
  "page-meta",
  "page-summary",
  "callout-title",
  "solution-summary",
  "solution-summary-label",
  "detail-summary",
  "detail-summary-label",
  "key-points-title",
]);

const VALID_PRIORITIES = new Set(["core", "high", "normal"]);

function checkForbiddenConceptAncestors($, el) {
  let parent = el.parent;
  while (parent && parent.type === "tag") {
    const tag = (parent.name || "").toLowerCase();
    if (FORBIDDEN_CONCEPT_ANCESTORS.has(tag)) {
      return `<${tag}>`;
    }
    const cls = parent.attribs?.class || "";
    for (const c of cls.split(/\s+/)) {
      if (FORBIDDEN_CONCEPT_ANCESTOR_CLASSES.has(c)) {
        return `.${c}`;
      }
    }
    parent = parent.parent;
  }
  return null;
}

const STYLE_EM_DASH_RE = /——/;
const STYLE_CONTRAST_RE = /不是[^。！？\n]{1,20}而是|是[^。！？\n]{1,16}，而不是/g;
const STYLE_CLICHE_RE =
  /值得注意的是|深入探讨|充分利用|底层逻辑|双刃剑|护城河|交响乐|降维打击|像一位导师|像一名管家/g;
const STYLE_META_PREVIEW_RE = /本节将|接下来我们|在了解了上述/g;

function stripMathAndCodeKeepLines(markdown) {
  const s = markdown.replace(/\r\n?/g, "\n");
  const len = s.length;
  let out = "";
  let i = 0;
  let atLineStart = true;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  while (i < len) {
    if (atLineStart) {
      const lineEnd = s.indexOf("\n", i);
      const rawLine = lineEnd === -1 ? s.slice(i) : s.slice(i, lineEnd);
      const fenceMatch = rawLine.match(/^(?:[ \t]*>[ \t]?)*[ ]{0,3}(`{3,}|~{3,})(.*)$/);
      if (inFence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fenceChar &&
          fenceMatch[1].length >= fenceLen &&
          fenceMatch[2].trim() === ""
        ) {
          inFence = false;
        }
        if (lineEnd !== -1) {
          out += "\n";
          i = lineEnd + 1;
          atLineStart = true;
        } else {
          i = len;
        }
        continue;
      } else if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        if (lineEnd !== -1) {
          out += "\n";
          i = lineEnd + 1;
          atLineStart = true;
        } else {
          i = len;
        }
        continue;
      }
      atLineStart = false;
    }

    const ch = s[i];
    if (ch === "\n") {
      out += "\n";
      i++;
      atLineStart = true;
      continue;
    }

    if (ch === "\\" && i + 1 < len && (s[i + 1] === "\\" || s[i + 1] === "$" || s[i + 1] === "`")) {
      out += "  ";
      i += 2;
      continue;
    }

    if (ch === "`") {
      let ticks = 1;
      while (i + ticks < len && s[i + ticks] === "`") ticks++;
      const delim = "`".repeat(ticks);
      let pos = i + ticks;
      let closeIdx = -1;
      while (pos < len) {
        const found = s.indexOf(delim, pos);
        if (found === -1) break;
        const bOk = found === 0 || s[found - 1] !== "`";
        const aOk = found + ticks >= len || s[found + ticks] !== "`";
        if (bOk && aOk) {
          closeIdx = found;
          break;
        }
        pos = found + 1;
      }
      if (closeIdx !== -1) {
        out += s.slice(i, closeIdx + ticks).replace(/[^\n]/g, " ");
        i = closeIdx + ticks;
        continue;
      }
    }

    if (ch === "$" && i + 1 < len && s[i + 1] === "$") {
      let j = i + 2;
      let closeIdx = -1;
      while (j < len) {
        if (s[j] === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (s[j] === "$" && j + 1 < len && s[j + 1] === "$") {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1) {
        out += s.slice(i, closeIdx + 2).replace(/[^\n]/g, " ");
        i = closeIdx + 2;
        continue;
      }
    }

    if (ch === "$") {
      let j = i + 1;
      let closeIdx = -1;
      while (j < len && s[j] !== "\n") {
        if (s[j] === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (s[j] === "$") {
          if (j > i + 1) closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1) {
        out += " ".repeat(closeIdx + 1 - i);
        i = closeIdx + 1;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function auditProseStyle(markdown, relLabel, errors, warnings, styleStats, { forbidEmDash }) {
  const proseOnly = stripMathAndCodeKeepLines(markdown);
  const lines = proseOnly.split("\n");
  const rawLines = markdown.replace(/\r\n?/g, "\n").split("\n");

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;
    const lineNo = idx + 1;
    const rawSnippet = (rawLines[idx] || line).trim().slice(0, 100);

    if (forbidEmDash && STYLE_EM_DASH_RE.test(line)) {
      styleStats.emDash++;
      errors.push(`${relLabel}:${lineNo}: forbidden em-dash "——" in prose: "${rawSnippet}"`);
    }

    if (forbidEmDash) {
      for (const m of line.matchAll(STYLE_CONTRAST_RE)) {
        styleStats.contrast++;
        warnings.push(`${relLabel}:${lineNo}: style contrast pattern "${m[0]}"`);
      }
      for (const m of line.matchAll(STYLE_CLICHE_RE)) {
        styleStats.cliche++;
        warnings.push(`${relLabel}:${lineNo}: style cliche word "${m[0]}"`);
      }
      for (const m of line.matchAll(STYLE_META_PREVIEW_RE)) {
        styleStats.metaPreview++;
        warnings.push(`${relLabel}:${lineNo}: style meta-preview phrase "${m[0]}"`);
      }
    }
  }
}

function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function hasWoff2Magic(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    return n === 4 && buf.toString("ascii") === "wOF2";
  } finally {
    fs.closeSync(fd);
  }
}

function parseCacheControlHeaderRules(headersText) {
  const rules = [];
  let currentPattern = null;
  let currentHasCacheControl = false;

  const flush = () => {
    if (currentPattern && currentHasCacheControl) {
      const escaped = currentPattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      rules.push({
        pattern: currentPattern,
        regex: new RegExp(`^${escaped}$`),
      });
    }
  };

  for (const rawLine of headersText.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!/^\s/.test(rawLine)) {
      flush();
      currentPattern = trimmed;
      currentHasCacheControl = false;
    } else if (/^cache-control\s*:/i.test(trimmed)) {
      currentHasCacheControl = true;
    }
  }
  flush();
  return rules;
}

export function runVerify(cliOpts = {}) {
  const rootDir = path.resolve(cliOpts.root || process.cwd());
  const initialConfig = loadSiteConfig(rootDir, { configPath: cliOpts.config || null });

  const dataDir = path.resolve(rootDir, cliOpts["data-dir"] || initialConfig.paths.dataDir);
  const contentDir = path.resolve(rootDir, cliOpts["content-dir"] || initialConfig.paths.contentDir);
  const explainedDir = path.resolve(
    rootDir,
    cliOpts["explained-dir"] || initialConfig.paths.explainedDir
  );
  const outDir = path.resolve(rootDir, cliOpts["out-dir"] || initialConfig.paths.outDir);
  const allowMissingExplained = Boolean(cliOpts["allow-missing-explained"]);

  const errors = [];
  const warnings = [];

  const sitemapPath = path.join(dataDir, "sitemap.json");
  const conceptsPath = path.join(dataDir, "concepts.json");

  if (!fs.existsSync(sitemapPath)) {
    throw new Error(`Missing sitemap file: ${sitemapPath}`);
  }
  if (!fs.existsSync(conceptsPath)) {
    throw new Error(`Missing concepts file: ${conceptsPath}`);
  }
  if (!fs.existsSync(outDir)) {
    throw new Error(`Missing build output directory: ${outDir}. Run build first.`);
  }

  const rawSitemap = JSON.parse(fs.readFileSync(sitemapPath, "utf8"));
  const rawConceptsJson = JSON.parse(fs.readFileSync(conceptsPath, "utf8"));
  const rawConcepts = Array.isArray(rawConceptsJson)
    ? rawConceptsJson
    : Array.isArray(rawConceptsJson.concepts)
      ? rawConceptsJson.concepts
      : [];

  const config = loadSiteConfig(rootDir, {
    configPath: cliOpts.config || null,
    sitemap: rawSitemap,
  });
  const dualReadingStyle = Boolean(config.features.dualReadingStyle);
  const forbidEmDash = Boolean(config.features.styleAudit?.forbidEmDash);

  const pages = extractFlatPages(rawSitemap);
  const conceptsById = new Map(rawConcepts.map((c) => [c.id, c]));
  const expectedSlugs = new Set(pages.map((p) => p.slug));

  // 1. Check required static outputs
  const requiredFiles = [
    "index.html",
    "404.html",
    "_headers",
    "assets/concepts-data.js",
    "assets/katex/katex.min.css",
  ];
  for (const rel of requiredFiles) {
    const abs = path.join(outDir, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`Missing required output file: dist/${rel}`);
    } else if (fs.statSync(abs).size === 0) {
      errors.push(`Required output file is empty: dist/${rel}`);
    }
  }

  // 1a. Verify dist/_headers uses non-overlapping immutable rules with NO broad `/assets/*` catch-all
  const headersPath = path.join(outDir, "_headers");
  let cacheControlRules = [];
  if (fs.existsSync(headersPath)) {
    const headersText = fs.readFileSync(headersPath, "utf8");
    cacheControlRules = parseCacheControlHeaderRules(headersText);
    if (/^\s*\/assets\/\*\s*$/m.test(headersText)) {
      errors.push(
        'dist/_headers must not contain broad "/assets/*" catch-all rule (causes stale cache on unhashed assets)'
      );
    }
    if (
      !/\/assets\/concepts-data\.js[\s\S]*?Cache-Control:\s*public,\s*max-age=0,\s*must-revalidate/i.test(
        headersText
      )
    ) {
      errors.push(
        'dist/_headers missing "Cache-Control: public, max-age=0, must-revalidate" for /assets/concepts-data.js'
      );
    }
    const requiredRules = [
      "/assets/katex/*.js",
      "/assets/*.css",
      "/assets/concepts.*.json",
      "/assets/app.*.js",
      "/assets/notebook-sync.*.js",
      "/assets/fonts/*",
    ];
    if (dualReadingStyle) {
      requiredRules.push("/assets/views/*");
    }
    for (const rulePath of requiredRules) {
      if (!headersText.includes(rulePath)) {
        errors.push(`dist/_headers missing immutable caching rule for "${rulePath}"`);
      }
    }
  }

  // 1a-2. Verify source corpus (dual-mode content-explained/ + optional forbidEmDash style audit)
  const styleStats = { filesAudited: 0, emDash: 0, contrast: 0, cliche: 0, metaPreview: 0 };
  for (const pg of pages) {
    const relUnderContent = (pg.file || "").replace(/^content[\\/]/, "");
    let primaryPath = path.resolve(rootDir, pg.file || "");
    if (!fs.existsSync(primaryPath)) {
      primaryPath = path.resolve(contentDir, relUnderContent);
    }

    if (dualReadingStyle) {
      const relExplainedLabel = `content-explained/${relUnderContent.split(path.sep).join("/")}`;
      const explainedPath = path.resolve(explainedDir, relUnderContent);
      if (!fs.existsSync(explainedPath)) {
        if (!allowMissingExplained) {
          errors.push(`Missing explained source markdown for "${pg.slug}": ${relExplainedLabel}`);
        }
        continue;
      }
      const explainedFull = fs.readFileSync(explainedPath, "utf8");
      const explainedRaw = explainedFull.replace(/\r\n?/g, "\n").trim();
      if (!explainedRaw) {
        errors.push(`Explained source markdown is empty for "${pg.slug}": ${relExplainedLabel}`);
        continue;
      }
      if (!allowMissingExplained && fs.existsSync(primaryPath)) {
        const primaryRaw = fs.readFileSync(primaryPath, "utf8").replace(/\r\n?/g, "\n").trim();
        if (explainedRaw === primaryRaw) {
          errors.push(
            `Explained source markdown for "${pg.slug}" is identical to content/ (accidental copy-paste)`
          );
        }
      }
      styleStats.filesAudited++;
      auditProseStyle(explainedFull, relExplainedLabel, errors, warnings, styleStats, {
        forbidEmDash,
      });
    } else if (forbidEmDash && fs.existsSync(primaryPath)) {
      const primaryFull = fs.readFileSync(primaryPath, "utf8");
      styleStats.filesAudited++;
      auditProseStyle(primaryFull, pg.file || relUnderContent, errors, warnings, styleStats, {
        forbidEmDash,
      });
    }
  }

  // Verify KaTeX font files referenced in katex.min.css exist + fingerprinted lazy katex.min.<hash8>.js
  const katexDir = path.join(outDir, "assets", "katex");
  const katexCssPath = path.join(katexDir, "katex.min.css");
  if (fs.existsSync(katexCssPath)) {
    const katexCss = fs.readFileSync(katexCssPath, "utf8");
    const fontUrls = new Set();
    for (const m of katexCss.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
      const target = m[2].trim();
      if (!target.startsWith("data:")) fontUrls.add(target);
    }
    for (const fontRel of fontUrls) {
      const resolvedFont = path.resolve(path.dirname(katexCssPath), fontRel);
      if (!fs.existsSync(resolvedFont)) {
        errors.push(`Missing KaTeX font referenced by katex.min.css: ${fontRel}`);
      }
    }
  }

  let expectedKatexJsRel = null;
  if (fs.existsSync(katexDir)) {
    const katexJsMatches = fs
      .readdirSync(katexDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^katex\.min\.[0-9a-f]{8}\.js$/i.test(e.name))
      .map((e) => e.name);
    if (katexJsMatches.length !== 1) {
      errors.push(
        `dist/assets/katex/ must contain exactly 1 fingerprinted katex.min.<hash8>.js (found ${katexJsMatches.length}: ${katexJsMatches.join(", ") || "none"})`
      );
    } else {
      const absKatexJs = path.join(katexDir, katexJsMatches[0]);
      if (fs.statSync(absKatexJs).size === 0) {
        errors.push(`Fingerprinted KaTeX JS runtime is empty: dist/assets/katex/${katexJsMatches[0]}`);
      } else {
        expectedKatexJsRel = `assets/katex/${katexJsMatches[0]}`;
      }
    }
  }

  // 1b. CSS, self-hosted webfont, WOFF2 integrity, zero-orphan & JS hygiene gates
  const assetsDir = path.join(outDir, "assets");
  const fontStats = {
    cssFileName: "",
    verifiedWoff2: 0,
    totalFontBytes: 0,
    orphanFonts: 0,
    assetsCheckedForHeaders: 0,
  };
  let expectedFontsCssName = null;

  if (fs.existsSync(assetsDir)) {
    const assetEntries = fs.readdirSync(assetsDir, { withFileTypes: true });
    const cssFiles = assetEntries
      .filter((e) => e.isFile() && e.name.endsWith(".css"))
      .map((e) => path.join(assetsDir, e.name));

    const fontCssMatches = assetEntries
      .filter((e) => e.isFile() && /^00-fonts\.[0-9a-f]{8}\.css$/i.test(e.name))
      .map((e) => e.name);
    if (fontCssMatches.length !== 1) {
      errors.push(
        `dist/assets/ must contain exactly 1 fingerprinted 00-fonts.<hash8>.css (found ${fontCssMatches.length}: ${fontCssMatches.join(", ") || "none"})`
      );
    } else {
      expectedFontsCssName = fontCssMatches[0];
      fontStats.cssFileName = expectedFontsCssName;
      const fontsCssPath = path.join(assetsDir, expectedFontsCssName);
      const fontsCss = fs.readFileSync(fontsCssPath, "utf8");
      if (!fontsCss.trim()) {
        errors.push(`dist/assets/${expectedFontsCssName} is empty`);
      } else {
        const blocks = fontsCss.match(/@font-face\s*\{[^}]*\}/g) || [];
        if (blocks.length === 0) {
          errors.push(`dist/assets/${expectedFontsCssName} contains 0 @font-face declarations`);
        }
        const familyStyles = new Map();
        for (let idx = 0; idx < blocks.length; idx++) {
          const blk = blocks[idx];
          const famMatch = blk.match(/font-family\s*:\s*['"]?([^'";}]+)['"]?\s*;/i);
          const styleMatch = blk.match(/font-style\s*:\s*([^;}]+)\s*;/i);
          const weightMatch = blk.match(/font-weight\s*:\s*([^;}]+)\s*;/i);
          const displayMatch = blk.match(/font-display\s*:\s*([^;}]+)\s*;/i);
          const srcMatch = blk.match(/src\s*:\s*url\(\s*(['"]?)([^)'"]+)\1\s*\)/i);
          if (!famMatch) {
            errors.push(`${expectedFontsCssName}: @font-face #${idx + 1} missing font-family`);
            continue;
          }
          const fam = famMatch[1].trim();
          const st = (styleMatch ? styleMatch[1] : "normal").trim().toLowerCase();
          const wt = (weightMatch ? weightMatch[1] : "").trim();
          const disp = (displayMatch ? displayMatch[1] : "").trim().toLowerCase();
          if (disp !== "swap") {
            errors.push(`${expectedFontsCssName}: @font-face #${idx + 1} (${fam}) must set font-display: swap`);
          }
          if (!srcMatch || !srcMatch[2].trim().endsWith(".woff2")) {
            errors.push(`${expectedFontsCssName}: @font-face #${idx + 1} (${fam}) missing .woff2 src url(...)`);
          }
          if (!familyStyles.has(fam)) familyStyles.set(fam, { styles: new Set(), weights: new Set(), count: 0 });
          const rec = familyStyles.get(fam);
          rec.styles.add(st);
          if (wt) rec.weights.add(wt);
          rec.count++;
        }

        const ssRec = familyStyles.get("Source Serif 4");
        if (!ssRec || !ssRec.styles.has("normal") || !ssRec.styles.has("italic")) {
          errors.push(
            `${expectedFontsCssName}: missing required "Source Serif 4" normal + italic @font-face declarations`
          );
        }
        const nsRec = familyStyles.get("Noto Serif SC");
        if (!nsRec || !nsRec.styles.has("normal") || nsRec.count === 0) {
          errors.push(`${expectedFontsCssName}: missing required "Noto Serif SC" @font-face declarations`);
        }
        const lwRec = familyStyles.get("LXGW WenKai Screen");
        if (!lwRec || !lwRec.styles.has("normal") || lwRec.count === 0) {
          errors.push(`${expectedFontsCssName}: missing required "LXGW WenKai Screen" @font-face declarations`);
        }
      }
    }

    const fontsRootDir = path.join(assetsDir, "fonts");
    const referencedFontPaths = new Set();
    const checkedWoff2 = new Set();
    let hasHiddenImportant = false;

    for (const cssPath of cssFiles) {
      const css = fs.readFileSync(cssPath, "utf8");
      if (/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important\s*;?/i.test(css)) {
        hasHiddenImportant = true;
      }
      for (const m of css.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)) {
        const target = m[2].trim();
        if (!target || /^(?:data:|https?:|#)/i.test(target)) continue;
        const cleanTarget = target.split(/[?#]/)[0];
        const resolved = path.resolve(path.dirname(cssPath), cleanTarget);
        const relToOut = path.relative(outDir, resolved);
        if (relToOut.startsWith("..") || path.isAbsolute(relToOut) || !fs.existsSync(resolved)) {
          errors.push(`Missing asset referenced by ${path.basename(cssPath)}: ${target}`);
          continue;
        }
        if (fs.statSync(resolved).size === 0) {
          errors.push(`Empty asset referenced by ${path.basename(cssPath)}: ${target}`);
          continue;
        }
        if (cleanTarget.toLowerCase().endsWith(".woff2") && !checkedWoff2.has(resolved)) {
          checkedWoff2.add(resolved);
          if (!hasWoff2Magic(resolved)) {
            errors.push(
              `Invalid WOFF2 magic header (expected "wOF2") in ${path.relative(outDir, resolved).split(path.sep).join("/")}`
            );
          } else {
            fontStats.verifiedWoff2++;
          }
        }
        const relToFonts = path.relative(fontsRootDir, resolved);
        if (!relToFonts.startsWith("..") && !path.isAbsolute(relToFonts)) {
          referencedFontPaths.add(relToFonts.split(path.sep).join("/"));
        }
      }
    }

    if (fs.existsSync(fontsRootDir)) {
      const diskFontFiles = listFilesRecursive(fontsRootDir);
      for (const absFont of diskFontFiles) {
        const relFont = path.relative(fontsRootDir, absFont).split(path.sep).join("/");
        fontStats.totalFontBytes += fs.statSync(absFont).size;
        if (!relFont.toLowerCase().endsWith(".woff2")) {
          errors.push(`Unexpected non-.woff2 file in dist/assets/fonts/: ${relFont}`);
        } else if (!checkedWoff2.has(absFont) && !hasWoff2Magic(absFont)) {
          errors.push(`Invalid WOFF2 magic header in dist/assets/fonts/${relFont}`);
        }
        if (!referencedFontPaths.has(relFont)) {
          fontStats.orphanFonts++;
          errors.push(`Orphan unreferenced font file in dist/assets/fonts/: ${relFont}`);
        }
      }
    }

    if (!hasHiddenImportant) {
      errors.push('Built CSS missing global "[hidden] { display: none !important; }" rule in dist/assets/*.css');
    }

    // Verify every file under dist/assets/** matches EXACTLY ONE Cache-Control rule in dist/_headers
    if (cacheControlRules.length > 0) {
      const allAssetFiles = listFilesRecursive(assetsDir);
      for (const absAsset of allAssetFiles) {
        const urlPath = `/${path.relative(outDir, absAsset).split(path.sep).join("/")}`;
        const matched = cacheControlRules.filter((r) => r.regex.test(urlPath));
        fontStats.assetsCheckedForHeaders++;
        if (matched.length === 0) {
          errors.push(`dist/_headers has no Cache-Control rule covering ${urlPath}`);
        } else if (matched.length > 1) {
          errors.push(
            `dist/_headers has ${matched.length} overlapping Cache-Control rules for ${urlPath}: ${matched
              .map((r) => r.pattern)
              .join(", ")}`
          );
        }
      }
    }

    const clientJsFiles = assetEntries
      .filter((e) => e.isFile() && e.name.endsWith(".js") && e.name !== "concepts-data.js")
      .map((e) => path.join(assetsDir, e.name));
    for (const jsPath of clientJsFiles) {
      const jsText = fs.readFileSync(jsPath, "utf8");
      if (/[?&]sync=/i.test(jsText)) {
        errors.push(
          `dist/assets/${path.basename(jsPath)} must never construct query-string "?sync=" links (use "#sync=" fragment only)`
        );
      }
    }
  }

  // 2. Discover fingerprinted concepts.<hash8>.json from dist/index.html and verify zero unrendered LaTeX
  let expectedConceptsJsonRel = null;
  let distConceptsJsonPath = null;
  const indexHtmlPath = path.join(outDir, "index.html");
  if (fs.existsSync(indexHtmlPath)) {
    const $idxCheck = cheerio.load(fs.readFileSync(indexHtmlPath, "utf8"));
    const rawConceptsAttr = ($idxCheck("body").attr("data-concepts-url") || "").trim();
    if (!rawConceptsAttr) {
      errors.push('dist/index.html: <body data-concepts-url="..."> is missing');
    } else {
      const resolvedConcepts = path.resolve(outDir, rawConceptsAttr);
      const relConcepts = path.relative(outDir, resolvedConcepts).split(path.sep).join("/");
      if (!/^assets\/concepts\.[0-9a-f]{8}\.json$/.test(relConcepts)) {
        errors.push(
          `dist/index.html: data-concepts-url="${rawConceptsAttr}" must point to fingerprinted assets/concepts.<hash8>.json (resolved: ${relConcepts})`
        );
      } else if (!fs.existsSync(resolvedConcepts) || fs.statSync(resolvedConcepts).size === 0) {
        errors.push(`Missing or empty fingerprinted concepts JSON: dist/${relConcepts}`);
      } else {
        expectedConceptsJsonRel = relConcepts;
        distConceptsJsonPath = resolvedConcepts;
      }
    }
  }

  if (distConceptsJsonPath && fs.existsSync(distConceptsJsonPath)) {
    const conceptsLabel = path.basename(distConceptsJsonPath);
    try {
      const compiledConcepts = JSON.parse(fs.readFileSync(distConceptsJsonPath, "utf8"));
      for (const c of rawConcepts) {
        if (c.priority != null && !VALID_PRIORITIES.has(c.priority)) {
          errors.push(`data/concepts.json#${c.id}: invalid priority "${c.priority}"`);
        }
        const entry = compiledConcepts[c.id];
        if (!entry) {
          errors.push(`dist/assets/${conceptsLabel} missing concept "${c.id}"`);
          continue;
        }
        if (!VALID_PRIORITIES.has(entry.priority)) {
          errors.push(
            `dist/assets/${conceptsLabel}#${c.id}: missing/invalid compiled priority "${entry.priority}"`
          );
        }
        if (entry.briefHtml) {
          const $b = cheerio.load(entry.briefHtml, null, false);
          errors.push(
            ...findUnrenderedMathInDom(
              $b,
              $b.root().contents().toArray(),
              `${conceptsLabel}#${c.id}.briefHtml`
            )
          );
        }
        if (entry.formulaHtml) {
          const $f = cheerio.load(entry.formulaHtml, null, false);
          errors.push(
            ...findUnrenderedMathInDom(
              $f,
              $f.root().contents().toArray(),
              `${conceptsLabel}#${c.id}.formulaHtml`
            )
          );
        }
        for (const [k, v] of Object.entries(entry)) {
          if (k === "briefHtml" || k === "formulaHtml") continue;
          if (typeof v === "string" && (v.includes("$$") || PAIRED_INLINE_DOLLAR_RE.test(v))) {
            errors.push(`dist/assets/${conceptsLabel}#${c.id}.${k} contains raw LaTeX: "${v.slice(0, 80)}"`);
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to parse dist/assets/${conceptsLabel}: ${err.message}`);
    }
  }

  // 3. Verify every sitemap page generated a non-empty HTML file
  const pagesDir = path.join(outDir, "pages");
  const allHtmlFiles = [];
  for (const rootHtml of ["index.html", "404.html"]) {
    const abs = path.join(outDir, rootHtml);
    if (fs.existsSync(abs)) allHtmlFiles.push(abs);
  }

  for (const pg of pages) {
    if (pg.priority != null && !VALID_PRIORITIES.has(pg.priority)) {
      errors.push(`data/sitemap.json: page "${pg.slug}" has invalid priority "${pg.priority}"`);
    }
    const htmlPath = path.join(pagesDir, `${pg.slug}.html`);
    if (!fs.existsSync(htmlPath)) {
      errors.push(`Missing generated page for sitemap entry "${pg.slug}": dist/pages/${pg.slug}.html`);
    } else if (fs.statSync(htmlPath).size === 0) {
      errors.push(`Generated page is empty: dist/pages/${pg.slug}.html`);
    } else {
      allHtmlFiles.push(htmlPath);
    }
  }

  if (fs.existsSync(pagesDir)) {
    for (const file of fs.readdirSync(pagesDir)) {
      if (!file.endsWith(".html")) continue;
      const slug = file.slice(0, -5);
      if (!expectedSlugs.has(slug)) {
        warnings.push(`Orphan HTML file in dist/pages/ not listed in sitemap.json: ${file}`);
      }
    }
  }

  // 4. Parse every generated HTML file once and index all IDs for fragment validation
  const parsedDocs = new Map();
  const idsByFile = new Map();

  for (const htmlFile of allHtmlFiles) {
    const rawHtml = fs.readFileSync(htmlFile, "utf8");
    const $ = cheerio.load(rawHtml);
    parsedDocs.set(htmlFile, { $, rawHtml, sizeBytes: Buffer.byteLength(rawHtml, "utf8") });

    const idSet = new Set();
    $("[id]").each((_, el) => {
      const id = $(el).attr("id");
      if (id) idSet.add(id);
    });
    idsByFile.set(htmlFile, idSet);
  }

  let totalLinksChecked = 0;
  let totalWords = 0;
  let totalConceptLinks = 0;
  let totalDisplayMath = 0;
  let totalInlineMath = 0;
  let totalSolutionBoxes = 0;
  let totalDetailBoxes = 0;
  let totalKeyPoints = 0;
  let totalAxiomaticViewsVerified = 0;
  let totalAxiomaticDisplayMath = 0;
  let totalAxiomaticInlineMath = 0;
  let totalAxiomaticConceptLinks = 0;
  let totalAxiomaticSolutionBoxes = 0;
  let totalAxiomaticDetailBoxes = 0;
  let totalAxiomaticKeyPoints = 0;
  const referencedViewFiles = new Set();
  const pageStats = [];

  // 5. Run full checks on every generated HTML file
  for (const htmlFile of allHtmlFiles) {
    const relFile = path.relative(outDir, htmlFile).split(path.sep).join("/");
    const { $, sizeBytes } = parsedDocs.get(htmlFile);

    // 5a. Zero unrendered LaTeX / .katex-error / literal **
    const bodyNodes = $("body").length ? $("body").contents().toArray() : $.root().contents().toArray();
    errors.push(...findUnrenderedMathInDom($, bodyNodes, relFile));

    // 5a-2. Fingerprinted CSS/JS/concepts, lazy KaTeX JS, cascade order, and explicit SVG dimensions
    if ($('script[src*="concepts-data.js"]').length > 0) {
      errors.push(
        `${relFile}: concepts-data.js must not be eagerly loaded via <script src>; use lazy concepts.<hash>.json fetch`
      );
    }
    if ($('script[src*="katex"]').length > 0) {
      errors.push(
        `${relFile}: KaTeX JS runtime must not be eagerly loaded via <script src>; load lazily via body[data-katex-js-url]`
      );
    }

    const stylesheetHrefs = [];
    $('link[rel="stylesheet"][href]').each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href || isExternalUrl(href)) return;
      const cleanHref = href.split(/[?#]/)[0];
      stylesheetHrefs.push(cleanHref);
      if (cleanHref.endsWith("/katex.min.css") || cleanHref === "katex.min.css") return;
      if (!/\.[0-9a-f]{8}\.css$/i.test(cleanHref)) {
        errors.push(`${relFile}: stylesheet "${href}" must be content-fingerprinted (.<hash8>.css)`);
      }
    });

    if (expectedFontsCssName) {
      const fontsIdx = stylesheetHrefs.findIndex(
        (h) => h.endsWith(`/${expectedFontsCssName}`) || h === expectedFontsCssName
      );
      const tokensIdx = stylesheetHrefs.findIndex((h) => /(?:^|\/)01-tokens\.[0-9a-f]{8}\.css$/i.test(h));
      if (fontsIdx === -1) {
        errors.push(`${relFile}: missing stylesheet link to ${expectedFontsCssName}`);
      } else if (tokensIdx !== -1 && fontsIdx > tokensIdx) {
        errors.push(`${relFile}: ${expectedFontsCssName} must load before 01-tokens.<hash8>.css`);
      }
    }

    // Verify optional extraStyles load strictly AFTER 04-mobile.<hash8>.css
    if (Array.isArray(config.paths.extraStyles) && config.paths.extraStyles.length > 0) {
      const mobileIdx = stylesheetHrefs.findIndex((h) => /(?:^|\/)04-mobile\.[0-9a-f]{8}\.css$/i.test(h));
      if (mobileIdx !== -1 && stylesheetHrefs.length <= mobileIdx + config.paths.extraStyles.length) {
        errors.push(
          `${relFile}: expected ${config.paths.extraStyles.length} extraStyles stylesheet(s) loaded after 04-mobile.<hash8>.css`
        );
      }
    }

    const scriptSrcs = $("script[src]")
      .map((_, el) => $(el).attr("src") || "")
      .get();
    for (const src of scriptSrcs) {
      const cleanSrc = src.trim().split(/[?#]/)[0];
      if (!cleanSrc || isExternalUrl(cleanSrc)) continue;
      if (!/\.[0-9a-f]{8}\.m?js$/i.test(cleanSrc)) {
        errors.push(`${relFile}: script "${src}" must be content-fingerprinted (.<hash8>.js)`);
      }
    }

    const appScriptIdx = scriptSrcs.findIndex((s) => /(?:^|\/)app\.[0-9a-f]{8}\.js(?:[?#]|$)/.test(s));
    const notebookScriptIdx = scriptSrcs.findIndex((s) =>
      /(?:^|\/)(?:\d+-)?notebook-sync\.[0-9a-f]{8}\.js(?:[?#]|$)/.test(s)
    );
    if (notebookScriptIdx !== -1 && (appScriptIdx === -1 || appScriptIdx > notebookScriptIdx)) {
      errors.push(
        `${relFile}: app.<hash8>.js must load before notebook-sync.<hash8>.js (found order: ${scriptSrcs.join(", ")})`
      );
    }

    // Explicit width & height on all non-KaTeX inline <svg> UI icons
    $("svg").each((_, el) => {
      const $svg = $(el);
      if ($svg.closest(".katex, .katex-display, .math-block, .math-inline-scroll").length > 0) return;
      const w = ($svg.attr("width") || "").trim();
      const h = ($svg.attr("height") || "").trim();
      if (!w || !h) {
        errors.push(
          `${relFile}: inline UI <svg> missing explicit width/height attribute(s)`
        );
      }
    });

    // 5a-3. Interactive UI, accessibility & config dataset checks (Home + Article pages)
    if (relFile === "index.html" || (relFile.startsWith("pages/") && relFile.endsWith(".html"))) {
      const $body = $("body");
      if (($body.attr("data-storage-prefix") || "").trim() !== config.storage.prefix) {
        errors.push(
          `${relFile}: <body data-storage-prefix> mismatch (got "${$body.attr("data-storage-prefix") || ""}", expected "${config.storage.prefix}")`
        );
      }
      if (($body.attr("data-theme-key") || "").trim() !== config.storage.themeKey) {
        errors.push(
          `${relFile}: <body data-theme-key> mismatch (got "${$body.attr("data-theme-key") || ""}", expected "${config.storage.themeKey}")`
        );
      }
      if (($body.attr("data-dual-mode") || "").trim() !== String(dualReadingStyle)) {
        errors.push(
          `${relFile}: <body data-dual-mode> mismatch (got "${$body.attr("data-dual-mode") || ""}", expected "${dualReadingStyle}")`
        );
      }
      if (($body.attr("data-font-theme-default") || "").trim() !== config.features.defaultFontTheme) {
        errors.push(
          `${relFile}: <body data-font-theme-default> mismatch (got "${$body.attr("data-font-theme-default") || ""}", expected "${config.features.defaultFontTheme}")`
        );
      }

      if (!dualReadingStyle) {
        if ($("[data-reading-style-btn]").length > 0) {
          errors.push(
            `${relFile}: dualReadingStyle=false must not render [data-reading-style-btn] toggle buttons`
          );
        }
        const headScripts = $("head script").text();
        if (headScripts.includes("readingStylePending")) {
          errors.push(
            `${relFile}: dualReadingStyle=false must not emit readingStylePending boot script in <head>`
          );
        }
      }

      if (expectedConceptsJsonRel) {
        const pageConceptsAttr = ($body.attr("data-concepts-url") || "").trim();
        const resolvedPageConcepts = path
          .relative(outDir, path.resolve(path.dirname(htmlFile), pageConceptsAttr))
          .split(path.sep)
          .join("/");
        if (resolvedPageConcepts !== expectedConceptsJsonRel) {
          errors.push(
            `${relFile}: data-concepts-url="${pageConceptsAttr}" resolves to "${resolvedPageConcepts}", expected "${expectedConceptsJsonRel}"`
          );
        }
      }

      if (expectedKatexJsRel) {
        const pageKatexAttr = ($body.attr("data-katex-js-url") || "").trim();
        if (!pageKatexAttr) {
          errors.push(`${relFile}: <body data-katex-js-url="..."> is missing`);
        } else if (pageKatexAttr.startsWith("/")) {
          errors.push(`${relFile}: data-katex-js-url="${pageKatexAttr}" must use relative path`);
        } else {
          const resolvedPageKatex = path
            .relative(outDir, path.resolve(path.dirname(htmlFile), pageKatexAttr))
            .split(path.sep)
            .join("/");
          if (resolvedPageKatex !== expectedKatexJsRel) {
            errors.push(
              `${relFile}: data-katex-js-url="${pageKatexAttr}" resolves to "${resolvedPageKatex}", expected "${expectedKatexJsRel}"`
            );
          }
        }
      }
      const idSet = idsByFile.get(htmlFile);
      const checkDialogAccessible = (selector, labelName) => {
        const $dlg = $(selector);
        if ($dlg.length === 0) {
          errors.push(`${relFile}: missing ${labelName} (${selector})`);
          return;
        }
        const ariaLabel = ($dlg.attr("aria-label") || "").trim();
        const ariaLabelledBy = ($dlg.attr("aria-labelledby") || "").trim();
        if (!ariaLabel && !ariaLabelledBy) {
          errors.push(`${relFile}: ${labelName} (${selector}) missing aria-label or aria-labelledby`);
        } else if (ariaLabelledBy && !ariaLabelledBy.split(/\s+/).every((refId) => idSet.has(refId))) {
          errors.push(
            `${relFile}: ${labelName} (${selector}) aria-labelledby="${ariaLabelledBy}" references missing id`
          );
        }
      };

      checkDialogAccessible("dialog#notebook-drawer", "Notebook drawer");
      checkDialogAccessible("dialog#sync-dialog", "Sync dialog");

      const $recallSave = $("#concept-popover button#recall-save-note");
      if ($recallSave.length === 0) {
        errors.push(`${relFile}: missing Concept Recall Card save button (#concept-popover button#recall-save-note)`);
      } else {
        if (($recallSave.attr("type") || "").toLowerCase() !== "button") {
          errors.push(`${relFile}: #recall-save-note must have type="button"`);
        }
        const saveLabel = ($recallSave.attr("aria-label") || $recallSave.text() || "").trim();
        if (!saveLabel) {
          errors.push(`${relFile}: #recall-save-note missing accessible text or aria-label`);
        }
      }

      if (relFile.startsWith("pages/")) {
        const $selBar = $("#selection-toolbar");
        if ($selBar.length === 0) {
          errors.push(`${relFile}: missing selection action bar (#selection-toolbar)`);
        } else {
          if ($selBar.attr("popover") !== "manual") {
            errors.push(`${relFile}: #selection-toolbar must have popover="manual"`);
          }
          if ($selBar.attr("role") !== "toolbar") {
            errors.push(`${relFile}: #selection-toolbar must have role="toolbar"`);
          }
          if (!($selBar.attr("aria-label") || "").trim()) {
            errors.push(`${relFile}: #selection-toolbar missing aria-label`);
          }
          if ($selBar.find('button[type="button"]').length < 2) {
            errors.push(
              `${relFile}: #selection-toolbar must contain at least 2 action buttons (quick-save & annotated-save)`
            );
          }
        }
      }
    }

    // 5b. Zero broken internal relative links (href / src)
    const linkEls = $("[href], [src]").toArray();
    for (const el of linkEls) {
      const $el = $(el);
      for (const attr of ["href", "src"]) {
        const rawVal = $el.attr(attr);
        if (rawVal == null) continue;
        const val = rawVal.trim();
        if (!val || isExternalUrl(val)) continue;

        totalLinksChecked++;

        if (val.startsWith("/")) {
          errors.push(`${relFile}: non-relative root-absolute ${attr}="${val}" (must use relative paths)`);
          continue;
        }

        if (val.startsWith("#")) {
          const frag = val.slice(1);
          if (!frag) continue;
          const idSet = idsByFile.get(htmlFile);
          let decoded = frag;
          try {
            decoded = decodeURIComponent(frag);
          } catch {}
          if (!idSet.has(frag) && !idSet.has(decoded)) {
            errors.push(`${relFile}: broken same-page fragment ${attr}="${val}"`);
          }
          continue;
        }

        const [withoutHash, hashPart] = val.split("#");
        const [pathPart] = withoutHash.split("?");
        let decodedPath = pathPart;
        try {
          decodedPath = decodeURIComponent(pathPart);
        } catch {}

        const resolved = path.resolve(path.dirname(htmlFile), decodedPath);
        const relToOut = path.relative(outDir, resolved);
        if (relToOut.startsWith("..") || path.isAbsolute(relToOut)) {
          errors.push(`${relFile}: ${attr}="${val}" escapes dist directory`);
          continue;
        }

        if (!fs.existsSync(resolved)) {
          errors.push(`${relFile}: broken internal link ${attr}="${val}" (missing ${relToOut})`);
          continue;
        }

        if (hashPart && resolved.endsWith(".html") && idsByFile.has(resolved)) {
          const targetIds = idsByFile.get(resolved);
          let decodedFrag = hashPart;
          try {
            decodedFrag = decodeURIComponent(hashPart);
          } catch {}
          if (!targetIds.has(hashPart) && !targetIds.has(decodedFrag)) {
            errors.push(`${relFile}: broken cross-page fragment ${attr}="${val}"`);
          }
        }
      }
    }

    // 5c. Micro-page specific checks (strict first-mention-only concept links & stats)
    if (relFile.startsWith("pages/") && relFile.endsWith(".html")) {
      const slug = path.basename(relFile, ".html");
      const $article = $("article").first();
      if ($article.length === 0) {
        errors.push(`${relFile}: missing <article> element`);
      }

      const $scope = $article.length ? $article : $("body");

      $scope.find("pre").each((_, preEl) => {
        const $code = $(preEl).children("code").first();
        const cls = ($code.attr("class") || "").trim();
        if (!/\blanguage-[A-Za-z0-9_-]+\b/.test(cls)) {
          errors.push(
            `${relFile}: accidental non-fenced <pre><code> block (missing language-* class): "${$(preEl)
              .text()
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 100)}"`
          );
        }
      });

      const $solutionBoxes = $scope.find("details.solution-box");
      totalSolutionBoxes += $solutionBoxes.length;
      $solutionBoxes.each((idx, boxEl) => {
        const $box = $(boxEl);
        const $summary = $box.children("summary").first();
        if ($summary.length === 0) {
          errors.push(`${relFile}: details.solution-box #${idx + 1} missing <summary> child`);
        } else {
          if ($summary.find("h1, h2, h3, h4, h5, h6").length > 0) {
            errors.push(`${relFile}: details.solution-box #${idx + 1} <summary> must not contain heading tags`);
          }
          if ($summary.find("a.concept-ref").length > 0) {
            errors.push(`${relFile}: details.solution-box #${idx + 1} <summary> must not contain .concept-ref links`);
          }
        }
        if ($box.children(".solution-body").length === 0) {
          errors.push(`${relFile}: details.solution-box #${idx + 1} missing .solution-body container`);
        }
      });

      const $detailBoxes = $scope.find("details.detail-box");
      totalDetailBoxes += $detailBoxes.length;
      $detailBoxes.each((idx, boxEl) => {
        const $box = $(boxEl);
        const $summary = $box.children("summary").first();
        if ($summary.length === 0) {
          errors.push(`${relFile}: details.detail-box #${idx + 1} missing <summary> child`);
        } else {
          if ($summary.find("h1, h2, h3, h4, h5, h6").length > 0) {
            errors.push(`${relFile}: details.detail-box #${idx + 1} <summary> must not contain heading tags`);
          }
          if ($summary.find("a.concept-ref").length > 0) {
            errors.push(`${relFile}: details.detail-box #${idx + 1} <summary> must not contain .concept-ref links`);
          }
        }
        if ($box.children(".detail-body").length === 0) {
          errors.push(`${relFile}: details.detail-box #${idx + 1} missing .detail-body container`);
        }
      });

      const $keyPoints = $scope.find("section.key-points");
      totalKeyPoints += $keyPoints.length;
      $keyPoints.each((idx, kpEl) => {
        const $kp = $(kpEl);
        if ($kp.children(".key-points-body").length === 0) {
          errors.push(`${relFile}: section.key-points #${idx + 1} missing .key-points-body container`);
        }
        if ($kp.children(".key-points-title").find("a.concept-ref").length > 0) {
          errors.push(`${relFile}: section.key-points #${idx + 1} .key-points-title must not contain .concept-ref links`);
        }
      });

      const seenConcepts = new Map();

      $scope.find("a.concept-ref[data-concept]").each((_, el) => {
        const $a = $(el);
        const cid = $a.attr("data-concept");
        if (!cid) {
          errors.push(`${relFile}: .concept-ref missing data-concept value`);
          return;
        }

        const count = (seenConcepts.get(cid) || 0) + 1;
        seenConcepts.set(cid, count);

        const concept = conceptsById.get(cid);
        if (!concept) {
          errors.push(`${relFile}: .concept-ref references unknown concept id "${cid}"`);
          return;
        }

        const selfPages = Array.isArray(concept.selfPages) ? concept.selfPages : [];
        if (concept.targetPage === slug || selfPages.includes(slug)) {
          errors.push(
            `${relFile}: self-link violation — concept "${cid}" (${concept.term}) linked on its own page "${slug}"`
          );
        }

        const expectedHref = `./${encodeURIComponent(concept.targetPage)}.html`;
        const actualHref = $a.attr("href");
        if (actualHref !== expectedHref && actualHref !== `./${concept.targetPage}.html`) {
          errors.push(`${relFile}: concept "${cid}" has href="${actualHref}", expected "${expectedHref}"`);
        }

        const badAncestor = checkForbiddenConceptAncestors($, el);
        if (badAncestor) {
          errors.push(`${relFile}: concept "${cid}" link illegally nested inside forbidden ancestor ${badAncestor}`);
        }
      });

      for (const [cid, count] of seenConcepts.entries()) {
        if (count > 1) {
          errors.push(
            `${relFile}: first-mention violation — data-concept="${cid}" appears ${count} times (max allowed: 1)`
          );
        }
      }

      const displayMathCount = $scope.find(".katex-display").length;
      const allKatexCount = $scope.find(".katex").length;
      const inlineMathCount = Math.max(0, allKatexCount - displayMathCount);
      const headingCount = $scope.find("h2, h3").length;
      const conceptLinkCount = seenConcepts.size;

      const $clone = $scope.clone();
      $clone.find(".katex-mathml, .heading-anchor, script, style").remove();
      const plainText = $clone.text();
      const words =
        (plainText.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length +
        (plainText.match(/[A-Za-z0-9]+/g) || []).length;

      totalWords += words;
      totalConceptLinks += conceptLinkCount;
      totalDisplayMath += displayMathCount;
      totalInlineMath += inlineMathCount;

      pageStats.push({
        slug,
        words,
        headings: headingCount,
        displayMath: displayMathCount,
        inlineMath: inlineMathCount,
        conceptLinks: conceptLinkCount,
        sizeKb: (sizeBytes / 1024).toFixed(1),
      });

      // 5d. Dual-mode vs Single-mode verification
      const rawAxiomaticUrl = ($("body").attr("data-axiomatic-url") || "").trim();
      if (!dualReadingStyle) {
        if (rawAxiomaticUrl) {
          errors.push(
            `${relFile}: dualReadingStyle=false must not emit <body data-axiomatic-url="..."> (got "${rawAxiomaticUrl}")`
          );
        }
      } else {
        const defaultStyleAttr = ($("body").attr("data-reading-style-default") || "").trim();
        if (defaultStyleAttr !== config.features.defaultReadingStyle) {
          errors.push(
            `${relFile}: <body data-reading-style-default="..."> must be "${config.features.defaultReadingStyle}" (got "${defaultStyleAttr}")`
          );
        }

        if (!rawAxiomaticUrl) {
          errors.push(`${relFile}: missing <body data-axiomatic-url="..."> for dual-mode switching`);
        } else if (rawAxiomaticUrl.startsWith("/")) {
          errors.push(`${relFile}: data-axiomatic-url="${rawAxiomaticUrl}" must use relative path`);
        } else {
          const resolvedViewPath = path.resolve(path.dirname(htmlFile), rawAxiomaticUrl);
          const relView = path.relative(outDir, resolvedViewPath).split(path.sep).join("/");
          const expectedViewRe = new RegExp(
            `^assets/views/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.axiomatic\\.[0-9a-f]{8}\\.json$`
          );
          if (!expectedViewRe.test(relView)) {
            errors.push(
              `${relFile}: data-axiomatic-url="${rawAxiomaticUrl}" must resolve to fingerprinted assets/views/${slug}.axiomatic.<hash8>.json (got "${relView}")`
            );
          } else if (!fs.existsSync(resolvedViewPath) || fs.statSync(resolvedViewPath).size === 0) {
            errors.push(`${relFile}: missing or empty axiomatic view JSON: dist/${relView}`);
          } else {
            referencedViewFiles.add(path.basename(resolvedViewPath));
            const viewLabel = `views/${path.basename(resolvedViewPath)}`;
            try {
              const viewJson = JSON.parse(fs.readFileSync(resolvedViewPath, "utf8"));
              if (viewJson.slug !== slug) {
                errors.push(`${viewLabel}: slug="${viewJson.slug}" does not match "${slug}"`);
              }
              if (viewJson.style !== "axiomatic") {
                errors.push(`${viewLabel}: style="${viewJson.style}" must be "axiomatic"`);
              }
              if (typeof viewJson.html !== "string" || !viewJson.html.trim()) {
                errors.push(`${viewLabel}: html must be a non-empty string`);
              } else {
                totalAxiomaticViewsVerified++;
                const $v = cheerio.load(`<article>${viewJson.html}</article>`, null, false);
                const $vArticle = $v("article").first();

                errors.push(...findUnrenderedMathInDom($v, $vArticle.contents().toArray(), viewLabel));

                $vArticle.find("pre").each((_, preEl) => {
                  const $code = $v(preEl).children("code").first();
                  const cls = ($code.attr("class") || "").trim();
                  if (!/\blanguage-[A-Za-z0-9_-]+\b/.test(cls)) {
                    errors.push(
                      `${viewLabel}: accidental non-fenced <pre><code> block: "${$v(preEl).text().trim().replace(/\s+/g, " ").slice(0, 100)}"`
                    );
                  }
                });

                const $vBoxes = $vArticle.find("details.solution-box");
                totalAxiomaticSolutionBoxes += $vBoxes.length;
                $vBoxes.each((idx, boxEl) => {
                  const $box = $v(boxEl);
                  const $summary = $box.children("summary").first();
                  if ($summary.length === 0) {
                    errors.push(`${viewLabel}: details.solution-box #${idx + 1} missing <summary>`);
                  } else {
                    if ($summary.find("h1, h2, h3, h4, h5, h6").length > 0) {
                      errors.push(`${viewLabel}: details.solution-box #${idx + 1} <summary> must not contain headings`);
                    }
                    if ($summary.find("a.concept-ref").length > 0) {
                      errors.push(`${viewLabel}: details.solution-box #${idx + 1} <summary> must not contain .concept-ref`);
                    }
                  }
                  if ($box.children(".solution-body").length === 0) {
                    errors.push(`${viewLabel}: details.solution-box #${idx + 1} missing .solution-body`);
                  }
                });

                const $vDetails = $vArticle.find("details.detail-box");
                totalAxiomaticDetailBoxes += $vDetails.length;
                $vDetails.each((idx, boxEl) => {
                  const $box = $v(boxEl);
                  const $summary = $box.children("summary").first();
                  if ($summary.length === 0) {
                    errors.push(`${viewLabel}: details.detail-box #${idx + 1} missing <summary>`);
                  } else {
                    if ($summary.find("h1, h2, h3, h4, h5, h6").length > 0) {
                      errors.push(`${viewLabel}: details.detail-box #${idx + 1} <summary> must not contain headings`);
                    }
                    if ($summary.find("a.concept-ref").length > 0) {
                      errors.push(`${viewLabel}: details.detail-box #${idx + 1} <summary> must not contain .concept-ref`);
                    }
                  }
                  if ($box.children(".detail-body").length === 0) {
                    errors.push(`${viewLabel}: details.detail-box #${idx + 1} missing .detail-body`);
                  }
                });

                const $vKeys = $vArticle.find("section.key-points");
                totalAxiomaticKeyPoints += $vKeys.length;
                $vKeys.each((idx, kpEl) => {
                  const $kp = $v(kpEl);
                  if ($kp.children(".key-points-body").length === 0) {
                    errors.push(`${viewLabel}: section.key-points #${idx + 1} missing .key-points-body`);
                  }
                  if ($kp.children(".key-points-title").find("a.concept-ref").length > 0) {
                    errors.push(`${viewLabel}: section.key-points #${idx + 1} .key-points-title must not contain .concept-ref`);
                  }
                });

                const viewIds = new Set();
                $vArticle.find("[id]").each((_, el) => {
                  const id = $v(el).attr("id");
                  if (id) viewIds.add(id);
                });
                if (!Array.isArray(viewJson.headings)) {
                  errors.push(`${viewLabel}: headings must be an array`);
                } else {
                  for (const h of viewJson.headings) {
                    if (!h?.id || !viewIds.has(h.id)) {
                      errors.push(`${viewLabel}: heading id "${h?.id}" not found in rendered view html`);
                    }
                  }
                }

                $vArticle.find("[href], [src]").each((_, el) => {
                  const $el = $v(el);
                  for (const attr of ["href", "src"]) {
                    const rawVal = $el.attr(attr);
                    if (rawVal == null) continue;
                    const val = rawVal.trim();
                    if (!val || isExternalUrl(val)) continue;
                    totalLinksChecked++;
                    if (val.startsWith("/")) {
                      errors.push(`${viewLabel}: non-relative root-absolute ${attr}="${val}"`);
                      continue;
                    }
                    if (val.startsWith("#")) {
                      const frag = val.slice(1);
                      if (frag && !viewIds.has(frag)) {
                        let decoded = frag;
                        try {
                          decoded = decodeURIComponent(frag);
                        } catch {}
                        if (!viewIds.has(decoded)) {
                          errors.push(`${viewLabel}: broken same-view fragment ${attr}="${val}"`);
                        }
                      }
                      continue;
                    }
                    const [withoutHash, hashPart] = val.split("#");
                    const [pathPart] = withoutHash.split("?");
                    let decodedPath = pathPart;
                    try {
                      decodedPath = decodeURIComponent(pathPart);
                    } catch {}
                    const resolvedTarget = path.resolve(path.dirname(htmlFile), decodedPath);
                    const relToOut = path.relative(outDir, resolvedTarget);
                    if (
                      relToOut.startsWith("..") ||
                      path.isAbsolute(relToOut) ||
                      !fs.existsSync(resolvedTarget)
                    ) {
                      errors.push(`${viewLabel}: broken internal link ${attr}="${val}"`);
                    } else if (hashPart && resolvedTarget.endsWith(".html") && idsByFile.has(resolvedTarget)) {
                      const targetIds = idsByFile.get(resolvedTarget);
                      let decodedFrag = hashPart;
                      try {
                        decodedFrag = decodeURIComponent(hashPart);
                      } catch {}
                      if (!targetIds.has(hashPart) && !targetIds.has(decodedFrag)) {
                        errors.push(`${viewLabel}: broken cross-page fragment ${attr}="${val}"`);
                      }
                    }
                  }
                });

                const vSeenConcepts = new Map();
                $vArticle.find("a.concept-ref[data-concept]").each((_, el) => {
                  const $a = $v(el);
                  const cid = $a.attr("data-concept");
                  if (!cid) {
                    errors.push(`${viewLabel}: .concept-ref missing data-concept`);
                    return;
                  }
                  vSeenConcepts.set(cid, (vSeenConcepts.get(cid) || 0) + 1);
                  const concept = conceptsById.get(cid);
                  if (!concept) {
                    errors.push(`${viewLabel}: unknown concept id "${cid}"`);
                    return;
                  }
                  const selfPages = Array.isArray(concept.selfPages) ? concept.selfPages : [];
                  if (concept.targetPage === slug || selfPages.includes(slug)) {
                    errors.push(`${viewLabel}: self-link violation for concept "${cid}" on "${slug}"`);
                  }
                  const expectedHref = `./${encodeURIComponent(concept.targetPage)}.html`;
                  const actualHref = $a.attr("href");
                  if (actualHref !== expectedHref && actualHref !== `./${concept.targetPage}.html`) {
                    errors.push(`${viewLabel}: concept "${cid}" href="${actualHref}", expected "${expectedHref}"`);
                  }
                  const badAncestor = checkForbiddenConceptAncestors($v, el);
                  if (badAncestor) {
                    errors.push(`${viewLabel}: concept "${cid}" illegally nested inside ${badAncestor}`);
                  }
                });
                for (const [cid, count] of vSeenConcepts.entries()) {
                  if (count > 1) {
                    errors.push(
                      `${viewLabel}: first-mention violation — data-concept="${cid}" appears ${count} times`
                    );
                  }
                }
                if (viewJson.referencedConceptCount !== vSeenConcepts.size) {
                  errors.push(
                    `${viewLabel}: referencedConceptCount (${viewJson.referencedConceptCount}) !== actual links (${vSeenConcepts.size})`
                  );
                }
                if (typeof viewJson.wordCount !== "number" || viewJson.wordCount <= 0) {
                  errors.push(`${viewLabel}: invalid wordCount (${viewJson.wordCount})`);
                }
                if (typeof viewJson.readMinutes !== "number" || viewJson.readMinutes < 2) {
                  errors.push(`${viewLabel}: invalid readMinutes (${viewJson.readMinutes})`);
                }

                const vDisplay = $vArticle.find(".katex-display").length;
                const vAll = $vArticle.find(".katex").length;
                totalAxiomaticDisplayMath += vDisplay;
                totalAxiomaticInlineMath += Math.max(0, vAll - vDisplay);
                totalAxiomaticConceptLinks += vSeenConcepts.size;
              }
            } catch (err) {
              errors.push(`${viewLabel}: failed to parse JSON (${err.message})`);
            }
          }
        }
      }
    }
  }

  // Check dist/assets/views/ (no views in single-mode; no orphans in dual-mode)
  const viewsDir = path.join(outDir, "assets", "views");
  if (!dualReadingStyle) {
    if (fs.existsSync(viewsDir) && fs.readdirSync(viewsDir).length > 0) {
      errors.push("dualReadingStyle=false must not generate JSON files inside dist/assets/views/");
    }
  } else if (fs.existsSync(viewsDir)) {
    for (const file of fs.readdirSync(viewsDir)) {
      if (!referencedViewFiles.has(file)) {
        warnings.push(`Orphan view file in dist/assets/views/ not referenced by any page: ${file}`);
      }
    }
  }

  // Print concise QA report
  console.log("\n=== Build Verification Report ===");
  console.log(
    `${"Slug".padEnd(34)} ${"Words".padStart(6)} ${"H2/H3".padStart(6)} ${"Math(D/I)".padStart(11)} ${"Concepts".padStart(9)} ${"Size".padStart(8)}`
  );
  console.log("-".repeat(79));
  for (const st of pageStats) {
    const mathCol = `${st.displayMath}/${st.inlineMath}`;
    console.log(
      `${st.slug.slice(0, 34).padEnd(34)} ${String(st.words).padStart(6)} ${String(st.headings).padStart(6)} ${mathCol.padStart(11)} ${String(st.conceptLinks).padStart(9)} ${(st.sizeKb + "KB").padStart(8)}`
    );
  }
  const coreCount = pages.filter((p) => p.priority === "core").length;
  const highCount = pages.filter((p) => p.priority === "high").length;
  const normalCount = pages.length - coreCount - highCount;

  console.log("-".repeat(79));
  console.log(
    `Summary (${dualReadingStyle ? "explained SSR" : "single-mode SSR"}): ${pageStats.length}/${pages.length} pages (core:${coreCount} high:${highCount} normal:${normalCount}) | ` +
      `${totalWords} words | ${totalDisplayMath} display + ${totalInlineMath} inline math | ` +
      `${totalSolutionBoxes} solution / ${totalDetailBoxes} detail / ${totalKeyPoints} key blocks | ` +
      `${totalConceptLinks} first-mention concept links | ${totalLinksChecked} internal links checked`
  );
  if (dualReadingStyle) {
    console.log(
      `Summary (axiomatic views): ${totalAxiomaticViewsVerified}/${pages.length} JSON views verified | ` +
        `${totalAxiomaticDisplayMath} display + ${totalAxiomaticInlineMath} inline math | ` +
        `${totalAxiomaticSolutionBoxes} solution / ${totalAxiomaticDetailBoxes} detail / ${totalAxiomaticKeyPoints} key blocks | ` +
        `${totalAxiomaticConceptLinks} first-mention concept links`
    );
  }
  if (forbidEmDash || dualReadingStyle) {
    console.log(
      `Style audit (${forbidEmDash ? "forbidEmDash=true" : "forbidEmDash=false"}): ${styleStats.filesAudited} files | ` +
        `em-dash "——": ${styleStats.emDash} | contrast: ${styleStats.contrast} | ` +
        `cliche: ${styleStats.cliche} | meta-preview: ${styleStats.metaPreview}`
    );
  }
  console.log(
    `Webfonts & headers: ${fontStats.cssFileName || "(missing)"} | ` +
      `${fontStats.verifiedWoff2} woff2 verified (wOF2, ${(fontStats.totalFontBytes / (1024 * 1024)).toFixed(2)}MB, ` +
      `${fontStats.orphanFonts} orphans) | _headers: ${fontStats.assetsCheckedForHeaders} assets checked`
  );

  if (warnings.length > 0) {
    console.warn(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.warn(`  [WARN] ${w}`);
  }

  if (errors.length > 0) {
    console.error(`\nFAILED with ${errors.length} error(s):`);
    for (const e of errors.slice(0, 50)) console.error(`  [ERR] ${e}`);
    if (errors.length > 50) {
      console.error(`  ... and ${errors.length - 50} more error(s).`);
    }
    return { ok: false, errors, warnings, pageStats };
  }

  console.log("\n[verify] PASS — 0 errors across all QA gates.");
  return { ok: true, errors, warnings, pageStats };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const result = runVerify(parseCliArgs(process.argv.slice(2)));
  if (!result.ok) {
    process.exit(1);
  }
}
