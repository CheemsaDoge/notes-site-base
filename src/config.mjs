import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  site: {
    title: "课程讲义站",
    shortTitle: "课程精讲",
    subtitle: "Interactive Study Notes",
    description: "面向移动阅读与期末复习优化的微课化静态讲义站。",
    brandMark: "N",
    heroBadge: "交互式分层讲义 · 概念速览 · 划词笔记 · 云端同步",
    footerNote: "纯静态离线友好学习站",
    exportPrefix: "学习讲义",
    lang: "zh-CN",
  },
  storage: {
    prefix: "notes:v1",
    themeKey: "notes-color-scheme",
    syncHashPrefix: "notes-sync-v1:",
  },
  features: {
    dualReadingStyle: true,
    defaultReadingStyle: "explained",
    defaultFontTheme: "serif",
    readingStyleLabels: {
      explained: "讲解式",
      axiomatic: "公理版",
      explainedHint: "从直觉与例子出发循序推导",
      axiomaticHint: "精简定义与考纲标准证明",
    },
    styleAudit: {
      forbidEmDash: false,
    },
  },
  paths: {
    dataDir: "data",
    contentDir: "content",
    explainedDir: "content-explained",
    outDir: "dist",
    extraStyles: [],
  },
  concepts: {
    nonNegatedTerms: [],
    inertCompoundBlockers: [],
    boundaryGuards: {},
    suffixGuards: [],
  },
  examOverview: {
    groupLabels: {},
  },
});

const VALID_READING_STYLES = new Set(["explained", "axiomatic"]);
const VALID_FONT_THEMES = new Set(["serif", "wenkai", "sans"]);

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function cleanString(v, fallback) {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return fallback;
}

function cleanStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function cleanStringMap(obj) {
  if (!isPlainObject(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || "").trim();
    const val = typeof v === "string" ? v.trim() : "";
    if (key && val) out[key] = val;
  }
  return out;
}

function cleanBoundaryGuards(obj) {
  if (!isPlainObject(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || "").trim();
    if (!key || !isPlainObject(v)) continue;
    const guard = {};
    if (typeof v.beforeNot === "string" && v.beforeNot.trim()) {
      guard.beforeNot = v.beforeNot.trim();
    }
    if (typeof v.afterNot === "string" && v.afterNot.trim()) {
      guard.afterNot = v.afterNot.trim();
    }
    if (guard.beforeNot || guard.afterNot) {
      out[key] = guard;
    }
  }
  return out;
}

function cleanSuffixGuards(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (!isPlainObject(item)) continue;
    const endsWith = typeof item.endsWith === "string" ? item.endsWith.trim() : "";
    const startsWith = typeof item.startsWith === "string" ? item.startsWith.trim() : "";
    const beforeNot = typeof item.beforeNot === "string" ? item.beforeNot.trim() : "";
    const afterNot = typeof item.afterNot === "string" ? item.afterNot.trim() : "";
    if ((endsWith || startsWith) && (beforeNot || afterNot)) {
      out.push({
        ...(endsWith ? { endsWith } : {}),
        ...(startsWith ? { startsWith } : {}),
        ...(beforeNot ? { beforeNot } : {}),
        ...(afterNot ? { afterNot } : {}),
      });
    }
  }
  return out;
}

/**
 * Normalize and merge a raw `site.config.json` object with `DEFAULT_CONFIG`
 * (and optional `sitemap.site` fallbacks for title/subtitle/description).
 */
