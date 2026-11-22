import {
  escapeHtml,
  normalizePriority,
  renderBrand,
  renderFontThemeToggle,
  renderHead,
  renderIcons,
  renderMobileDrawer,
  renderNotebookDrawer,
  renderNotebookIconBtn,
  renderPriorityBadge,
  renderReadingProgress,
  renderReadingStyleToggle,
  renderRecallPopover,
  renderSelectionToolbar,
  renderSiteFooter,
  renderSyncDialog,
  renderSyncIconBtn,
  renderThemeToggle,
  renderTocWidget,
  renderToastRegion,
  resolveTemplateConfig,
} from './shared.mjs';

/**
 * Renders a micro-page study article into a complete HTML5 document.
 */
export function renderPage(ctx) {
  const {
    assetBase = '../',
    pageBase = './',
    homeHref = '../index.html',
    assets = {},
    tree = [],
    page = {},
    headings = [],
    articleHtml = '',
    prevPage = null,
    nextPage = null,
  } = ctx;

  const { site, storage, features } = resolveTemplateConfig(ctx);
  const icons = renderIcons();
  const totalPages =
    site.totalPages ??
    tree.reduce(
      (sum, part) =>
        sum + (part.chapters ?? []).reduce((s, c) => s + (c.pages?.length ?? 0), 0),
      0
    );

  const partTitle = page.part?.shortTitle || page.part?.title || '';
  const chapterTitle = page.chapter?.shortTitle || page.chapter?.title || '';
  const fullTitle = `${page.title || '学习小节'} · ${site.title}`;
  const hasHeadings = headings.length > 0;
  const dualMode = features.dualReadingStyle;
  const labels = features.readingStyleLabels;

  const definedConceptsHtml =
    (page.definesConcepts ?? []).length > 0
      ? `<div class="defined-concepts">
  <span class="defined-concepts-label">本节核心概念</span>
  <div class="concept-chip-list">
    ${page.definesConcepts
      .map((c) => {
        const cp = normalizePriority(c.priority);
        const dotHtml =
          cp !== 'normal'
            ? `<span class="concept-priority-dot concept-priority-dot-${cp}" aria-hidden="true"></span><span class="sr-only">${cp === 'core' ? '核心必考：' : '高频重点：'}</span>`
            : '';
        return `<button type="button" class="concept-chip" data-priority="${cp}" data-preview-concept="${escapeHtml(c.id)}" data-preview-href="${escapeHtml(pageBase + (c.targetPage || page.slug) + '.html')}">${dotHtml}${escapeHtml(c.term)}</button>`;
      })
      .join('\n    ')}
  </div>
</div>`
      : '';

  const inlineTocHtml =
    headings.length >= 2
      ? `<details class="inline-toc">
  <summary><span>本页小节导航（${headings.length}）</span></summary>
  <ul class="inline-toc-list">
    ${headings
      .map(
        (h) =>
          `<li class="inline-toc-h${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`
      )
      .join('\n    ')}
  </ul>
</details>`
      : '';

  const rightOnTocHtml = `<aside class="ontoc-aside" id="ontoc-aside" aria-label="本页目录"${hasHeadings ? '' : ' hidden'}>
  <p class="ontoc-title">本页小节</p>
  <nav aria-label="本页小节导航">
    <ul class="ontoc-list" id="ontoc-list">
      ${headings
        .map(
          (h) =>
            `<li class="ontoc-item-h${h.level}"><a class="ontoc-link" href="#${escapeHtml(h.id)}" data-ontoc-link="${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`
        )
        .join('\n      ')}
    </ul>
  </nav>
</aside>`;

  const prevCardHtml = prevPage
    ? `<a class="pager-card pager-card-prev" href="${escapeHtml(prevPage.href)}">
  <span class="pager-dir">← 上一节 ${renderPriorityBadge(prevPage.priority, prevPage.examTag, { compact: true })}</span>
  ${prevPage.chapterTitle ? `<span class="pager-chapter">${escapeHtml(prevPage.chapterTitle)}</span>` : ''}
  <span class="pager-title">${escapeHtml(prevPage.shortTitle || prevPage.title)}</span>
