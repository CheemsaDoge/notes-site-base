import {
  FONT_THEME_HINTS,
  escapeHtml,
  normalizePriority,
  renderBrand,
  renderFontThemeToggle,
  renderHead,
  renderIcons,
  renderNotebookDrawer,
  renderNotebookIconBtn,
  renderPriorityBadge,
  renderPriorityFilterBar,
  renderReadingProgress,
  renderReadingStyleToggle,
  renderRecallPopover,
  renderSiteFooter,
  renderSyncDialog,
  renderSyncIconBtn,
  renderThemeToggle,
  renderToastRegion,
  resolveTemplateConfig,
} from './shared.mjs';

function inferExamGroupAndCode(slug, fallbackIndex, groupLabels = {}) {
  const m = String(slug || '').match(/^exam-([a-z])(\d+)/i);
  if (m) {
    const letter = m[1].toUpperCase();
    const num = Number(m[2]);
    const mappedGroup = groupLabels[letter] || groupLabels[letter.toLowerCase()];
    return {
      group: mappedGroup || '核心题型',
      code: `${letter}${num}`,
    };
  }
  return { group: '核心题型', code: `T${fallbackIndex + 1}` };
}

function renderExamSprintBanner({ examOverview, examGroupLabels = {}, pages, pageBase }) {
  const pageBySlug = new Map((pages ?? []).map((p) => [p.slug, p]));
  const autoExamPages = (pages ?? []).filter((p) => String(p.slug || '').startsWith('exam-'));

  if (!examOverview && autoExamPages.length === 0) return '';

  const ov = examOverview || {};
  const mergedGroupLabels = {
    ...examGroupLabels,
    ...(ov.groupLabels && typeof ov.groupLabels === 'object' ? ov.groupLabels : {}),
  };
  const title = ov.title || '期末命题重点与题型直达';
  const summary =
    ov.summary ||
    '按高频考点与核心题型整理，含典型例题解析与折叠自测。';
  const weightNote = ov.weightNote || ov.grading || '';

  const rawBlocks = Array.isArray(ov.blocks)
    ? ov.blocks
    : Array.isArray(ov.sections)
      ? ov.sections
      : Array.isArray(ov.structure)
        ? ov.structure
        : [];

  const blocksHtml =
    rawBlocks.length > 0
      ? `<div class="exam-blocks-grid">
    ${rawBlocks
      .map((b) => {
        const label = b.label || b.title || b.module || '';
        const badge = b.badge || '';
        const focus = b.focus || b.summary || b.topics || b.description || '';
        return `<div class="exam-block-card">
      <span class="exam-block-label">${escapeHtml(label)}${badge ? ` <span class="priority-badge priority-badge-core priority-badge-compact">${escapeHtml(badge)}</span>` : ''}</span>
      <p class="exam-block-focus">${escapeHtml(focus)}</p>
    </div>`;
      })
      .join('\n    ')}
  </div>`
      : '';

  // Build verified quick links (never emit a link to a missing slug)
  const rawQuickLinks = Array.isArray(ov.quickLinks) && ov.quickLinks.length > 0
    ? ov.quickLinks
        .filter((item) => item?.slug && pageBySlug.has(item.slug))
        .map((item, idx) => {
          const pg = pageBySlug.get(item.slug);
          const inferred = inferExamGroupAndCode(item.slug, idx, mergedGroupLabels);
          return {
            slug: item.slug,
            href: pg.href || `${pageBase}${encodeURIComponent(item.slug)}.html`,
            code: item.code || inferred.code,
            group: item.group || inferred.group,
            label: item.label || pg.shortTitle || pg.title,
          };
        })
    : autoExamPages.map((pg, idx) => {
        const inferred = inferExamGroupAndCode(pg.slug, idx, mergedGroupLabels);
        const cleanLabel = (pg.shortTitle || pg.title || '').replace(/^题型\s*[A-Z]\d+[：:\s·-]*/i, '');
        return {
          slug: pg.slug,
          href: pg.href || `${pageBase}${encodeURIComponent(pg.slug)}.html`,
          code: inferred.code,
          group: inferred.group,
          label: cleanLabel || pg.shortTitle || pg.title,
        };
      });

  const groupedQuick = new Map();
  for (const item of rawQuickLinks) {
    if (!groupedQuick.has(item.group)) groupedQuick.set(item.group, []);
    groupedQuick.get(item.group).push(item);
  }

  const quickHeading =
    ov.quickLinksHeading ||
    `${rawQuickLinks.length} 大高频题型直达（含典型例题 + 梯度变式折叠自测）`;

  const quickLinksHtml =
    rawQuickLinks.length > 0
      ? `<div class="exam-quick-wrap">
    <div class="exam-quick-heading">
      <span>${escapeHtml(quickHeading)}</span>
      <span class="part-count">已练题目自动标绿 ✓</span>
    </div>
    <div class="exam-quick-groups">
      ${Array.from(groupedQuick.entries())
        .map(
          ([groupName, items]) => `<div class="exam-quick-row">
        <span class="exam-quick-group-label">${escapeHtml(groupName)}</span>
        <div class="exam-quick-pills">
          ${items
            .map(
              (item) =>
                `<a class="exam-quick-pill" href="${escapeHtml(item.href)}" data-slug="${escapeHtml(item.slug)}"><span class="exam-quick-code">${escapeHtml(item.code)}</span><span>${escapeHtml(item.label)}</span></a>`
            )
            .join('\n          ')}
        </div>
      </div>`
        )
        .join('\n      ')}
    </div>
  </div>`
      : '';

  const firstExamHref = rawQuickLinks[0]?.href || '';
  const exclusionsRaw = ov.exclusions ?? ov.deprioritized ?? '';
  const exclusionsText = Array.isArray(exclusionsRaw)
    ? exclusionsRaw.filter(Boolean).join('；')
    : String(exclusionsRaw || '').trim();

  return `<section class="exam-sprint-banner" id="exam-sprint" aria-labelledby="exam-sprint-heading">
  <div class="exam-sprint-head">
    <div>
      <div class="exam-sprint-eyebrow">
        <span class="priority-badge priority-badge-core">期末冲刺蓝图</span>
        ${weightNote ? `<span class="meta-pill">${escapeHtml(weightNote)}</span>` : ''}
      </div>
      <h2 id="exam-sprint-heading" class="exam-sprint-title">${escapeHtml(title)}</h2>
    </div>
    <div class="exam-sprint-actions">
      ${firstExamHref ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(firstExamHref)}">进入重点题型精练 →</a>` : ''}
      <a class="btn btn-sm" href="#syllabus-section" data-activate-priority="core">只看核心必考大纲 ↓</a>
    </div>
  </div>
  <p class="exam-sprint-summary">${escapeHtml(summary)}</p>
  ${blocksHtml}
  ${quickLinksHtml}
  ${exclusionsText ? `<p class="exam-exclusions"><strong>考纲降权 / 非主要考察提示：</strong>${escapeHtml(exclusionsText)}</p>` : ''}