export function normalizeConfig(rawConfig = {}, rawSitemap = null) {
  const cfg = isPlainObject(rawConfig) ? rawConfig : {};
  const rawSite = isPlainObject(cfg.site) ? cfg.site : {};
  const sitemapSite = isPlainObject(rawSitemap?.site) ? rawSitemap.site : {};
  const rawStorage = isPlainObject(cfg.storage) ? cfg.storage : {};
  const rawFeatures = isPlainObject(cfg.features) ? cfg.features : {};
  const rawLabels = isPlainObject(rawFeatures.readingStyleLabels)
    ? rawFeatures.readingStyleLabels
    : {};
  const rawStyleAudit = isPlainObject(rawFeatures.styleAudit) ? rawFeatures.styleAudit : {};
  const rawPaths = isPlainObject(cfg.paths) ? cfg.paths : {};
  const rawConcepts = isPlainObject(cfg.concepts) ? cfg.concepts : {};
  const rawExamOverview = isPlainObject(cfg.examOverview) ? cfg.examOverview : {};

  const d = DEFAULT_CONFIG;

  const site = {
    title: cleanString(rawSite.title, cleanString(sitemapSite.title, d.site.title)),
    shortTitle: cleanString(
      rawSite.shortTitle,
      cleanString(sitemapSite.shortTitle, cleanString(rawSite.title, cleanString(sitemapSite.title, d.site.shortTitle)))
    ),
    subtitle: cleanString(rawSite.subtitle, cleanString(sitemapSite.subtitle, d.site.subtitle)),
    description: cleanString(
      rawSite.description,
      cleanString(sitemapSite.description, d.site.description)
    ),
    brandMark: cleanString(rawSite.brandMark, d.site.brandMark),
    heroBadge:
      typeof rawSite.heroBadge === "string" ? rawSite.heroBadge.trim() : d.site.heroBadge,
    footerNote:
      typeof rawSite.footerNote === "string" ? rawSite.footerNote.trim() : d.site.footerNote,
    exportPrefix: cleanString(
      rawSite.exportPrefix,
      cleanString(rawSite.shortTitle, cleanString(rawSite.title, d.site.exportPrefix))
    ),
    lang: cleanString(rawSite.lang, d.site.lang),
  };

  const storage = {
    prefix: cleanString(rawStorage.prefix, d.storage.prefix),
    themeKey: cleanString(rawStorage.themeKey, d.storage.themeKey),
    syncHashPrefix: cleanString(rawStorage.syncHashPrefix, d.storage.syncHashPrefix),
  };

  const dualReadingStyle =
    typeof rawFeatures.dualReadingStyle === "boolean"
      ? rawFeatures.dualReadingStyle
      : d.features.dualReadingStyle;

  const defaultReadingStyle = VALID_READING_STYLES.has(rawFeatures.defaultReadingStyle)
    ? rawFeatures.defaultReadingStyle
    : d.features.defaultReadingStyle;

  const defaultFontTheme = VALID_FONT_THEMES.has(rawFeatures.defaultFontTheme)
    ? rawFeatures.defaultFontTheme
    : d.features.defaultFontTheme;

  const features = {
    dualReadingStyle,
    defaultReadingStyle,
    defaultFontTheme,
    readingStyleLabels: {
      explained: cleanString(rawLabels.explained, d.features.readingStyleLabels.explained),
      axiomatic: cleanString(rawLabels.axiomatic, d.features.readingStyleLabels.axiomatic),
      explainedHint: cleanString(
        rawLabels.explainedHint,
        d.features.readingStyleLabels.explainedHint
      ),
      axiomaticHint: cleanString(
        rawLabels.axiomaticHint,
        d.features.readingStyleLabels.axiomaticHint
      ),
    },
    styleAudit: {
      forbidEmDash: Boolean(rawStyleAudit.forbidEmDash),
    },
  };

  const paths = {
    dataDir: cleanString(rawPaths.dataDir, d.paths.dataDir),
    contentDir: cleanString(rawPaths.contentDir, d.paths.contentDir),
    explainedDir: cleanString(rawPaths.explainedDir, d.paths.explainedDir),
    outDir: cleanString(rawPaths.outDir, d.paths.outDir),
    extraStyles: cleanStringArray(rawPaths.extraStyles),
  };

  const concepts = {
    nonNegatedTerms: cleanStringArray(rawConcepts.nonNegatedTerms),
    inertCompoundBlockers: cleanStringArray(rawConcepts.inertCompoundBlockers),
    boundaryGuards: cleanBoundaryGuards(rawConcepts.boundaryGuards),
    suffixGuards: cleanSuffixGuards(rawConcepts.suffixGuards),
  };

  const examOverview = {
    groupLabels: cleanStringMap(rawExamOverview.groupLabels),
  };

  return {
    site,
    storage,
    features,
    paths,
    concepts,
    examOverview,
  };
}

/**
 * Load `site.config.json` from `rootDir` (or an explicit `configPath`),
 * returning normalized config merged over `DEFAULT_CONFIG`.
 */
export function loadSiteConfig(rootDir = process.cwd(), { configPath = null, sitemap = null } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const candidatePath = configPath
    ? path.resolve(resolvedRoot, configPath)
    : path.join(resolvedRoot, "site.config.json");

  let rawConfig = {};
  if (fs.existsSync(candidatePath)) {
    const rawText = fs.readFileSync(candidatePath, "utf8");
    try {
      rawConfig = JSON.parse(rawText);
    } catch (err) {
      throw new Error(`Invalid JSON in site config ${candidatePath}: ${err.message}`);
    }
  } else if (configPath) {
    throw new Error(`Specified site config file not found: ${candidatePath}`);
  }

  const normalized = normalizeConfig(rawConfig, sitemap);

  // Auto-discover `styles/custom.css` when `paths.extraStyles` is not explicitly configured
  const hasExplicitExtraStyles =
    isPlainObject(rawConfig?.paths) && Array.isArray(rawConfig.paths.extraStyles);
  if (!hasExplicitExtraStyles) {
    const autoCustomCss = path.join(resolvedRoot, "styles", "custom.css");
    if (fs.existsSync(autoCustomCss) && fs.statSync(autoCustomCss).isFile()) {
      normalized.paths.extraStyles = ["styles/custom.css"];
    }
  }

  return normalized;
}
