import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import katex from "katex";
import * as cheerio from "cheerio";
import { loadSiteConfig } from "../src/config.mjs";
import { buildConceptMatcher, injectConcepts } from "./inject-concepts.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");

function resolvePackageDir(pkgName) {
  try {
    return path.dirname(require.resolve(`${pkgName}/package.json`));
  } catch (err) {
    throw new Error(
      `Missing required package "${pkgName}" (${err.message}). Run npm install first.`
    );
  }
}

const md = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
  typographer: false,
});

/**
 * Custom markdown-it block containers for structured study notes:
 *   :::solution [Optional Summary Title]  -> <details class="solution-box">
 *   :::hint [Optional Summary Title]      -> <details class="solution-box solution-hint">
 *   :::key [Optional Title]               -> <section class="key-points"> (always visible)
 *   :::proof [Optional Summary Title]     -> <details class="detail-box detail-proof">
 *   :::detail [Optional Summary Title]    -> <details class="detail-box">
 */
const CONTAINER_OPEN_RE = /^(:{3,})\s*(solution|hint|key|proof|detail)(?:\s+(.*))?$/i;

md.block.ruler.before("fence", "solution_container", (state, startLine, endLine, silent) => {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const maxPos = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;

  const firstLine = state.src.slice(startPos, maxPos).trim();
  const openMatch = firstLine.match(CONTAINER_OPEN_RE);
  if (!openMatch) return false;

  const markerLen = openMatch[1].length;
  const kind = openMatch[2].toLowerCase();
  const rawTitle = (openMatch[3] || "").trim();

  // Scan forward for matching closing `:::` line (ignoring nested fenced code blocks & nested containers)
  let nextLine = startLine + 1;
  let foundClose = false;
  let depth = 0;
  let inCodeFence = false;
  let codeFenceChar = "";
  let codeFenceLen = 0;

  while (nextLine < endLine) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineEnd = state.eMarks[nextLine];
    const lineText = state.src.slice(lineStart, lineEnd);
    const trimmed = lineText.trim();

    const codeMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (inCodeFence) {
      if (
        codeMatch &&
        codeMatch[1][0] === codeFenceChar &&
        codeMatch[1].length >= codeFenceLen &&
        codeMatch[2].trim() === ""
      ) {
        inCodeFence = false;
      }
      nextLine++;
      continue;
    } else if (codeMatch && !(codeMatch[1][0] === "`" && codeMatch[2].includes("`"))) {
      inCodeFence = true;
      codeFenceChar = codeMatch[1][0];
      codeFenceLen = codeMatch[1].length;
      nextLine++;
      continue;
    }

    if (state.sCount[nextLine] - state.blkIndent < 4) {
      if (CONTAINER_OPEN_RE.test(trimmed)) {
        depth++;
        nextLine++;
        continue;
      }
      if (trimmed.length >= markerLen && /^:+$/.test(trimmed)) {
        if (depth > 0) {
          depth--;
          nextLine++;
          continue;
        }
        foundClose = true;
        break;
      }
    }
    nextLine++;
  }

  // Require an explicit closing fence so unclosed containers are caught by verify-build
  if (!foundClose) return false;
  if (silent) return true;

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = "container";
  state.lineMax = nextLine;

  const tag = kind === "key" ? "section" : "details";
  let defaultTitle = "";
  if (kind === "solution") defaultTitle = "查看参考解答";
  else if (kind === "hint") defaultTitle = "查看解题提示";
  else if (kind === "proof") defaultTitle = "展开完整证明";
  else if (kind === "detail") defaultTitle = "展开详细推导";

  const openToken = state.push("solution_open", tag, 1);
  openToken.markup = openMatch[1];
  openToken.block = true;
  openToken.map = [startLine, nextLine + 1];
  openToken.meta = {
    kind,
    title: rawTitle || defaultTitle,
  };

  state.md.block.tokenize(state, startLine + 1, nextLine);

  const closeToken = state.push("solution_close", tag, -1);
  closeToken.markup = openMatch[1];
  closeToken.block = true;
  closeToken.meta = { kind };

  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.line = nextLine + 1;
  return true;
});

md.renderer.rules.solution_open = (tokens, idx) => {
  const { kind, title } = tokens[idx].meta || { kind: "solution", title: "查看参考解答" };
  const titleHtml = title ? md.renderInline(title) : "";

  if (kind === "key") {
    const titleBlock = titleHtml
      ? `<div class="key-points-title">${titleHtml}</div>\n`
      : "";
    return `<section class="key-points">\n${titleBlock}<div class="key-points-body">\n`;
  }

  if (kind === "proof" || kind === "detail") {
    const extraClass = kind === "proof" ? " detail-proof" : "";
    return (
      `<details class="detail-box${extraClass}">\n` +
      `<summary class="detail-summary"><span class="detail-summary-label">${titleHtml}</span></summary>\n` +
      `<div class="detail-body">\n`
    );
  }

  const extraClass = kind === "hint" ? " solution-hint" : "";
  return (
    `<details class="solution-box${extraClass}">\n` +
    `<summary class="solution-summary"><span class="solution-summary-label">${titleHtml}</span></summary>\n` +
    `<div class="solution-body">\n`
  );
};

md.renderer.rules.solution_close = (tokens, idx) => {
  const kind = tokens[idx]?.meta?.kind || "solution";
  if (kind === "key") {
    return "\n</div>\n</section>\n";
  }
  return "\n</div>\n</details>\n";
};

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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function stripLeadingFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx === -1) return normalized;
  const afterClose = endIdx + 4;
  if (afterClose < normalized.length && normalized[afterClose] !== "\n") {
    return normalized;
  }
  const block = normalized.slice(4, endIdx);
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 0 && lines.every((l) => /^[A-Za-z0-9_-]+\s*:/.test(l) || /^\s+[-*]?\s*/.test(l))) {
    return normalized.slice(afterClose).replace(/^\n+/, "");
  }
  return normalized;
}

function lineNumberAt(str, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < str.length; i++) {
    if (str[i] === "\n") line++;
  }
  return line;
}

function renderKatexStrict(tex, displayMode, sourceLabel, lineNo) {
  const trimmed = tex.trim();
  if (!trimmed) return "";
  try {
    return katex.renderToString(trimmed, {
      displayMode,
      throwOnError: true,
      strict: "warn",
      trust: false,
    });
  } catch (err) {
    const loc = lineNo ? `${sourceLabel}:${lineNo}` : sourceLabel;
    throw new Error(
      `KaTeX render failed (${displayMode ? "display" : "inline"}) at ${loc}\n` +
        `  LaTeX: ${trimmed.slice(0, 200)}\n` +
        `  Error: ${err.message}`
    );
  }
}

/**
 * Sequential Markdown-aware math scanner.
 * Protects fenced code blocks, inline code spans, and escaped `\$`, while
 * extracting `$$...$$` display math, `$...$` inline math, and exact `` `$...$` ``
 * math-quote spans into punctuation-free alphanumeric placeholders before markdown-it runs.
 */