</section>`;
}

/**
 * Renders the course home / landing page (`dist/index.html`).
 */
export function renderHome(ctx) {
  const {
    assetBase = './',
    pageBase = './pages/',
    homeHref = './index.html',
    assets = {},
    tree = [],
    pages = [],
    concepts = [],
  } = ctx;

  const { site, storage, features, examGroupLabels } = resolveTemplateConfig(ctx);
  const examOverview = ctx.examOverview || site.examOverview || null;
  const icons = renderIcons();
  const dualMode = features.dualReadingStyle;
  const labels = features.readingStyleLabels;
  const defaultFontHint =
    FONT_THEME_HINTS[features.defaultFontTheme] || FONT_THEME_HINTS.serif;

  const totalPages = site.totalPages ?? pages.length;
  const totalConcepts = site.totalConcepts ?? concepts.length;
  const corePages =
    site.corePages ?? pages.filter((p) => normalizePriority(p.priority) === 'core').length;
  const totalReadMinutes =
    site.totalReadMinutes ??
    pages.reduce((sum, p) => sum + (Number(p.readMinutes) || 0), 0);

  const firstPage = pages[0] || tree[0]?.chapters?.[0]?.pages?.[0] || null;
  const firstPageHref = firstPage?.href || `${pageBase}index.html`;
  const firstPageTitle = firstPage?.title || '开始第 1 节学习';
  const firstPageChapter = firstPage?.chapterTitle || tree[0]?.chapters?.[0]?.title || '';

  const examSprintHtml = renderExamSprintBanner({
    examOverview,
    examGroupLabels,
    pages,
    pageBase,
  });

  const partCountLabel =
    tree.length === 8
      ? '八大篇章进度总览'
      : tree.length === 6
        ? '六大篇章进度总览'
        : `${tree.length} 大篇章进度总览`;

  const partOverviewCardsHtml = (tree ?? [])
    .map((part, idx) => {
      const chapters = part.chapters ?? [];
      const partPages = chapters.flatMap((c) => c.pages ?? []);
      const firstInPart = partPages[0];
      const partDesc = part.summary || part.description || '';
      const partCoreCount =
        part.coreCount ??
        partPages.filter((p) => normalizePriority(p.priority) === 'core').length;

      return `<article class="part-overview-card" data-part-card="${escapeHtml(part.id)}" data-part-total="${partPages.length}">
  <div class="part-card-top">
    <span class="part-code">${escapeHtml(part.code || `第 ${idx + 1} 篇`)}</span>
    <span class="part-count">
      ${partCoreCount > 0 ? `<span class="priority-badge priority-badge-core priority-badge-compact">必考 ${partCoreCount}</span> ` : ''}${chapters.length} 模块 · ${partPages.length} 节
    </span>
  </div>
  <h3 class="part-card-title">${escapeHtml(part.shortTitle || part.title)}</h3>
  ${partDesc ? `<p class="part-card-desc">${escapeHtml(partDesc)}</p>` : ''}
  <div class="continue-progress-wrap">
    <div class="continue-progress-label">
      <span>完成进度</span>
      <span data-part-progress="${escapeHtml(part.id)}">0/${partPages.length}</span>
    </div>
    <div class="progress-track">
      <span class="progress-fill" data-part-progress-fill="${escapeHtml(part.id)}"></span>
    </div>
  </div>
  <div class="part-card-footer">
    ${firstInPart ? `<a class="part-jump-link" href="${escapeHtml(firstInPart.href)}">从本篇开始 →</a>` : '<span></span>'}
    <a class="btn btn-ghost btn-sm" href="#syllabus-part-${escapeHtml(part.id)}" data-expand-part="${escapeHtml(part.id)}">查看目录</a>
  </div>