</a>`
    : `<div class="pager-card pager-card-placeholder" aria-hidden="true"></div>`;

  const nextCardHtml = nextPage
    ? `<a class="pager-card pager-card-next" href="${escapeHtml(nextPage.href)}">
  <span class="pager-dir">${renderPriorityBadge(nextPage.priority, nextPage.examTag, { compact: true })} 下一节 →</span>
  ${nextPage.chapterTitle ? `<span class="pager-chapter">${escapeHtml(nextPage.chapterTitle)}</span>` : ''}
  <span class="pager-title">${escapeHtml(nextPage.shortTitle || nextPage.title)}</span>
</a>`
    : `<a class="pager-card pager-card-next" href="${escapeHtml(homeHref)}">
  <span class="pager-dir">全课程已完成 →</span>
  <span class="pager-chapter">复习总览</span>
  <span class="pager-title">返回课程首页查看学习进度</span>
</a>`;

  const conceptsUrl = assets.conceptsJson ? assetBase + assets.conceptsJson : '';
  const katexJsUrl = assets.katexJs ? assetBase + assets.katexJs : '';
  const axiomaticUrl =
    dualMode && page.axiomaticViewUrl ? assetBase + page.axiomaticViewUrl : '';

  const detailToggleHtml = `<button type="button" class="btn btn-ghost btn-sm detail-toggle-all-btn" id="article-toggle-details" aria-expanded="false" hidden><span class="label-expand">展开本节证明</span><span class="label-collapse">收起本节证明</span></button>`;

  const prefsBarHtml = dualMode
    ? `<div class="reading-style-bar" id="reading-style-bar">
          <div class="reading-style-primary-row">
            <div class="reading-style-controls">
              <span class="reading-style-label">阅读风格</span>
              ${renderReadingStyleToggle({ labels, defaultStyle: features.defaultReadingStyle })}
            </div>
            <div class="reading-style-controls font-theme-controls">
              <span class="reading-style-label">字体</span>
              ${renderFontThemeToggle({ defaultFontTheme: features.defaultFontTheme })}
            </div>
            <div class="reading-prefs-trail">
              ${detailToggleHtml}
              <span class="reading-style-status" id="reading-style-status" role="status" aria-live="polite"></span>
            </div>
          </div>
        </div>`
    : `<div class="reading-style-bar reading-style-bar-single" id="reading-style-bar">
          <div class="reading-style-primary-row">
            <div class="reading-style-controls font-theme-controls">
              <span class="reading-style-label">阅读字体</span>
              ${renderFontThemeToggle({ defaultFontTheme: features.defaultFontTheme })}
            </div>
            <div class="reading-prefs-trail">
              ${detailToggleHtml}
              <span class="reading-style-status" id="reading-style-status" role="status" aria-live="polite"></span>
            </div>
          </div>
        </div>`;

  const dualBodyAttrs = dualMode
    ? `
  data-axiomatic-url="${escapeHtml(axiomaticUrl)}"
  data-reading-style-explained-label="${escapeHtml(labels.explained)}"
  data-reading-style-axiomatic-label="${escapeHtml(labels.axiomatic)}"
  data-reading-style-explained-hint="${escapeHtml(labels.explainedHint)}"
  data-reading-style-axiomatic-hint="${escapeHtml(labels.axiomaticHint)}"`
    : '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang)}" data-font-theme="${escapeHtml(features.defaultFontTheme)}">
${renderHead({
  title: fullTitle,
  description: page.summary || site.description,
  assetBase,
  assets,
  storage,
  features,
})}
<body
  class="page-article"
  data-page-type="article"
  data-page-slug="${escapeHtml(page.slug || '')}"
  data-page-title="${escapeHtml(page.title || '')}"
  data-page-short-title="${escapeHtml(page.shortTitle || page.title || '')}"
  data-chapter-title="${escapeHtml(chapterTitle)}"
  data-part-title="${escapeHtml(partTitle)}"
  data-asset-base="${escapeHtml(assetBase)}"
  data-page-base="${escapeHtml(pageBase)}"
  data-concepts-url="${escapeHtml(conceptsUrl)}"
  data-katex-js-url="${escapeHtml(katexJsUrl)}"
  data-storage-prefix="${escapeHtml(storage.prefix)}"
  data-theme-key="${escapeHtml(storage.themeKey)}"
  data-export-prefix="${escapeHtml(site.exportPrefix)}"
  data-site-title="${escapeHtml(site.title)}"
  data-dual-mode="${dualMode ? 'true' : 'false'}"
  data-reading-style-default="${escapeHtml(features.defaultReadingStyle)}"
  data-font-theme-default="${escapeHtml(features.defaultFontTheme)}"${dualBodyAttrs}
  data-total-pages="${escapeHtml(totalPages)}"
>
  <a class="skip-link" href="#main-content">跳至正文内容</a>
  ${renderReadingProgress()}

  <header class="mobile-topbar">
    <button
      type="button"
      id="drawer-open"
      class="icon-btn"
      aria-label="打开课程目录"
      aria-expanded="false"
      aria-controls="toc-drawer"
    >
      ${icons.menu}
    </button>
    <div class="mobile-topbar-crumb">
      <span class="mobile-crumb-part">${escapeHtml(chapterTitle || partTitle || site.shortTitle || site.title)}</span>
      <span class="mobile-crumb-title">${escapeHtml(page.shortTitle || page.title || '')}</span>
    </div>
    <span class="mobile-progress-pill" data-mobile-progress-pct>0%</span>
    ${renderNotebookIconBtn()}
    ${renderSyncIconBtn()}
    ${renderThemeToggle()}
  </header>

  <div class="app-shell">
    <aside class="sidebar" aria-label="课程导航侧栏">
      <div class="sidebar-header">
        ${renderBrand(site, homeHref)}
        ${renderThemeToggle()}
      </div>
      <div id="sidebar-toc-slot" class="sidebar-slot">
        ${renderTocWidget({ tree, currentSlug: page.slug, homeHref, totalPages })}
      </div>
    </aside>

    <div class="content-stage${hasHeadings ? ' has-ontoc' : ''}">
      <main id="main-content" class="page-main" tabindex="-1">
        <nav class="breadcrumbs" aria-label="面包屑导航">
          <a href="${escapeHtml(homeHref)}">首页</a>
          ${partTitle ? `<span class="breadcrumb-sep" aria-hidden="true">/</span><span>${escapeHtml(partTitle)}</span>` : ''}
          ${chapterTitle ? `<span class="breadcrumb-sep" aria-hidden="true">/</span><span>${escapeHtml(chapterTitle)}</span>` : ''}
        </nav>

        <header class="article-header">
          <p class="article-kicker">
            ${renderPriorityBadge(page.priority, page.examTag)}
            <span>第 ${escapeHtml(page.order ?? (page.index ?? 0) + 1)} / ${escapeHtml(totalPages)} 节</span>
            ${page.chapter?.lectureRef ? `<span>· ${escapeHtml(page.chapter.lectureRef)}</span>` : ''}
          </p>
          <h1 class="article-title">${escapeHtml(page.title || '')}</h1>
          ${page.summary ? `<p class="article-summary">${escapeHtml(page.summary)}</p>` : ''}
          <div class="article-meta-bar">
            <div class="article-meta-pills">
              <span class="meta-pill" data-meta-read-minutes${page.readMinutes ? '' : ' hidden'}>${page.readMinutes ? `预计 ${escapeHtml(page.readMinutes)} 分钟` : ''}</span>
              <span class="meta-pill" data-meta-word-count${page.wordCount ? '' : ' hidden'}>${page.wordCount ? `约 ${escapeHtml(page.wordCount)} 字` : ''}</span>
              ${Array.isArray(page.homeworkRefs) && page.homeworkRefs.length > 0 ? `<span class="meta-pill">对标作业：${escapeHtml(page.homeworkRefs.join('、'))}</span>` : ''}
              <span class="meta-pill" data-meta-concept-count${typeof page.referencedConceptCount === 'number' && page.referencedConceptCount > 0 ? '' : ' hidden'}>${typeof page.referencedConceptCount === 'number' && page.referencedConceptCount > 0 ? `含 ${escapeHtml(page.referencedConceptCount)} 个前置概念速览` : ''}</span>
            </div>
            <button type="button" class="read-toggle-btn" data-read-toggle aria-pressed="false">
              ${icons.check}
              <span data-read-toggle-label>标记为已读</span>
            </button>
          </div>
          ${definedConceptsHtml}
        </header>

        ${prefsBarHtml}

        <div id="inline-toc-slot">
          ${inlineTocHtml}
        </div>

        <article id="article-body" class="prose">
${articleHtml}
        </article>

        <footer class="article-footer">
          <div class="article-completion-strip">
            <button type="button" class="read-toggle-btn" data-read-toggle aria-pressed="false">
              ${icons.check}
              <span data-read-toggle-label>标记为已读</span>
            </button>
          </div>

          <div id="pager-mode-banner" class="pager-mode-banner" hidden>
            <span id="pager-mode-text"></span>
            <button type="button" id="pager-mode-reset" class="btn btn-ghost btn-sm">恢复全部顺序</button>
          </div>

          <nav id="page-pager" class="pager-nav" aria-label="上下小节切换">
            ${prevCardHtml}
            ${nextCardHtml}
          </nav>

          ${renderSiteFooter(site)}
        </footer>
      </main>

      ${rightOnTocHtml}
    </div>
  </div>

  ${renderMobileDrawer(site, homeHref)}
  ${renderRecallPopover()}
  ${renderSelectionToolbar()}
  ${renderNotebookDrawer({ isArticle: true })}
  ${renderSyncDialog()}
  ${renderToastRegion()}
</body>
</html>
`;
}