function extractMathPlaceholders(markdown, { sourceLabel = "<unknown>", allowBlock = true } = {}) {
  const s = markdown.replace(/\r\n?/g, "\n");
  const len = s.length;
  const placeholders = new Map();
  let nextId = 0;
  let out = "";

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  let i = 0;
  let atLineStart = true;

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
          fenceChar = "";
          fenceLen = 0;
        }
        out += rawLine;
        if (lineEnd !== -1) {
          out += "\n";
          i = lineEnd + 1;
          atLineStart = true;
        } else {
          i = len;
        }
        continue;
      } else if (fenceMatch) {
        const marker = fenceMatch[1];
        const info = fenceMatch[2];
        if (!(marker[0] === "`" && info.includes("`"))) {
          inFence = true;
          fenceChar = marker[0];
          fenceLen = marker.length;
          out += rawLine;
          if (lineEnd !== -1) {
            out += "\n";
            i = lineEnd + 1;
            atLineStart = true;
          } else {
            i = len;
          }
          continue;
        }
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

    if (ch === "\\" && i + 1 < len) {
      const next = s[i + 1];
      if (next === "\\" || next === "$" || next === "`") {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
    }

    // Inline code spans (1+ backticks)
    if (ch === "`") {
      let tickCount = 1;
      while (i + tickCount < len && s[i + tickCount] === "`") tickCount++;
      const delim = "`".repeat(tickCount);

      let searchPos = i + tickCount;
      let closeIdx = -1;
      while (searchPos < len) {
        const found = s.indexOf(delim, searchPos);
        if (found === -1) break;
        const beforeOk = found === 0 || s[found - 1] !== "`";
        const afterOk = found + tickCount >= len || s[found + tickCount] !== "`";
        if (beforeOk && afterOk) {
          closeIdx = found;
          break;
        }
        searchPos = found + 1;
      }

      if (closeIdx !== -1) {
        const codeInner = s.slice(i + tickCount, closeIdx);
        if (
          tickCount === 1 &&
          codeInner.length >= 3 &&
          codeInner.startsWith("$") &&
          codeInner.endsWith("$") &&
          !codeInner.startsWith("$$") &&
          !codeInner.includes("\n") &&
          !codeInner.slice(1, -1).includes("$")
        ) {
          const tex = codeInner.slice(1, -1);
          const rendered = renderKatexStrict(tex, false, sourceLabel, lineNumberAt(s, i));
          const token = `XMATHQUOTE${nextId++}X`;
          placeholders.set(token, {
            kind: "quote",
            html: `<code class="math-quote">${rendered}</code>`,
          });
          out += token;
        } else {
          out += s.slice(i, closeIdx + tickCount);
        }
        i = closeIdx + tickCount;
        continue;
      } else {
        out += delim;
        i += tickCount;
        continue;
      }
    }

    // Display math: $$...$$
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

      if (closeIdx === -1) {
        throw new Error(`Unclosed display math "$$" at ${sourceLabel}:${lineNumberAt(s, i)}`);
      }

      const rawTex = s.slice(i + 2, closeIdx);
      const cleanedTex = rawTex.replace(/^(?:[ \t]*>[ \t]?)+/gm, "").trim();
      const rendered = renderKatexStrict(cleanedTex, true, sourceLabel, lineNumberAt(s, i));

      if (allowBlock) {
        const idx = nextId++;
        const token = `XMATHBLOCK${idx}X`;
        placeholders.set(token, {
          kind: "block",
          idx,
          html: `<div class="math-block" role="region" aria-label="数学公式" tabindex="0">${rendered}</div>`,
        });
        out += token;
      } else {
        const idx = nextId++;
        const token = `XMATHINLINE${idx}X`;
        placeholders.set(token, {
          kind: "inline",
          html: rendered,
        });
        out += token;
      }

      i = closeIdx + 2;
      continue;
    }

    // Inline math: $...$ (single-line)
    if (ch === "$") {
      let j = i + 1;
      let closeIdx = -1;
      while (j < len && s[j] !== "\n") {
        if (s[j] === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (s[j] === "$") {
          if (j > i + 1) {
            closeIdx = j;
          }
          break;
        }
        j++;
      }

      if (closeIdx !== -1) {
        const tex = s.slice(i + 1, closeIdx);
        const rendered = renderKatexStrict(tex, false, sourceLabel, lineNumberAt(s, i));
        const token = `XMATHINLINE${nextId++}X`;
        placeholders.set(token, {
          kind: "inline",
          html: rendered,
        });
        out += token;
        i = closeIdx + 1;
        continue;
      }

      out += "$";
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return { text: out, placeholders };
}

function classifyCallout(labelText) {
  const label = labelText.replace(/[：:]\s*$/, "").trim();
  if (!label) return null;

  if (/勘误|严谨性/.test(label)) return "errata";
  if (/高频考点|核心考点|考点|重要结论/.test(label)) return "exam";
  if (/易错|避坑|警告|切勿|注意|易混/.test(label)) return "warn";
  if (/解题套路|解题方法|思路点评|做题技巧|方法总结|技巧|证明思路|实战推论|直觉升华/.test(label)) {
    return "tip";
  }
  if (
    /篇目定位|本讲定位|本讲导学|课程总览|卷面结构|作答要求|符号约定|符号对照|记号提醒|术语提醒|特别说明|讲义范围|PPT未讲|本部分|原题|拓展题干|片尾说明|说明|^注$|总结|提示|导学|约定|下一步主线|进阶直达|速查表|提醒/.test(
      label
    )
  ) {
    return "note";
  }
  return null;
}

function normalizeCjkBoldLine(line) {
  if (!line.includes("**")) return line;

  const saved = [];
  let protectedLine = "";
  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = line[i];
    if (
      ch === "\\" &&
      i + 1 < len &&
      (line[i + 1] === "*" || line[i + 1] === "\\" || line[i + 1] === "`")
    ) {
      const token = `XBOLDSAFE${saved.length}X`;
      saved.push(line.slice(i, i + 2));
      protectedLine += token;
      i += 2;
      continue;
    }

    if (ch === "`") {
      let tickCount = 1;
      while (i + tickCount < len && line[i + tickCount] === "`") tickCount++;
      const delim = "`".repeat(tickCount);
      let searchPos = i + tickCount;
      let closeIdx = -1;
      while (searchPos < len) {
        const found = line.indexOf(delim, searchPos);
        if (found === -1) break;
        const beforeOk = found === 0 || line[found - 1] !== "`";
        const afterOk = found + tickCount >= len || line[found + tickCount] !== "`";
        if (beforeOk && afterOk) {
          closeIdx = found;
          break;
        }
        searchPos = found + 1;
      }
      if (closeIdx !== -1) {
        const token = `XBOLDSAFE${saved.length}X`;
        saved.push(line.slice(i, closeIdx + tickCount));
        protectedLine += token;
        i = closeIdx + tickCount;
        continue;
      }
    }

    protectedLine += ch;
    i++;
  }

  const replaced = protectedLine.replace(
    /(?<!\*)\*\*(?![*\s])((?:[^*\n]|(?<!\*)\*(?!\*))+?)(?<![*\s])\*\*(?!\*)/g,
    "<strong>$1</strong>"
  );

  if (saved.length === 0) return replaced;
  return replaced.replace(/XBOLDSAFE(\d+)X/g, (_, idxStr) => saved[Number(idxStr)]);
}

function normalizeCjkBold(markdown) {
  if (!markdown.includes("**")) return markdown;
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^(?:[ \t]*>[ \t]?)*[ ]{0,3}(`{3,}|~{3,})(.*)$/);
      if (inFence) {
        if (
          fenceMatch &&
          fenceMatch[1][0] === fenceChar &&
          fenceMatch[1].length >= fenceLen &&
          fenceMatch[2].trim() === ""
        ) {
          inFence = false;
          fenceChar = "";
          fenceLen = 0;
        }
        return line;
      } else if (fenceMatch) {
        const marker = fenceMatch[1];
        const info = fenceMatch[2];
        if (!(marker[0] === "`" && info.includes("`"))) {
          inFence = true;
          fenceChar = marker[0];
          fenceLen = marker.length;
          return line;
        }
      }
      return normalizeCjkBoldLine(line);
    })
    .join("\n");
}

/**
 * Render inline markdown + inline KaTeX (used for concept brief tooltips).
 */
export function renderInlineWithMath(text, sourceLabel = "concepts.json") {
  if (!text) return "";
  const { text: tokenized, placeholders } = extractMathPlaceholders(String(text), {
    sourceLabel,
    allowBlock: false,
  });

  let html = md.renderInline(normalizeCjkBold(tokenized));
  html = html.replace(/\n/g, "<br>");

  html = html.replace(/XMATH(?:INLINE|QUOTE)\d+X/g, (token) => {
    const entry = placeholders.get(token);
    return entry ? entry.html : token;
  });

  return html;
}

/**
 * Render full micro-page Markdown to semantic, mobile-ready HTML with:
 * - Build-time KaTeX math (.math-block & inline .katex)
 * - Semantic <aside class="callout callout-*"> blocks
 * - Responsive .table-wrap regions around every <table>
 * - Deterministic heading IDs (sec-1, sec-2, ...) + .heading-anchor + extracted TOC list
 */
export function renderMarkdownPage(markdown, { sourceLabel = "<page>", pageTitle = "" } = {}) {
  const cleanedMd = stripLeadingFrontmatter(markdown);
  const { text: tokenized, placeholders } = extractMathPlaceholders(cleanedMd, {
    sourceLabel,
    allowBlock: true,
  });

  let html = md.render(normalizeCjkBold(tokenized));

  const blockMap = new Map();
  html = html.replace(/XMATH(INLINE|QUOTE|BLOCK)(\d+)X/g, (token, kind, idStr) => {
    const entry = placeholders.get(token);
    if (!entry) return token;
    if (kind === "BLOCK") {
      blockMap.set(idStr, entry.html);
      return `<span data-math-block="${idStr}"></span>`;
    }
    return entry.html;
  });

  const $ = cheerio.load(html, null, false);

  // 1. Replace block math markers cleanly without ever nesting <div> inside <p>
  $("span[data-math-block]").each((_, el) => {
    const $marker = $(el);
    const id = $marker.attr("data-math-block");
    const blockHtml = blockMap.get(id);
    if (!blockHtml) return;

    const $parent = $marker.parent();
    if ($parent.length && $parent[0].type === "tag" && $parent[0].name.toLowerCase() === "p") {
      return;
    }
    $marker.replaceWith(blockHtml);
  });

  $("p").each((_, pEl) => {
    const $p = $(pEl);
    if ($p.find("span[data-math-block]").length === 0) return;

    const fragments = [];
    let currentNodes = [];

    const flushParagraph = () => {
      const nonEmpty = currentNodes.some(
        (node) => !(node.type === "text" && (!node.data || !node.data.trim()))
      );
      if (nonEmpty) {
        const $newP = $("<p></p>");
        for (const n of currentNodes) {
          $newP.append($(n));
        }
        fragments.push($.html($newP));
      }
      currentNodes = [];
    };

    for (const child of $p.contents().toArray()) {
      if (
        child.type === "tag" &&
        child.name.toLowerCase() === "span" &&
        child.attribs &&
        "data-math-block" in child.attribs
      ) {
        flushParagraph();
        const blockHtml = blockMap.get(child.attribs["data-math-block"]);
        if (blockHtml) fragments.push(blockHtml);
      } else {
        currentNodes.push(child);
      }
    }
    flushParagraph();

    $p.replaceWith(fragments.join("\n"));
  });

  $("span[data-math-block]").each((_, el) => {
    const id = $(el).attr("data-math-block");
    const blockHtml = blockMap.get(id);
    if (blockHtml) $(el).replaceWith(blockHtml);
  });

  // 2. Ensure single H1 on page (layout.mjs renders the page's <h1> from page.title)
  const $h1s = $("h1");
  if ($h1s.length === 1) {
    const firstEl = $.root()
      .children()
      .toArray()
      .find((n) => n.type === "tag");
    if (firstEl === $h1s[0]) {
      $h1s.first().remove();
    } else {
      $h1s.first().replaceWith(`<h2>${$h1s.first().html()}</h2>`);
    }
  } else if ($h1s.length > 1) {
    $h1s.each((_, el) => {
      $(el).replaceWith(`<h2>${$(el).html()}</h2>`);
    });
  }

  // 3. Transform callout blockquotes into semantic <aside class="callout callout-*">
  const blockquotes = $("blockquote").toArray().reverse();
  for (const bq of blockquotes) {
    const $bq = $(bq);
    const firstChildEl = $bq
      .children()
      .toArray()
      .find((n) => n.type === "tag");
    if (!firstChildEl || firstChildEl.name.toLowerCase() !== "p") continue;

    const $firstP = $(firstChildEl);
    const firstMeaningfulNode = $firstP
      .contents()
      .toArray()
      .find((n) => !(n.type === "text" && (!n.data || !n.data.trim())));

    if (
      !firstMeaningfulNode ||
      firstMeaningfulNode.type !== "tag" ||
      firstMeaningfulNode.name.toLowerCase() !== "strong"
    ) {
      continue;
    }

    const $strong = $(firstMeaningfulNode);
    const labelText = $strong.text().trim();
    const calloutType = classifyCallout(labelText);
    if (!calloutType) continue;

    const cleanTitleHtml = ($strong.html() || "").replace(/[：:]\s*$/, "").trim();

    const nextNode = firstMeaningfulNode.next;
    $strong.remove();
    if (nextNode && nextNode.type === "text" && nextNode.data) {
      nextNode.data = nextNode.data.replace(/^\s*[：:]\s*/, "");
    }

    const remainingText = $firstP.text().trim();
    const remainingTags = $firstP.children().length;
    if (!remainingText && remainingTags === 0) {
      $firstP.remove();
    }

    const bodyHtml = ($bq.html() || "").trim();
    $bq.replaceWith(
      `<aside class="callout callout-${calloutType}" data-callout="${calloutType}">\n` +
        `<div class="callout-title">${cleanTitleHtml}</div>\n` +
        `<div class="callout-body">${bodyHtml}</div>\n` +
        `</aside>`
    );
  }

  // 4. Wrap every <table> in a scrollable accessible region
  $("table").each((_, tableEl) => {
    const $table = $(tableEl);
    if ($table.parent().hasClass("table-wrap")) return;
    $table.wrap(
      '<div class="table-wrap" role="region" aria-label="数据表格" tabindex="0"></div>'
    );
  });

  // 4b. Wrap oversized unbreakable inline KaTeX (.katex-html > .base >= 24 visible chars)
  $(".katex").each((_, el) => {
    const $k = $(el);
    if ($k.closest(".katex-display, .math-block, .math-inline-scroll").length) return;
    const bases = $k.find(".katex-html > .base").toArray();
    let maxBaseLen = 0;
    for (const b of bases) {
      const len = $(b).text().replace(/[\s\u200b]/g, "").length;
      if (len > maxBaseLen) maxBaseLen = len;
    }
    if (maxBaseLen >= 24) {
      $k.wrap('<span class="math-inline-scroll"></span>');
    }
  });

  // 4c. Normalize any raw HTML <details class="solution-box"> and <details class="detail-box"> blocks
  $("details.solution-box").each((_, el) => {
    const $details = $(el);
    let $summary = $details.children("summary").first();
    if ($summary.length === 0) {
      $summary = $(
        '<summary class="solution-summary"><span class="solution-summary-label">查看参考解答</span></summary>'
      );
      $details.prepend($summary);
    } else {
      if (!$summary.hasClass("solution-summary")) $summary.addClass("solution-summary");
      if ($summary.children(".solution-summary-label").length === 0) {
        $summary.html(
          `<span class="solution-summary-label">${($summary.html() || "").trim() || "查看参考解答"}</span>`
        );
      }
    }

    if ($details.children(".solution-body").length === 0) {
      const bodyNodes = $details
        .contents()
        .toArray()
        .filter((n) => n !== $summary[0]);
      const $body = $('<div class="solution-body"></div>');
      for (const n of bodyNodes) {
        $body.append($(n));
      }
      $details.append($body);
    }
  });

  $("details.detail-box").each((_, el) => {
    const $details = $(el);
    const defaultLabel = $details.hasClass("detail-proof") ? "展开完整证明" : "展开详细推导";
    let $summary = $details.children("summary").first();
    if ($summary.length === 0) {
      $summary = $(
        `<summary class="detail-summary"><span class="detail-summary-label">${defaultLabel}</span></summary>`
      );
      $details.prepend($summary);
    } else {
      if (!$summary.hasClass("detail-summary")) $summary.addClass("detail-summary");
      if ($summary.children(".detail-summary-label").length === 0) {
        $summary.html(
          `<span class="detail-summary-label">${($summary.html() || "").trim() || defaultLabel}</span>`
        );
      }
    }

    if ($details.children(".detail-body").length === 0) {
      const bodyNodes = $details
        .contents()
        .toArray()
        .filter((n) => n !== $summary[0]);
      const $body = $('<div class="detail-body"></div>');
      for (const n of bodyNodes) {
        $body.append($(n));
      }
      $details.append($body);
    }
  });

  // 5. Assign deterministic IDs to h2/h3/h4, add .heading-anchor, and collect on-page TOC headings
  const headings = [];
  let headingCounter = 0;

  $("h2, h3, h4").each((_, el) => {
    const $h = $(el);
    const level = Number(el.name.slice(1));
    headingCounter++;
    const id = `sec-${headingCounter}`;
    $h.attr("id", id);

    const $clone = $h.clone();
    $clone.find(".katex-mathml, .heading-anchor").remove();
    const cleanText = $clone.text().replace(/\s+/g, " ").trim();
    const innerHtml = ($h.html() || "").trim();

    $h.html(
      `<span class="heading-text">${innerHtml}</span>` +
        `<a class="heading-anchor" href="#${id}" aria-label="本节链接">#</a>`
    );

    const insideCollapsed = $h.closest("details.solution-box, details.detail-box").length > 0;
    if ((level === 2 || level === 3) && !insideCollapsed) {
      headings.push({
        level,
        id,
        text: cleanText,
        html: innerHtml,
      });
    }
  });

  // 6. Compute readable word count (CJK characters + alphanumeric words, excluding MathML duplicates)
  const $textClone = cheerio.load($.html(), null, false);
  $textClone(".katex-mathml, .heading-anchor").remove();
  const plainText = $textClone.root().text();
  const cjkChars = (plainText.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latinWords = (plainText.match(/[A-Za-z0-9]+/g) || []).length;
  const wordCount = cjkChars + latinWords;

  return {
    html: $.html(),
    headings,
    wordCount,
    pageTitle,
  };
}