</article>`;
    })
    .join('\n');

  const syllabusHtml = (tree ?? [])
    .map((part, idx) => {
      const chapters = part.chapters ?? [];
      const partPageCount = chapters.reduce(
        (sum, ch) => sum + (ch.pages?.length ?? 0),
        0
      );

      const chaptersHtml = chapters
        .map((ch) => {
          const chPagesHtml = (ch.pages ?? [])
            .map((p) => {
              const priority = normalizePriority(p.priority);
              const badgeHtml = renderPriorityBadge(priority, p.examTag, { compact: true });
              const searchHaystack = [
                p.title,
                p.shortTitle,
                p.summary,
                p.examTag,
                ...(Array.isArray(p.homeworkRefs) ? p.homeworkRefs : []),
                ch.title,
                part.title,
              ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

              return `<li class="syllabus-page-item" data-syllabus-page="${escapeHtml(p.slug)}" data-priority="${priority}" data-search-text="${escapeHtml(searchHaystack)}">
  <a class="syllabus-page-link" href="${escapeHtml(p.href)}" data-slug="${escapeHtml(p.slug)}">
    <span class="toc-check" aria-hidden="true">✓</span>
    <span class="syllabus-page-info">
      <span class="syllabus-page-title">${escapeHtml(p.title)} ${badgeHtml}</span>
      ${p.summary ? `<span class="syllabus-page-summary">${escapeHtml(p.summary)}</span>` : ''}
    </span>
    <span class="syllabus-page-meta">${p.readMinutes ? `${escapeHtml(p.readMinutes)} 分钟` : ''}</span>
  </a>