/**
 * Renders the static 404 fallback page with relative paths.
 */
export function renderNotFound(ctx) {
  const {
    assetBase = './',
    pageBase = './pages/',
    homeHref = './index.html',
    assets = {},
  } = ctx;

  const { site, storage, features } = resolveTemplateConfig(ctx);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(site.lang)}" data-font-theme="${escapeHtml(features.defaultFontTheme)}">
${renderHead({
  title: `页面未找到 · ${site.title}`,
  description: '请求的讲义页面不存在或路径已变更。',
  assetBase,
  assets,
  storage,
  features,
})}
<body
  class="page-not-found"
  data-page-type="404"
  data-asset-base="${escapeHtml(assetBase)}"
  data-page-base="${escapeHtml(pageBase)}"
  data-storage-prefix="${escapeHtml(storage.prefix)}"
  data-theme-key="${escapeHtml(storage.themeKey)}"
  data-export-prefix="${escapeHtml(site.exportPrefix)}"
  data-site-title="${escapeHtml(site.title)}"
  data-dual-mode="${features.dualReadingStyle ? 'true' : 'false'}"
  data-reading-style-default="${escapeHtml(features.defaultReadingStyle)}"
  data-font-theme-default="${escapeHtml(features.defaultFontTheme)}"
>
  <header class="home-topbar">
    <div class="home-topbar-inner">
      ${renderBrand(site, homeHref)}
      <div class="home-topbar-actions">
        ${renderThemeToggle()}
      </div>
    </div>
  </header>

  <main class="not-found-main">
    <p class="not-found-code" aria-hidden="true">404</p>
    <h1 class="not-found-title">未找到该讲义小节</h1>
    <p class="not-found-desc">你访问的页面可能已移动或链接有误。你可以返回课程总览，或直接回到上次阅读的小节。</p>
    <div class="continue-actions" style="justify-content: center;">
      <a class="btn btn-primary" href="${escapeHtml(homeHref)}">返回课程首页</a>
      <a id="notfound-continue-link" class="btn" href="${escapeHtml(homeHref)}" hidden>继续上次阅读 →</a>
    </div>
  </main>
</body>
</html>
`;
}