function normalizePriority(val) {
  return val === "core" || val === "high" || val === "normal" ? val : "normal";
}

function normalizeHomeworkRefs(refs) {
  return Array.isArray(refs)
    ? refs
        .filter(Boolean)
        .map((r) => String(r).trim())
        .filter(Boolean)
    : [];
}

/**
 * Normalize sitemap.json into a canonical 3-level hierarchy (parts -> chapters -> pages)
 * and a flat ordered pages list, enriched with site metadata from `site.config.json`.
 */
function normalizeSitemap(rawSitemap, config) {
  const rawOverview = rawSitemap.examOverview || null;
  const cfgGroupLabels = config.examOverview?.groupLabels || {};
  const examOverview = rawOverview
    ? {
        ...rawOverview,
        groupLabels: {
          ...cfgGroupLabels,
          ...(rawOverview.groupLabels && typeof rawOverview.groupLabels === "object"
            ? rawOverview.groupLabels
            : {}),
        },
      }
    : null;

  const siteMeta = {
    title: config.site.title,
    shortTitle: config.site.shortTitle,
    subtitle: config.site.subtitle,
    description: config.site.description,
    brandMark: config.site.brandMark,
    heroBadge: config.site.heroBadge,
    footerNote: config.site.footerNote,
    exportPrefix: config.site.exportPrefix,
    lang: config.site.lang,
    examOverview,
  };

  const rawParts = Array.isArray(rawSitemap.parts) ? rawSitemap.parts : [];
  const hasNestedChapters = rawParts.some((p) => Array.isArray(p.chapters));

  const normalizePageEntry = (pg, partId, chapterId) => ({
    ...pg,
    id: pg.id || pg.slug,
    slug: pg.slug || pg.id,
    shortTitle: pg.shortTitle || pg.title,
    summary: pg.summary || "",
    readMinutes: Number(pg.readMinutes) || 3,
    priority: normalizePriority(pg.priority),
    examTag: typeof pg.examTag === "string" ? pg.examTag.trim() : "",
    homeworkRefs: normalizeHomeworkRefs(pg.homeworkRefs),
    partId: pg.partId || partId,
    chapterId: pg.chapterId || chapterId,
    definesConcepts: Array.isArray(pg.definesConcepts) ? pg.definesConcepts : [],
  });

  let treeParts;
  if (hasNestedChapters) {
    treeParts = rawParts.map((part, pIdx) => {
      const pId = part.id || `part-${pIdx + 1}`;
      const chapters = (part.chapters || []).map((ch, cIdx) => {
        const cId = ch.id || `${pId}-ch-${cIdx + 1}`;
        return {
          id: cId,
          partId: ch.partId || pId,
          title: ch.title || "",
          shortTitle: ch.shortTitle || ch.title || "",
          lectureRef: ch.lectureRef || "",
          priority: ch.priority ? normalizePriority(ch.priority) : undefined,
          examTag: typeof ch.examTag === "string" ? ch.examTag.trim() : "",
          order: ch.order ?? cIdx + 1,
          pages: (ch.pages || []).map((pg) => normalizePageEntry(pg, pId, cId)),
        };
      });
      const partPages = chapters.flatMap((c) => c.pages);
      return {
        id: pId,
        code: part.code || `Part ${pIdx + 1}`,
        title: part.title || "",
        shortTitle: part.shortTitle || part.title || "",
        summary: part.summary || part.description || "",
        description: part.description || part.summary || "",
        kind: part.kind || "",
        priority: part.priority ? normalizePriority(part.priority) : undefined,
        examTag: typeof part.examTag === "string" ? part.examTag.trim() : "",
        order: part.order ?? pIdx + 1,
        pageCount: partPages.length,
        coreCount: partPages.filter((p) => p.priority === "core").length,
        highCount: partPages.filter((p) => p.priority === "high").length,
        chapters,
      };
    });
  } else {
    const rawChapters = Array.isArray(rawSitemap.chapters) ? rawSitemap.chapters : [];
    const rawPages = Array.isArray(rawSitemap.pages) ? rawSitemap.pages : [];
    treeParts = rawParts.map((part, pIdx) => {
      const pId = part.id || `part-${pIdx + 1}`;
      const chs = rawChapters
        .filter((c) => c.partId === pId)
        .map((ch, cIdx) => {
          const cId = ch.id || `${pId}-ch-${cIdx + 1}`;
          const pgs = rawPages
            .filter((pg) => pg.chapterId === cId)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((pg) => normalizePageEntry(pg, pId, cId));
          return {
            id: cId,
            partId: pId,
            title: ch.title || "",
            shortTitle: ch.shortTitle || ch.title || "",
            lectureRef: ch.lectureRef || "",
            priority: ch.priority ? normalizePriority(ch.priority) : undefined,
            examTag: typeof ch.examTag === "string" ? ch.examTag.trim() : "",
            order: ch.order ?? cIdx + 1,
            pages: pgs,
          };
        });
      const partPages = chs.flatMap((c) => c.pages);
      return {
        id: pId,
        code: part.code || `Part ${pIdx + 1}`,
        title: part.title || "",
        shortTitle: part.shortTitle || part.title || "",
        summary: part.summary || part.description || "",
        description: part.description || part.summary || "",
        kind: part.kind || "",
        priority: part.priority ? normalizePriority(part.priority) : undefined,
        examTag: typeof part.examTag === "string" ? part.examTag.trim() : "",
        order: part.order ?? pIdx + 1,
        pageCount: partPages.length,
        coreCount: partPages.filter((p) => p.priority === "core").length,
        highCount: partPages.filter((p) => p.priority === "high").length,
        chapters: chs,
      };
    });
  }

  const flatPages = [];
  for (const part of treeParts) {
    for (const chapter of part.chapters) {
      for (const pg of chapter.pages) {
        flatPages.push({
          ...pg,
          part: {
            id: part.id,
            code: part.code,
            title: part.title,
            shortTitle: part.shortTitle,
            summary: part.summary,
            kind: part.kind,
            order: part.order,
          },
          chapter: {
            id: chapter.id,
            title: chapter.title,
            shortTitle: chapter.shortTitle,
            lectureRef: chapter.lectureRef,
            order: chapter.order,
          },
        });
      }
    }
  }

  flatPages.forEach((pg, idx) => {
    pg.index = idx;
    if (pg.order == null) pg.order = idx + 1;
  });

  const totalReadMinutes = flatPages.reduce((sum, p) => sum + (p.readMinutes || 0), 0);
  const corePages = flatPages.filter((p) => p.priority === "core").length;
  const highPages = flatPages.filter((p) => p.priority === "high").length;

  return {
    site: {
      ...siteMeta,
      totalPages: flatPages.length,
      corePages,
      highPages,
      totalReadMinutes,
    },
    examOverview,
    treeParts,
    flatPages,
  };
}