</li>`;
            })
            .join('\n');

          return `<details class="syllabus-chapter" data-syllabus-chapter="${escapeHtml(ch.id)}"${idx === 0 ? ' open' : ''}>
  <summary>
    <span class="syllabus-chapter-title">${escapeHtml(ch.title)}</span>
    <span class="toc-part-badge" data-chapter-count data-chapter-total="${(ch.pages ?? []).length}">${(ch.pages ?? []).length} 节</span>
  </summary>
  <ul class="syllabus-page-list">
${chPagesHtml}
  </ul>
</details>`;
        })
        .join('\n');

      return `<details class="syllabus-part" id="syllabus-part-${escapeHtml(part.id)}" data-syllabus-part="${escapeHtml(part.id)}"${idx === 0 ? ' open' : ''}>
  <summary>
    <span class="syllabus-part-title">${escapeHtml(part.title)}</span>
    <span class="toc-part-badge" data-part-progress="${escapeHtml(part.id)}">0/${partPageCount}</span>
  </summary>
  <div class="syllabus-part-content">
${chaptersHtml}
  </div>
</details>`;
    })
    .join('\n');

  const sampleConceptTerms = concepts
    .slice(0, 3)
    .map((c) => c.term)
    .filter(Boolean);
  const conceptSearchPlaceholder =
    sampleConceptTerms.length > 0
      ? `筛选 ${concepts.length} 个核心术语（如 ${sampleConceptTerms.join('、')}）…`
      : `筛选 ${concepts.length} 个核心术语…`;

  const conceptIndexHtml =
    concepts.length > 0
      ? `<section class="home-section" aria-labelledby="concept-index-heading">
  <div class="home-section-head">
    <div>
      <h2 id="concept-index-heading" class="home-section-title">核心概念速览图谱</h2>
      <p class="home-section-sub">点击任意概念标签弹出即时回忆卡片（含预渲染数学公式与考点分级），也可一键直达对应精讲小节。</p>
    </div>
  </div>
  <div class="concept-index-box">
    <div class="concept-index-controls">
      <label class="search-input-wrap syllabus-search-wrap">
        <span class="sr-only">筛选核心概念</span>
        ${icons.search}
        <input type="search" id="concept-index-filter" class="search-input" placeholder="${escapeHtml(conceptSearchPlaceholder)}" autocomplete="off">
      </label>
      ${renderPriorityFilterBar({ targetId: 'concept-index-grid', ariaLabel: '按重要程度筛选核心概念' })}
      <span class="meta-pill" id="concept-index-count">共 ${concepts.length} 个概念</span>
    </div>
    <div id="concept-index-grid" class="concept-index-grid">
      ${concepts
        .map((c) => {
          const cp = normalizePriority(c.priority);
          const searchText = `${c.term} ${c.category || ''} ${c.examTag || ''}`.toLowerCase();
          const dotHtml =
            cp !== 'normal'
              ? `<span class="concept-priority-dot concept-priority-dot-${cp}" aria-hidden="true"></span><span class="sr-only">${cp === 'core' ? '核心必考：' : '高频重点：'}</span>`
              : '';
          return `<button type="button" class="concept-chip" data-priority="${cp}" data-preview-concept="${escapeHtml(c.id)}" data-preview-href="${escapeHtml(pageBase + c.targetPage + '.html')}" data-concept-search="${escapeHtml(searchText)}">${dotHtml}${escapeHtml(c.term)}</button>`;
        })
        .join('\n      ')}
    </div>
  </div>