function buildTreeWithHrefs(treeParts, pageBase) {
  const prefix = pageBase.endsWith("/") ? pageBase : `${pageBase}/`;
  return treeParts.map((part) => ({
    id: part.id,
    code: part.code,
    title: part.title,
    shortTitle: part.shortTitle,
    summary: part.summary,
    description: part.description,
    kind: part.kind,
    priority: part.priority,
    examTag: part.examTag,
    order: part.order,
    pageCount: part.pageCount,
    coreCount: part.coreCount,
    highCount: part.highCount,
    chapters: part.chapters.map((ch) => ({
      id: ch.id,
      partId: ch.partId,
      title: ch.title,
      shortTitle: ch.shortTitle,
      lectureRef: ch.lectureRef,
      priority: ch.priority,
      examTag: ch.examTag,
      order: ch.order,
      pages: ch.pages.map((pg) => ({
        id: pg.id,
        slug: pg.slug,
        title: pg.title,
        shortTitle: pg.shortTitle,
        summary: pg.summary,
        readMinutes: pg.readMinutes,
        priority: pg.priority,
        examTag: pg.examTag,
        homeworkRefs: pg.homeworkRefs,
        order: pg.order,
        href: `${prefix}${encodeURIComponent(pg.slug)}.html`,
        partId: pg.partId,
        chapterId: pg.chapterId,
        definesConcepts: pg.definesConcepts,
      })),
    })),
  }));
}

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  const entries = fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDirRecursive(srcPath, destPath));
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(destPath);
    }
  }
  return copied;
}

function defaultNotFoundHtml(ctx) {
  const styles = (ctx.assets?.styles || [])
    .map((s) => `<link rel="stylesheet" href="${escapeHtml(ctx.assetBase + s)}">`)
    .join("\n  ");
  const defaultFontTheme = ctx.config?.features?.defaultFontTheme || "serif";
  return `<!DOCTYPE html>
<html lang="${escapeHtml(ctx.site?.lang || "zh-CN")}" data-font-theme="${escapeHtml(defaultFontTheme)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>页面未找到 · ${escapeHtml(ctx.site?.title || "课程讲义站")}</title>
  ${styles}
</head>
<body class="page-404">
  <main style="max-width: 42rem; margin: 12vh auto; padding: 2rem; text-align: center;">
    <h1 style="font-size: 2rem; margin-bottom: 0.75rem;">404 · 页面未找到</h1>
    <p style="margin-bottom: 1.5rem; opacity: 0.85;">你访问的笔记小节可能已移动或链接有误。</p>
    <p><a href="${escapeHtml(ctx.homeHref)}" style="text-decoration: underline;">返回课程总目录 →</a></p>
  </main>
</body>
</html>
`;
}

function shortHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
}

const WEBFONT_BUNDLES = [
  {
    id: "source-serif-4",
    pkgName: "@fontsource-variable/source-serif-4",
    cssFiles: ["wght.css", "wght-italic.css"],
    family: "Source Serif 4",
    outSubdir: "source-serif-4",
    fileFilter: (name) => /^source-serif-4-latin(?:-ext)?-wght-(?:normal|italic)\.woff2$/.test(name),
  },
  {
    id: "noto-serif-sc",
    pkgName: "@fontsource-variable/noto-serif-sc",
    cssFiles: ["wght.css"],
    family: "Noto Serif SC",
    outSubdir: "noto-serif-sc",
    fileFilter: (name) => /^noto-serif-sc-\d+-wght-normal\.woff2$/.test(name),
  },
  {
    id: "lxgw-wenkai",
    pkgName: "lxgw-wenkai-screen-webfont",
    cssFiles: ["lxgwwenkaigbscreen.css"],
    family: "LXGW WenKai Screen",
    outSubdir: "lxgw-wenkai",
    fileFilter: (name) => /^lxgwwenkaigbscreen-subset-\d+\.woff2$/.test(name),
  },
];