</section>`
      : '';

  const conceptsUrl = assets.conceptsJson ? assetBase + assets.conceptsJson : '';
  const dualBodyAttrs = dualMode
    ? `
  data-reading-style-explained-label="${escapeHtml(labels.explained)}"
  data-reading-style-axiomatic-label="${escapeHtml(labels.axiomatic)}"
  data-reading-style-explained-hint="${escapeHtml(labels.explainedHint)}"
  data-reading-style-axiomatic-hint="${escapeHtml(labels.axiomaticHint)}"`
    : '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang)}" data-font-theme="${escapeHtml(features.defaultFontTheme)}">
${renderHead({
  title: site.title,
  description: site.description,
  assetBase,
  assets,
  storage,
  features,
})}
<body
  class="page-home"
  data-page-type="home"
  data-asset-base="${escapeHtml(assetBase)}"
  data-page-base="${escapeHtml(pageBase)}"
  data-concepts-url="${escapeHtml(conceptsUrl)}"
  data-storage-prefix="${escapeHtml(storage.prefix)}"
  data-theme-key="${escapeHtml(storage.themeKey)}"
  data-export-prefix="${escapeHtml(site.exportPrefix)}"
  data-site-title="${escapeHtml(site.title)}"
  data-dual-mode="${dualMode ? 'true' : 'false'}"
  data-reading-style-default="${escapeHtml(features.defaultReadingStyle)}"
  data-font-theme-default="${escapeHtml(features.defaultFontTheme)}"${dualBodyAttrs}
  data-total-pages="${escapeHtml(totalPages)}"
>
  <a class="skip-link" href="#main-content">跳至主要内容</a>
  ${renderReadingProgress()}

  <header class="home-topbar">
    <div class="home-topbar-inner">
      ${renderBrand(site, homeHref)}
      <div class="home-topbar-actions">
        ${
          dualMode
            ? `<div class="home-style-switcher" title="切换全局讲义阅读风格">
          <span class="home-style-label">阅读风格</span>
          ${renderReadingStyleToggle({ compact: true, labels, defaultStyle: features.defaultReadingStyle })}
        </div>`
            : ''
        }
        ${examSprintHtml ? '<a class="btn btn-ghost btn-sm" href="#exam-sprint">重点直达</a>' : ''}
        <a class="btn btn-ghost btn-sm" href="#syllabus-section">完整目录</a>
        ${renderNotebookIconBtn()}
        ${renderSyncIconBtn()}
        ${renderThemeToggle()}
      </div>
    </div>
  </header>

  <main id="main-content" class="home-main" tabindex="-1">
    <div class="home-prefs-bar" role="region" aria-label="全局阅读偏好设置">
      <div class="home-prefs-controls">
        ${
          dualMode
            ? `<div class="reading-style-controls home-prefs-style-wrap">
          <span class="reading-style-label">阅读风格</span>
          ${renderReadingStyleToggle({ compact: true, labels, defaultStyle: features.defaultReadingStyle })}
        </div>`
            : ''
        }
        <div class="reading-style-controls font-theme-controls">
          <span class="reading-style-label">阅读字体</span>
          ${renderFontThemeToggle({ compact: true, defaultFontTheme: features.defaultFontTheme })}
        </div>
      </div>
      <div class="home-prefs-meta">
        <span class="reading-style-hint font-theme-hint" data-font-theme-hint>${escapeHtml(defaultFontHint)}</span>
        <span class="reading-style-status" id="home-font-status" role="status" aria-live="polite"></span>
      </div>
    </div>
    <section class="home-hero" aria-labelledby="home-title">
      <div class="hero-intro">
        ${site.heroBadge ? `<span class="hero-badge">${escapeHtml(site.heroBadge)}</span>` : ''}
        <h1 id="home-title" class="hero-title">${escapeHtml(site.title)}</h1>
        <p class="hero-desc">${escapeHtml(site.description)}</p>
        <div class="hero-stats">
          <span class="hero-stat"><strong>${escapeHtml(tree.length)}</strong> 大篇章</span>
          <span class="hero-stat"><strong>${escapeHtml(totalPages)}</strong> 个精选微课</span>
          ${corePages > 0 ? `<span class="hero-stat"><strong>${escapeHtml(corePages)}</strong> 节核心必考</span>` : ''}
          <span class="hero-stat"><strong>${escapeHtml(totalConcepts)}</strong> 个前置概念速览</span>
          ${totalReadMinutes ? `<span class="hero-stat">预计总阅读 <strong>${escapeHtml(totalReadMinutes)}</strong> 分钟</span>` : ''}
        </div>
      </div>

      <section class="continue-card" aria-labelledby="continue-heading" id="continue-card">
        <div>
          <div class="continue-eyebrow">
            <span id="continue-heading" data-continue-eyebrow>开始你的系统复习</span>
            <span class="continue-time" data-continue-time>首次访问</span>
          </div>
          <p class="continue-chapter" data-continue-chapter>${escapeHtml(firstPageChapter)}</p>
          <h2 class="continue-title" data-continue-title>${escapeHtml(firstPageTitle)}</h2>
        </div>

        <div class="continue-progress-wrap">
          <div class="continue-progress-label">
            <span>全课程阅读进度</span>
            <span data-overall-progress-text>0 / ${escapeHtml(totalPages)} 节 (0%)</span>
          </div>
          <div class="progress-track" role="progressbar" aria-label="全课程总体阅读进度" aria-valuemin="0" aria-valuemax="${escapeHtml(totalPages)}" aria-valuenow="0" data-overall-progressbar>
            <span class="progress-fill" data-overall-progress-fill></span>
          </div>
        </div>

        <div class="continue-actions">
          <a class="btn btn-primary" href="${escapeHtml(firstPageHref)}" data-continue-cta>开始第 1 节学习 →</a>
          <button type="button" class="btn btn-ghost btn-sm" data-reset-progress hidden id="home-reset-btn">清除进度</button>
        </div>
      </section>
    </section>

    ${examSprintHtml}

    <section class="home-section" aria-labelledby="parts-heading">
      <div class="home-section-head">
        <div>
          <h2 id="parts-heading" class="home-section-title">${escapeHtml(partCountLabel)}</h2>
          <p class="home-section-sub">按教材与考纲脉络划分为 ${escapeHtml(tree.length)} 篇，每篇进度与核心必考小节随阅读自动追踪。</p>
        </div>
      </div>
      <div class="parts-grid">
${partOverviewCardsHtml}
      </div>
    </section>

    <section class="home-section" id="syllabus-section" aria-labelledby="syllabus-heading">
      <div class="home-section-head">
        <div>
          <h2 id="syllabus-heading" class="home-section-title">完整三级课程大纲</h2>
          <p class="home-section-sub">篇 → 讲次 / 题型模块 → 微课小节，支持关键词与考点分级组合筛选。</p>
        </div>
      </div>
      <div class="syllabus-controls">
        <label class="search-input-wrap syllabus-search-wrap">
          <span class="sr-only">搜索课程大纲</span>
          ${icons.search}
          <input type="search" id="syllabus-filter" class="search-input" placeholder="按标题、知识点、例题或题型筛选微课…" autocomplete="off">
        </label>
        ${renderPriorityFilterBar({ targetId: 'syllabus-tree', ariaLabel: '按考点分级筛选课程大纲' })}
        <button type="button" class="btn btn-sm" commandfor="syllabus-tree" command="--toggle-all" aria-expanded="false" data-toggle-all="syllabus-tree">
          <span class="label-expand">全部展开</span>
          <span class="label-collapse">全部收起</span>
        </button>
      </div>
      <div id="syllabus-filter-meta" class="toc-filter-meta" hidden>
        <span id="syllabus-filter-summary"></span>
      </div>
      <div id="syllabus-tree" class="syllabus-tree">
${syllabusHtml}
      </div>
      <p id="syllabus-empty" class="toc-empty-state" hidden>未找到匹配的小节，请尝试切换筛选条件或关键词。</p>
    </section>

    ${conceptIndexHtml}

    ${renderSiteFooter(site)}
  </main>

  ${renderRecallPopover()}
  ${renderNotebookDrawer({ isArticle: false })}
  ${renderSyncDialog()}
  ${renderToastRegion()}
</body>
</html>
`;
}