function assertValidWoff2(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    if (bytesRead < 4 || header.toString("ascii") !== "wOF2") {
      throw new Error(`Invalid WOFF2 magic header in ${filePath}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseFontFaceBlock(block) {
  const inner = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
  const props = {};
  for (const rawDecl of inner.split(";")) {
    const decl = rawDecl.trim();
    if (!decl) continue;
    const colonIdx = decl.indexOf(":");
    if (colonIdx === -1) continue;
    const key = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();
    if (key && val) props[key] = val;
  }
  const srcVal = props.src || "";
  const urlMatch = srcVal.match(/url\(\s*(['"]?)([^)'"]+\.woff2)\1\s*\)/i);
  return {
    fontStyle: props["font-style"] || "normal",
    fontWeight: props["font-weight"] || "400",
    unicodeRange: props["unicode-range"] || "",
    woff2Url: urlMatch ? urlMatch[2].trim() : "",
  };
}

/**
 * Extract selected `.woff2` unicode-range slices from self-hosted open-source webfont
 * packages resolved via Node module resolution (npm-hoisting compatible), copy ONLY
 * referenced slices to `dist/assets/fonts/<subdir>/`, rewrite `@font-face` rules with
 * standardized family names + `font-display: swap`, and emit `dist/assets/00-fonts.<hash8>.css`.
 */
export function bundleWebfonts(outDir) {
  const fontsRoot = path.join(outDir, "assets", "fonts");
  fs.mkdirSync(fontsRoot, { recursive: true });

  const cssSections = [
    "/* Self-hosted open-source reading webfonts (build-generated; zero external CDN)\n" +
      "   - Source Serif 4 (OFL-1.1, Latin/Latin-Ext variable 200..900 normal + italic)\n" +
      "   - Noto Serif SC (OFL-1.1, CJK variable 200..900 unicode-range slices)\n" +
      "   - LXGW WenKai Screen GB (MIT, CJK 400 unicode-range slices) */",
  ];

  const bundleStats = [];
  let totalSlices = 0;
  let totalBytes = 0;

  for (const spec of WEBFONT_BUNDLES) {
    const pkgDir = resolvePackageDir(spec.pkgName);
    const destSubdir = path.join(fontsRoot, spec.outSubdir);
    fs.mkdirSync(destSubdir, { recursive: true });

    const copiedFiles = new Set();
    const stylesSet = new Set();
    const weightsSet = new Set();
    let familySlices = 0;
    let familyBytes = 0;
    const familyRules = [];

    for (const cssFile of spec.cssFiles) {
      const cssPath = path.join(pkgDir, cssFile);
      if (!fs.existsSync(cssPath)) {
        throw new Error(`Missing webfont stylesheet: ${cssPath}`);
      }
      const cssText = fs.readFileSync(cssPath, "utf8");
      const blocks = cssText.match(/@font-face\s*\{[^}]*\}/g) || [];

      for (const block of blocks) {
        const parsed = parseFontFaceBlock(block);
        if (!parsed.woff2Url) continue;
        const srcFilePath = path.resolve(path.dirname(cssPath), parsed.woff2Url);
        const basename = path.basename(srcFilePath);
        if (!spec.fileFilter(basename)) continue;

        if (!fs.existsSync(srcFilePath)) {
          throw new Error(`Missing webfont slice referenced by ${cssPath}: ${parsed.woff2Url}`);
        }
        assertValidWoff2(srcFilePath);

        if (!copiedFiles.has(basename)) {
          const destFilePath = path.join(destSubdir, basename);
          fs.copyFileSync(srcFilePath, destFilePath);
          const sz = fs.statSync(destFilePath).size;
          copiedFiles.add(basename);
          familyBytes += sz;
          totalBytes += sz;
        }

        familySlices++;
        totalSlices++;
        stylesSet.add(parsed.fontStyle);
        weightsSet.add(parsed.fontWeight);

        const compactRange = parsed.unicodeRange ? parsed.unicodeRange.replace(/\s*,\s*/g, ",") : "";
        const decls = [
          `font-family:"${spec.family}"`,
          `font-style:${parsed.fontStyle}`,
          `font-weight:${parsed.fontWeight}`,
          `font-display:swap`,
          `src:url("./fonts/${spec.outSubdir}/${basename}") format("woff2")`,
        ];
        if (compactRange) {
          decls.push(`unicode-range:${compactRange}`);
        }
        familyRules.push(`@font-face{${decls.join(";")};}`);
      }
    }

    if (familySlices === 0) {
      throw new Error(`Webfont bundle "${spec.id}" (${spec.family}) matched 0 .woff2 slices.`);
    }

    cssSections.push(`/* ${spec.family} (${familySlices} slices) */\n${familyRules.join("\n")}`);
    bundleStats.push({
      id: spec.id,
      family: spec.family,
      outSubdir: spec.outSubdir,
      styles: [...stylesSet],
      weights: [...weightsSet],
      slices: familySlices,
      uniqueFiles: copiedFiles.size,
      bytes: familyBytes,
    });
  }

  const combinedCss = `${cssSections.join("\n\n")}\n`;
  const cssHash = shortHash(combinedCss);
  const cssFileName = `00-fonts.${cssHash}.css`;
  const cssRel = `assets/${cssFileName}`;
  fs.writeFileSync(path.join(outDir, cssRel), combinedCss, "utf8");

  return {
    cssRel,
    cssFileName,
    cssBytes: Buffer.byteLength(combinedCss, "utf8"),
    bundles: bundleStats,
    totalSlices,
    totalBytes,
  };
}

function copyAssetsFingerprinted(srcDir, destDir, hashExts = new Set(), { skipDirs = new Set() } = {}) {
  if (!fs.existsSync(srcDir)) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const results = [];
  const entries = fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      copyDirRecursive(srcPath, path.join(destDir, entry.name));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (hashExts.has(ext)) {
        const buf = fs.readFileSync(srcPath);
        const hash = shortHash(buf);
        const stem = entry.name.slice(0, -ext.length);
        const hashedName = `${stem}.${hash}${ext}`;
        const destPath = path.join(destDir, hashedName);
        fs.writeFileSync(destPath, buf);
        results.push({ origName: entry.name, hashedName, destPath });
      } else {
        const destPath = path.join(destDir, entry.name);
        fs.copyFileSync(srcPath, destPath);
        results.push({ origName: entry.name, hashedName: entry.name, destPath });
      }
    }
  }
  return results;
}

function copyReferencedStyleFonts(stylesDir, copiedCssEntries, outAssetsDir) {
  const srcFontsRoot = path.join(stylesDir, "fonts");
  if (!fs.existsSync(srcFontsRoot)) return [];
  const copied = [];
  const seenRel = new Set();

  for (const entry of copiedCssEntries) {
    if (!entry.origName.endsWith(".css")) continue;
    const cssText = fs.readFileSync(entry.destPath, "utf8");
    for (const m of cssText.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)) {
      const target = m[2].trim();
      if (!target || /^(?:data:|https?:|#)/i.test(target)) continue;
      const cleanTarget = target.split(/[?#]/)[0];
      const srcCandidate = path.resolve(stylesDir, cleanTarget);
      const relToFonts = path.relative(srcFontsRoot, srcCandidate);
      if (relToFonts.startsWith("..") || path.isAbsolute(relToFonts)) continue;
      if (!fs.existsSync(srcCandidate) || !fs.statSync(srcCandidate).isFile()) continue;

      const normRel = relToFonts.split(path.sep).join("/");
      if (seenRel.has(normRel)) continue;
      seenRel.add(normRel);

      if (normRel.endsWith(".woff2")) {
        assertValidWoff2(srcCandidate);
      }
      const destPath = path.join(outAssetsDir, "fonts", relToFonts);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcCandidate, destPath);
      copied.push({ relPath: normRel, destPath, bytes: fs.statSync(destPath).size });
    }
  }
  return copied;
}

function copyExtraStylesheets(rootDir, extraStyles, outAssetsDir, existingNames) {
  const emitted = [];
  for (let i = 0; i < extraStyles.length; i++) {
    const relSpec = extraStyles[i];
    const absSrc = path.resolve(rootDir, relSpec);
    if (!fs.existsSync(absSrc) || !fs.statSync(absSrc).isFile()) {
      throw new Error(`Missing extraStyles CSS file specified in site.config.json: ${relSpec}`);
    }
    const buf = fs.readFileSync(absSrc);
    const hash = shortHash(buf);
    const ext = path.extname(absSrc) || ".css";
    const rawStem = path.basename(absSrc, ext).replace(/[^A-Za-z0-9_-]+/g, "-") || `custom-${i + 1}`;
    let hashedName = `${rawStem}.${hash}${ext}`;
    if (existingNames.has(hashedName)) {
      hashedName = `extra-${i + 1}-${rawStem}.${hash}${ext}`;
    }
    existingNames.add(hashedName);
    const destPath = path.join(outAssetsDir, hashedName);
    fs.writeFileSync(destPath, buf);
    emitted.push(`assets/${hashedName}`);
  }
  return emitted;
}

function generateHeadersFile({ dualReadingStyle = true } = {}) {
  const viewsSection = dualReadingStyle
    ? `\n/assets/views/*\n  Cache-Control: public, max-age=31536000, immutable\n`
    : "";

  return `# Static asset caching and baseline security headers for Cloudflare Pages / Workers Static Assets
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/katex/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/assets/katex/*.js
  Cache-Control: public, max-age=31536000, immutable

/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/assets/*.css
  Cache-Control: public, max-age=31536000, immutable

/assets/concepts.*.json
  Cache-Control: public, max-age=31536000, immutable
${viewsSection}
/assets/app.*.js
  Cache-Control: public, max-age=31536000, immutable

/assets/notebook-sync.*.js
  Cache-Control: public, max-age=31536000, immutable

/assets/concepts-data.js
  Cache-Control: public, max-age=0, must-revalidate
`;
}

export async function runBuild(cliOpts = {}) {
  const startTime = Date.now();
  const rootDir = path.resolve(cliOpts.root || process.cwd());

  // First load raw config to locate dataDir, then re-normalize with sitemap fallbacks
  const initialConfig = loadSiteConfig(rootDir, { configPath: cliOpts.config || null });

  const dataDir = path.resolve(rootDir, cliOpts["data-dir"] || initialConfig.paths.dataDir);
  const contentDir = path.resolve(rootDir, cliOpts["content-dir"] || initialConfig.paths.contentDir);
  const explainedDir = path.resolve(
    rootDir,
    cliOpts["explained-dir"] || initialConfig.paths.explainedDir
  );
  const outDir = path.resolve(rootDir, cliOpts["out-dir"] || initialConfig.paths.outDir);
  const allowMissingExplained = Boolean(cliOpts["allow-missing-explained"]);

  // Templates, base styles, and client JS live in the notes-site-base package itself
  const templatesDir = path.resolve(
    cliOpts["templates-dir"] || path.join(PACKAGE_ROOT, "src", "templates")
  );
  const stylesDir = path.resolve(cliOpts["styles-dir"] || path.join(PACKAGE_ROOT, "src", "styles"));
  const clientDir = path.resolve(cliOpts["client-dir"] || path.join(PACKAGE_ROOT, "src", "client"));

  const sitemapPath = path.join(dataDir, "sitemap.json");
  const conceptsPath = path.join(dataDir, "concepts.json");

  if (!fs.existsSync(sitemapPath)) {
    throw new Error(`Missing sitemap file: ${sitemapPath}`);
  }
  if (!fs.existsSync(conceptsPath)) {
    throw new Error(`Missing concepts file: ${conceptsPath}`);
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

  const { site, examOverview, treeParts, flatPages } = normalizeSitemap(rawSitemap, config);
  site.totalConcepts = rawConcepts.length;

  const pageBySlug = new Map(flatPages.map((p) => [p.slug, p]));

  // Compile concepts with build-time KaTeX rendering
  const compiledConceptMap = {};
  const compiledConceptList = [];

  for (const c of rawConcepts) {
    if (!c.id || !c.term) {
      throw new Error(`Invalid concept entry missing id or term: ${JSON.stringify(c)}`);
    }
    const targetPg = pageBySlug.get(c.targetPage);
    if (!targetPg) {
      throw new Error(
        `Concept "${c.id}" (${c.term}) references unknown targetPage "${c.targetPage}" not found in sitemap.json`
      );
    }

    const briefHtml = renderInlineWithMath(c.brief || "", `concepts.json#${c.id}.brief`);
    let formulaHtml = "";
    if (c.formula && String(c.formula).trim()) {
      const cleanFormula = String(c.formula)
        .trim()
        .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
        .replace(/^\$([\s\S]*)\$$/, "$1")
        .trim();
      formulaHtml = renderKatexStrict(cleanFormula, true, `concepts.json#${c.id}.formula`, 0);
    }

    const compiled = {
      id: c.id,
      term: c.term,
      category: c.category || targetPg.chapter?.shortTitle || "",
      priority: normalizePriority(c.priority),
      examTag: typeof c.examTag === "string" ? c.examTag.trim() : "",
      briefHtml,
      formulaHtml,
      targetPage: c.targetPage,
      targetPageTitle: targetPg.title,
    };

    compiledConceptMap[c.id] = compiled;
    compiledConceptList.push({
      ...compiled,
      targetHref: `./pages/${encodeURIComponent(c.targetPage)}.html`,
    });
  }

  const conceptMatcher = buildConceptMatcher(rawConcepts, config.concepts);
  for (const w of conceptMatcher.warnings) {
    console.warn(`[concepts warn] ${w}`);
  }

  // Load templates dynamically from notes-site-base (or custom override)
  const layoutTemplatePath = path.join(templatesDir, "layout.mjs");
  const homeTemplatePath = path.join(templatesDir, "home.mjs");
  if (!fs.existsSync(layoutTemplatePath)) {
    throw new Error(`Missing template file: ${layoutTemplatePath}`);
  }
  if (!fs.existsSync(homeTemplatePath)) {
    throw new Error(`Missing template file: ${homeTemplatePath}`);
  }

  const layoutMod = await import(pathToFileURL(layoutTemplatePath).href);
  const homeMod = await import(pathToFileURL(homeTemplatePath).href);
  if (typeof layoutMod.renderPage !== "function") {
    throw new Error(`Template ${layoutTemplatePath} must export renderPage(ctx)`);
  }
  if (typeof homeMod.renderHome !== "function") {
    throw new Error(`Template ${homeTemplatePath} must export renderHome(ctx)`);
  }

  // Prepare clean dist directory
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "assets", "katex", "fonts"), { recursive: true });
  if (dualReadingStyle) {
    fs.mkdirSync(path.join(outDir, "assets", "views"), { recursive: true });
  }

  // Copy KaTeX stylesheet, fonts, and fingerprinted lazy JS runtime (NOT eagerly loaded in <head>)
  const katexPkgDir = resolvePackageDir("katex");
  const katexDistDir = path.join(katexPkgDir, "dist");
  const katexCssSrc = path.join(katexDistDir, "katex.min.css");
  const katexJsSrc = path.join(katexDistDir, "katex.min.js");
  if (!fs.existsSync(katexCssSrc)) {
    throw new Error(`Missing KaTeX CSS at ${katexCssSrc}. Run npm install first.`);
  }
  if (!fs.existsSync(katexJsSrc)) {
    throw new Error(`Missing KaTeX JS runtime at ${katexJsSrc}. Run npm install first.`);
  }
  fs.copyFileSync(katexCssSrc, path.join(outDir, "assets", "katex", "katex.min.css"));
  const katexJsBuf = fs.readFileSync(katexJsSrc);
  const katexJsHash = shortHash(katexJsBuf);
  const katexJsRel = `assets/katex/katex.min.${katexJsHash}.js`;
  fs.writeFileSync(path.join(outDir, katexJsRel), katexJsBuf);
  copyDirRecursive(
    path.join(katexDistDir, "fonts"),
    path.join(outDir, "assets", "katex", "fonts")
  );

  // Bundle self-hosted open-source reading webfonts into dist/assets/00-fonts.<hash8>.css
  const webfontBundle = bundleWebfonts(outDir);

  // Copy base styles with SHA-256 8-hex fingerprinting + referenced fonts (e.g. Inter)
  const stylesAssetList = ["assets/katex/katex.min.css", webfontBundle.cssRel];
  const outAssetsDir = path.join(outDir, "assets");
  const copiedStyles = copyAssetsFingerprinted(stylesDir, outAssetsDir, new Set([".css"]), {
    skipDirs: new Set(["fonts"]),
  });
  const copiedLocalFonts = copyReferencedStyleFonts(stylesDir, copiedStyles, outAssetsDir);

  const relStyles = copiedStyles
    .filter((f) => f.origName.endsWith(".css"))
    .sort((a, b) => a.origName.localeCompare(b.origName))
    .map((f) => path.relative(outDir, f.destPath).split(path.sep).join("/"));
  stylesAssetList.push(...relStyles);

  // Append optional course-level extra CSS overrides strictly after 04-mobile.<hash8>.css
  const existingCssNames = new Set([
    webfontBundle.cssFileName,
    ...copiedStyles.map((f) => f.hashedName),
  ]);
  const extraStyleRels = copyExtraStylesheets(
    rootDir,
    config.paths.extraStyles || [],
    outAssetsDir,
    existingCssNames
  );
  stylesAssetList.push(...extraStyleRels);

  // Write fingerprinted minified concepts.<hash8>.json + unhashed file:// fallback concepts-data.js
  const conceptsJsonStr = JSON.stringify(compiledConceptMap);
  const conceptsHash = shortHash(conceptsJsonStr);
  const conceptsJsonRel = `assets/concepts.${conceptsHash}.json`;
  fs.writeFileSync(path.join(outDir, conceptsJsonRel), conceptsJsonStr, "utf8");
  fs.writeFileSync(
    path.join(outAssetsDir, "concepts-data.js"),
    `window.__CONCEPTS__ = ${safeJsonForScript(compiledConceptMap)};\n`,
    "utf8"
  );

  // Copy base client scripts with app.<hash8>.js strictly before notebook-sync.<hash8>.js
  const scriptsAssetList = [];
  const copiedClient = copyAssetsFingerprinted(clientDir, outAssetsDir, new Set([".js", ".mjs"]));
  const relScripts = copiedClient
    .filter((f) => f.origName.endsWith(".js") || f.origName.endsWith(".mjs"))
    .sort((a, b) => {
      if (a.origName === "app.js") return -1;
      if (b.origName === "app.js") return 1;
      return a.origName.localeCompare(b.origName);
    })
    .map((f) => path.relative(outDir, f.destPath).split(path.sep).join("/"));
  scriptsAssetList.push(...relScripts);

  const assetsMeta = {
    styles: stylesAssetList,
    scripts: scriptsAssetList,
    conceptsJson: conceptsJsonRel,
    katexJs: katexJsRel,
  };

  // Stage 1: Compile pages (dual-mode or single-mode)
  let totalWords = 0;
  let totalConceptLinks = 0;
  let totalAxiomaticWords = 0;
  let totalAxiomaticConceptLinks = 0;
  let missingExplainedFallbacks = 0;

  const compiledPages = [];
  const treePageBySlug = new Map();
  for (const part of treeParts) {
    for (const ch of part.chapters) {
      for (const treePg of ch.pages) {
        treePageBySlug.set(treePg.slug, treePg);
      }
    }
  }

  for (let idx = 0; idx < flatPages.length; idx++) {
    const pg = flatPages[idx];
    const relUnderContent = pg.file.replace(/^content[\\/]/, "");

    // Resolve primary content/<part>/<slug>.md source
    let primaryFilePath = path.resolve(rootDir, pg.file);
    if (!fs.existsSync(primaryFilePath)) {
      const altPath = path.resolve(contentDir, relUnderContent);
      if (fs.existsSync(altPath)) {
        primaryFilePath = altPath;
      } else {
        throw new Error(`Missing markdown source file for "${pg.slug}": ${primaryFilePath}`);
      }
    }
    const primaryMarkdown = fs.readFileSync(primaryFilePath, "utf8");

    if (dualReadingStyle) {
      // Dual-mode: content/ -> axiomatic JSON view; content-explained/ -> default SSR HTML
      const explainedFilePath = path.resolve(explainedDir, relUnderContent);
      let explainedMarkdown;
      let explainedSourceLabel;
      if (fs.existsSync(explainedFilePath)) {
        explainedMarkdown = fs.readFileSync(explainedFilePath, "utf8");
        explainedSourceLabel = `content-explained/${relUnderContent.split(path.sep).join("/")}`;
      } else if (allowMissingExplained) {
        explainedMarkdown = primaryMarkdown;
        explainedSourceLabel = `${pg.file} (fallback)`;
        missingExplainedFallbacks++;
      } else {
        throw new Error(
          `Missing explained markdown source file for "${pg.slug}": ${explainedFilePath} ` +
            `(set features.dualReadingStyle=false for single-mode, or pass --allow-missing-explained for dev testing)`
        );
      }

      const axiomaticRendered = renderMarkdownPage(primaryMarkdown, {
        sourceLabel: pg.file,
        pageTitle: pg.title,
      });
      const axiomaticInjected = injectConcepts(axiomaticRendered.html, {
        currentPageSlug: pg.slug,
        matcher: conceptMatcher,
        pageBase: "./",
      });
      const axiomaticReadMinutes = Math.max(2, Math.round(axiomaticRendered.wordCount / 360));
      const axiomaticViewPayload = {
        slug: pg.slug,
        style: "axiomatic",
        html: axiomaticInjected.html,
        headings: axiomaticRendered.headings.map((h) => ({
          id: h.id,
          level: h.level,
          text: h.text,
          html: h.html,
        })),
        wordCount: axiomaticRendered.wordCount,
        readMinutes: axiomaticReadMinutes,
        referencedConceptCount: axiomaticInjected.linkCount,
      };
      const axiomaticViewStr = JSON.stringify(axiomaticViewPayload);
      const axiomaticHash = shortHash(axiomaticViewStr);
      const axiomaticViewRel = `assets/views/${pg.slug}.axiomatic.${axiomaticHash}.json`;
      fs.writeFileSync(path.join(outDir, axiomaticViewRel), axiomaticViewStr, "utf8");

      totalAxiomaticWords += axiomaticRendered.wordCount;
      totalAxiomaticConceptLinks += axiomaticInjected.linkCount;

      const ssrRendered = renderMarkdownPage(explainedMarkdown, {
        sourceLabel: explainedSourceLabel,
        pageTitle: pg.title,
      });
      const ssrInjected = injectConcepts(ssrRendered.html, {
        currentPageSlug: pg.slug,
        matcher: conceptMatcher,
        pageBase: "./",
      });
      const ssrReadMinutes = Math.max(2, Math.round(ssrRendered.wordCount / 360));

      pg.readMinutes = ssrReadMinutes;
      const treePg = treePageBySlug.get(pg.slug);
      if (treePg) treePg.readMinutes = ssrReadMinutes;

      totalWords += ssrRendered.wordCount;
      totalConceptLinks += ssrInjected.linkCount;

      compiledPages.push({
        pg,
        idx,
        ssrRendered,
        ssrInjected,
        ssrReadMinutes,
        axiomaticViewRel,
      });
    } else {
      // Single-mode: render content/ directly as SSR HTML with no axiomatic JSON views
      const ssrRendered = renderMarkdownPage(primaryMarkdown, {
        sourceLabel: pg.file,
        pageTitle: pg.title,
      });
      const ssrInjected = injectConcepts(ssrRendered.html, {
        currentPageSlug: pg.slug,
        matcher: conceptMatcher,
        pageBase: "./",
      });
      const ssrReadMinutes = Math.max(2, Math.round(ssrRendered.wordCount / 360));

      pg.readMinutes = ssrReadMinutes;
      const treePg = treePageBySlug.get(pg.slug);
      if (treePg) treePg.readMinutes = ssrReadMinutes;

      totalWords += ssrRendered.wordCount;
      totalConceptLinks += ssrInjected.linkCount;

      compiledPages.push({
        pg,
        idx,
        ssrRendered,
        ssrInjected,
        ssrReadMinutes,
        axiomaticViewRel: "",
      });
    }
  }

  site.totalReadMinutes = flatPages.reduce((sum, p) => sum + (p.readMinutes || 0), 0);

  const subpageTree = buildTreeWithHrefs(treeParts, "./");
  const homeTree = buildTreeWithHrefs(treeParts, "./pages/");

  // Stage 2: Render every micro-page HTML
  for (const item of compiledPages) {
    const { pg, idx, ssrRendered, ssrInjected, ssrReadMinutes, axiomaticViewRel } = item;
    const prevRaw = idx > 0 ? flatPages[idx - 1] : null;
    const nextRaw = idx + 1 < flatPages.length ? flatPages[idx + 1] : null;

    const definesConceptsResolved = (pg.definesConcepts || [])
      .map((id) => compiledConceptMap[id])
      .filter(Boolean);

    const pageCtx = {
      config,
      site,
      examOverview,
      assetBase: "../",
      pageBase: "./",
      homeHref: "../index.html",
      assets: assetsMeta,
      tree: subpageTree,
      page: {
        id: pg.id,
        slug: pg.slug,
        title: pg.title,
        shortTitle: pg.shortTitle,
        summary: pg.summary,
        readMinutes: ssrReadMinutes,
        priority: pg.priority,
        examTag: pg.examTag,
        homeworkRefs: pg.homeworkRefs,
        order: pg.order,
        index: idx,
        part: pg.part,
        chapter: pg.chapter,
        definesConcepts: definesConceptsResolved,
        referencedConceptCount: ssrInjected.linkCount,
        wordCount: ssrRendered.wordCount,
        axiomaticViewUrl: dualReadingStyle ? axiomaticViewRel : "",
        readingStyleDefault: dualReadingStyle ? config.features.defaultReadingStyle : "",
      },
      headings: ssrRendered.headings,
      articleHtml: ssrInjected.html,
      prevPage: prevRaw
        ? {
            slug: prevRaw.slug,
            title: prevRaw.title,
            shortTitle: prevRaw.shortTitle,
            priority: prevRaw.priority,
            examTag: prevRaw.examTag,
            href: `./${encodeURIComponent(prevRaw.slug)}.html`,
            chapterTitle: prevRaw.chapter?.shortTitle || prevRaw.chapter?.title || "",
          }
        : null,
      nextPage: nextRaw
        ? {
            slug: nextRaw.slug,
            title: nextRaw.title,
            shortTitle: nextRaw.shortTitle,
            priority: nextRaw.priority,
            examTag: nextRaw.examTag,
            href: `./${encodeURIComponent(nextRaw.slug)}.html`,
            chapterTitle: nextRaw.chapter?.shortTitle || nextRaw.chapter?.title || "",
          }
        : null,
    };

    const fullHtml = layoutMod.renderPage(pageCtx);
    fs.writeFileSync(path.join(outDir, "pages", `${pg.slug}.html`), fullHtml, "utf8");
  }

  // Build dist/index.html
  const homeCtx = {
    config,
    site,
    examOverview,
    assetBase: "./",
    pageBase: "./pages/",
    homeHref: "./index.html",
    assets: assetsMeta,
    tree: homeTree,
    pages: flatPages.map((pg) => ({
      id: pg.id,
      slug: pg.slug,
      title: pg.title,
      shortTitle: pg.shortTitle,
      summary: pg.summary,
      readMinutes: pg.readMinutes,
      priority: pg.priority,
      examTag: pg.examTag,
      homeworkRefs: pg.homeworkRefs,
      order: pg.order,
      href: `./pages/${encodeURIComponent(pg.slug)}.html`,
      partId: pg.partId,
      partTitle: pg.part?.shortTitle || pg.part?.title || "",
      chapterId: pg.chapterId,
      chapterTitle: pg.chapter?.shortTitle || pg.chapter?.title || "",
      definesConcepts: pg.definesConcepts,
    })),
    concepts: compiledConceptList,
  };

  fs.writeFileSync(path.join(outDir, "index.html"), homeMod.renderHome(homeCtx), "utf8");

  // Build dist/404.html
  const notFoundCtx = {
    config,
    site,
    examOverview,
    assetBase: "./",
    pageBase: "./pages/",
    homeHref: "./index.html",
    assets: assetsMeta,
    tree: homeTree,
  };
  const notFoundHtml =
    typeof layoutMod.renderNotFound === "function"
      ? layoutMod.renderNotFound(notFoundCtx)
      : defaultNotFoundHtml(notFoundCtx);
  fs.writeFileSync(path.join(outDir, "404.html"), notFoundHtml, "utf8");

  // Emit Cloudflare _headers and GitHub Pages .nojekyll
  fs.writeFileSync(
    path.join(outDir, "_headers"),
    generateHeadersFile({ dualReadingStyle }),
    "utf8"
  );
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");

  const elapsedMs = Date.now() - startTime;
  const fallbackNote =
    missingExplainedFallbacks > 0
      ? ` (${missingExplainedFallbacks} dev fallbacks via --allow-missing-explained)`
      : "";
  const totalFontFiles = webfontBundle.totalSlices + copiedLocalFonts.length;
  const totalFontMb = (
    (webfontBundle.totalBytes + copiedLocalFonts.reduce((s, f) => s + f.bytes, 0)) /
    (1024 * 1024)
  ).toFixed(2);
  const modeSummary = dualReadingStyle
    ? `dual-mode pages${fallbackNote}, ${rawConcepts.length} concepts, explained: ~${totalWords} words / ${totalConceptLinks} links, axiomatic views: ~${totalAxiomaticWords} words / ${totalAxiomaticConceptLinks} links`
    : `single-mode pages, ${rawConcepts.length} concepts, ~${totalWords} words / ${totalConceptLinks} links`;

  console.log(
    `[build] Built ${flatPages.length} ${modeSummary}, ` +
      `webfonts: ${webfontBundle.cssFileName} (${totalFontFiles} woff2 / ${totalFontMb}MB)` +
      `${extraStyleRels.length > 0 ? `, extra CSS: ${extraStyleRels.length}` : ""} ` +
      `in ${elapsedMs}ms -> ${outDir}`
  );

  return {
    dualReadingStyle,
    pagesBuilt: flatPages.length,
    conceptsCompiled: rawConcepts.length,
    totalConceptLinks,
    totalWords,
    totalAxiomaticWords,
    totalAxiomaticConceptLinks,
    missingExplainedFallbacks,
    webfontBundle,
    copiedLocalFonts,
    extraStyleRels,
    elapsedMs,
    outDir,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runBuild(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(`[build ERROR] ${err.stack || err.message}`);
    process.exit(1);
  });
}
