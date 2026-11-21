/**
 * Shared HTML template helpers for notes-site-base static study sites.
 * Zero framework dependencies; pure semantic HTML5 matching modern-web-guidance.
 */

export const FONT_THEME_HINTS = Object.freeze({
  serif: 'Claude 出版风：Source Serif 4 + 思源宋体',
  wenkai: '温和讲义风：Source Serif 4 + 霞鹜文楷',
  sans: '简洁无衬线：Inter + 系统黑体',
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsLiteral(value) {
  return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
}

export function normalizePriority(value) {
  return value === 'core' || value === 'high' ? value : 'normal';
}

/**
 * Resolves normalized site, storage, feature, and exam group settings from
 * template render context (`ctx.config` + `ctx.site` overrides).
 */
export function resolveTemplateConfig(ctx = {}) {
  const cfg = ctx.config && typeof ctx.config === 'object' ? ctx.config : {};
  const rawSite = {
    ...(cfg.site || {}),
    ...(ctx.site || {}),
  };
  const rawStorage = {
    ...(cfg.storage || {}),
    ...(ctx.storage || {}),
  };
  const rawFeatures = {
    ...(cfg.features || {}),
    ...(ctx.features || {}),
  };
  const rawLabels = {
    ...(cfg.features?.readingStyleLabels || {}),
    ...(ctx.features?.readingStyleLabels || {}),
  };

  const title = rawSite.title || '课程讲义站';
  const shortTitle = rawSite.shortTitle || title;
  const subtitle = rawSite.subtitle || 'Interactive Study Notes';
  const description =
    rawSite.description || '面向移动阅读与期末复习优化的微课化静态讲义站。';
  const brandMark =
    typeof rawSite.brandMark === 'string' && rawSite.brandMark.trim()
      ? rawSite.brandMark.trim()
      : 'N';
  const heroBadge =
    typeof rawSite.heroBadge === 'string'
      ? rawSite.heroBadge.trim()
      : '交互式分层讲义 · 概念速览 · 划词笔记 · 云端同步';
  const footerNote =
    typeof rawSite.footerNote === 'string'
      ? rawSite.footerNote.trim()
      : '纯静态离线友好学习站';
  const exportPrefix = rawSite.exportPrefix || shortTitle || title || '学习讲义';
  const lang = rawSite.lang || 'zh-CN';

  const storagePrefix =
    typeof rawStorage.prefix === 'string' && rawStorage.prefix.trim()
      ? rawStorage.prefix.trim()
      : 'notes:v1';
  const themeKey =
    typeof rawStorage.themeKey === 'string' && rawStorage.themeKey.trim()
      ? rawStorage.themeKey.trim()
      : 'notes-color-scheme';

  const dualReadingStyle = rawFeatures.dualReadingStyle !== false;
  const defaultReadingStyle =
    rawFeatures.defaultReadingStyle === 'axiomatic' ? 'axiomatic' : 'explained';
  const defaultFontTheme =
    rawFeatures.defaultFontTheme === 'wenkai' || rawFeatures.defaultFontTheme === 'sans'
      ? rawFeatures.defaultFontTheme
      : 'serif';

  const readingStyleLabels = {
    explained: rawLabels.explained || '讲解式',
    axiomatic: rawLabels.axiomatic || '公理版',
    explainedHint: rawLabels.explainedHint || '从直觉与例子出发循序推导',
    axiomaticHint: rawLabels.axiomaticHint || '精简定义与考纲标准证明',
  };

  const examGroupLabels = {
    ...(cfg.examOverview?.groupLabels || {}),
    ...(ctx.examOverview?.groupLabels || {}),
  };

  return {
    site: {
      ...rawSite,
      title,
      shortTitle,
      subtitle,
      description,
      brandMark,
      heroBadge,
      footerNote,
      exportPrefix,
      lang,
    },
    storage: {
      prefix: storagePrefix,
      themeKey,
    },
    features: {
      dualReadingStyle,
      defaultReadingStyle,
      defaultFontTheme,
      readingStyleLabels,
    },
    examGroupLabels,
  };
}

export function renderPriorityBadge(priority, examTag = '', { compact = false } = {}) {
  const p = normalizePriority(priority);
  if (p === 'normal') return '';
  const defaultLabel = p === 'core' ? (compact ? '必考' : '核心必考') : compact ? '重点' : '高频重点';
  const label = compact ? defaultLabel : examTag || defaultLabel;
  const compactClass = compact ? ' priority-badge-compact' : '';
  return `<span class="priority-badge priority-badge-${p}${compactClass}">${escapeHtml(label)}</span>`;
}

export function renderReadingStyleToggle({
  compact = false,
  labels = {},
  defaultStyle = 'explained',
} = {}) {
  const explainedLabel = labels.explained || '讲解式';
  const axiomaticLabel = labels.axiomatic || '公理版';
  const explainedHint = labels.explainedHint || '从直觉与例子出发循序推导';
  const axiomaticHint = labels.axiomaticHint || '精简定义与考纲标准证明';
  const isAxiomatic = defaultStyle === 'axiomatic';
  const cls = compact
    ? 'reading-style-group reading-style-group-compact'
    : 'reading-style-group';
  return `<div class="${cls}" role="group" aria-label="切换讲义阅读风格">
  <button type="button" class="reading-style-btn" data-reading-style-btn="explained" aria-pressed="${isAxiomatic ? 'false' : 'true'}" title="${escapeHtml(explainedHint)}（进入各节讲义生效）">${escapeHtml(explainedLabel)}</button>
  <button type="button" class="reading-style-btn" data-reading-style-btn="axiomatic" aria-pressed="${isAxiomatic ? 'true' : 'false'}" title="${escapeHtml(axiomaticHint)}（进入各节讲义生效）">${escapeHtml(axiomaticLabel)}</button>
</div>`;
}

export function renderFontThemeToggle({ compact = false, defaultFontTheme = 'serif' } = {}) {
  const active =
    defaultFontTheme === 'wenkai' || defaultFontTheme === 'sans'
      ? defaultFontTheme
      : 'serif';
  const cls = compact
    ? 'reading-style-group font-theme-group reading-style-group-compact'
    : 'reading-style-group font-theme-group';
  return `<div class="${cls}" role="group" aria-label="切换阅读字体">
  <button type="button" class="reading-style-btn font-theme-btn" data-font-theme-btn="serif" aria-pressed="${active === 'serif' ? 'true' : 'false'}" title="${escapeHtml(FONT_THEME_HINTS.serif)}">宋体</button>
  <button type="button" class="reading-style-btn font-theme-btn" data-font-theme-btn="wenkai" aria-pressed="${active === 'wenkai' ? 'true' : 'false'}" title="${escapeHtml(FONT_THEME_HINTS.wenkai)}">文楷</button>
  <button type="button" class="reading-style-btn font-theme-btn" data-font-theme-btn="sans" aria-pressed="${active === 'sans' ? 'true' : 'false'}" title="${escapeHtml(FONT_THEME_HINTS.sans)}">黑体</button>
</div>`;
}

export function renderPriorityFilterBar({ targetId, ariaLabel, compact = false }) {
  return `<div class="priority-filter-bar" role="group" aria-label="${escapeHtml(ariaLabel)}" data-priority-bar="${escapeHtml(targetId)}">
  <button type="button" class="priority-filter-btn" data-priority-filter="all" aria-pressed="true">全部</button>
  <button type="button" class="priority-filter-btn" data-priority-filter="core" aria-pressed="false">${compact ? '仅看必考' : '核心必考'}</button>
  <button type="button" class="priority-filter-btn" data-priority-filter="important" aria-pressed="false">${compact ? '必考+重点' : '必考 + 重点'}</button>
</div>`;
}

export function renderIcons() {
  return {
    menu: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    close: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
    moon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    sun: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
    search: `<svg class="search-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`,
    check: `<svg class="read-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6L9 17l-5-5"/></svg>`,
    notebook: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h6M9 11h6"/></svg>`,
    cloud: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
  };
}

export function renderNotebookIconBtn() {
  const icons = renderIcons();
  return `<button type="button" class="icon-btn" data-open-notebook aria-label="打开我的笔记本" title="我的笔记本">
  ${icons.notebook}
  <span class="icon-badge" data-notebook-count hidden>0</span>
</button>`;
}

export function renderSyncIconBtn() {
  const icons = renderIcons();
  return `<button type="button" class="icon-btn" data-open-sync aria-label="云端同步设置" title="云端同步">
  ${icons.cloud}
  <span class="sync-dot" data-sync-dot data-sync-state="idle" aria-hidden="true"></span>
</button>`;
}

export function renderThemeToggle() {
  const icons = renderIcons();
  return `<button type="button" class="icon-btn theme-toggle" data-theme-toggle title="切换浅色/深色主题">
  <span class="theme-option theme-to-dark">${icons.moon}<span class="sr-only">切换到深色模式</span></span>
  <span class="theme-option theme-to-light">${icons.sun}<span class="sr-only">切换到浅色模式</span></span>
</button>`;
}

export function renderHead({ title, description, assetBase, assets, config, storage, features }) {
  const resolved = resolveTemplateConfig({ config, storage, features });
  const styles = (assets?.styles ?? [])
    .map((href) => `  <link rel="stylesheet" href="${escapeHtml(assetBase + href)}">`)
    .join('\n');

  const scripts = (assets?.scripts ?? [])
    .map((src) => `  <script src="${escapeHtml(assetBase + src)}" defer></script>`)
    .join('\n');

  const themeKeyLit = safeJsLiteral(resolved.storage.themeKey);
  const rsKeyLit = safeJsLiteral(`${resolved.storage.prefix}:readingStyle`);
  const rsDefLit = safeJsLiteral(resolved.features.defaultReadingStyle);
  const ftKeyLit = safeJsLiteral(`${resolved.storage.prefix}:fontTheme`);
  const ftDefLit = safeJsLiteral(resolved.features.defaultFontTheme);

  const themeBoot = `try{var s=localStorage.getItem(${themeKeyLit});if(s==="light"||s==="dark"){document.querySelector('meta[name="color-scheme"]').content=s;}}catch(e){}`;
  const readingStyleBoot = resolved.features.dualReadingStyle
    ? `try{var rsRaw=localStorage.getItem(${rsKeyLit}),rs=${rsDefLit};if(rsRaw){if(rsRaw==="axiomatic"||rsRaw==="explained"){rs=rsRaw;}else{var rsObj=JSON.parse(rsRaw);if(rsObj&&(rsObj.value==="axiomatic"||rsObj.value==="explained")){rs=rsObj.value;}}}document.documentElement.dataset.readingStyle=rs;if(rs==="axiomatic"){document.documentElement.dataset.readingStylePending="true";}}catch(e){document.documentElement.dataset.readingStyle=${rsDefLit};}`
    : '';
  const fontThemeBoot = `try{var ftRaw=localStorage.getItem(${ftKeyLit}),ft=${ftDefLit};if(ftRaw){if(ftRaw==="serif"||ftRaw==="wenkai"||ftRaw==="sans"){ft=ftRaw;}else{var ftObj=JSON.parse(ftRaw);if(ftObj&&(ftObj.value==="serif"||ftObj.value==="wenkai"||ftObj.value==="sans")){ft=ftObj.value;}}}document.documentElement.dataset.fontTheme=ft;}catch(e){document.documentElement.dataset.fontTheme=${ftDefLit};}`;

  return `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <script>${themeBoot}${readingStyleBoot}${fontThemeBoot}</script>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
${styles}
${scripts}
</head>`;
}

export function renderReadingProgress() {
  return `<div id="reading-progress" class="reading-progress" aria-hidden="true"></div>`;
}

export function renderBrand(site, homeHref) {
  const title = site?.title || '课程讲义站';
  const subtitle = site?.subtitle || 'Interactive Study Notes';
  const brandMark =
    typeof site?.brandMark === 'string' && site.brandMark.trim()
      ? site.brandMark.trim()
      : 'N';
  return `<a class="brand-link" href="${escapeHtml(homeHref)}">
  <span class="brand-mark" aria-hidden="true">${escapeHtml(brandMark)}</span>
  <span class="brand-text">
    <span class="brand-title">${escapeHtml(title)}</span>
    <span class="brand-subtitle">${escapeHtml(subtitle)}</span>
  </span>
</a>`;
}

/**
 * Renders the 3-level Part -> Chapter -> Micro-page collapsible TOC.
 * Uses semantic <details>/<summary> with NO heading tags inside <summary>.
 */
export function renderTocWidget({ tree, currentSlug, homeHref, totalPages }) {
  const icons = renderIcons();

  const partsHtml = (tree ?? [])
    .map((part) => {
      const chapters = part.chapters ?? [];
      const partHasCurrent = chapters.some((ch) =>
        (ch.pages ?? []).some((p) => p.slug === currentSlug)
      );
      const partPageCount = chapters.reduce(
        (sum, ch) => sum + (ch.pages?.length ?? 0),
        0
      );

      const chaptersHtml = chapters
        .map((ch) => {
          const pages = ch.pages ?? [];
          const chHasCurrent = pages.some((p) => p.slug === currentSlug);

          const pagesHtml = pages
            .map((p) => {
              const isCurrent = p.slug === currentSlug;
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

              return `<li class="toc-page-item" data-toc-page="${escapeHtml(p.slug)}" data-priority="${priority}" data-chapter-title="${escapeHtml(ch.shortTitle || ch.title)}" data-page-title="${escapeHtml(p.shortTitle || p.title)}" data-search-text="${escapeHtml(searchHaystack)}">
  <a class="toc-page-link" href="${escapeHtml(p.href)}" data-slug="${escapeHtml(p.slug)}"${isCurrent ? ' aria-current="page"' : ''}>
    <span class="toc-check" aria-hidden="true">✓</span>
    <span class="toc-page-label">${escapeHtml(p.shortTitle || p.title)}</span>
    ${badgeHtml}
    ${p.readMinutes ? `<span class="toc-page-mins">${escapeHtml(p.readMinutes)}m</span>` : ''}
  </a>
</li>`;
            })
            .join('\n');

          return `<details class="toc-chapter" data-toc-chapter="${escapeHtml(ch.id)}"${chHasCurrent ? ' open' : ''}>
  <summary><span class="toc-chapter-title">${escapeHtml(ch.shortTitle || ch.title)}</span></summary>
  <ul class="toc-page-list">
${pagesHtml}
  </ul>
</details>`;
        })
        .join('\n');

      return `<details class="toc-part" data-toc-part="${escapeHtml(part.id)}"${partHasCurrent ? ' open' : ''}>
  <summary>
    <span class="toc-part-title">${escapeHtml(part.shortTitle || part.title)}</span>
    <span class="toc-part-badge" data-part-progress="${escapeHtml(part.id)}">0/${partPageCount}</span>
  </summary>
  <div class="toc-part-body">
${chaptersHtml}
  </div>
</details>`;
    })
    .join('\n');

  return `<div id="toc-mount" class="toc-root">
  <div class="toc-progress-box">
    <div class="toc-progress-meta">
      <span>学习进度</span>
      <span class="toc-progress-count" data-overall-progress-text>0 / ${escapeHtml(totalPages)} 节</span>
    </div>
    <div class="progress-track" role="progressbar" aria-label="总体学习进度" aria-valuemin="0" aria-valuemax="${escapeHtml(totalPages)}" aria-valuenow="0" data-overall-progressbar>
      <span class="progress-fill" data-overall-progress-fill></span>
    </div>
  </div>
  <div class="toc-toolbar">
    <label class="search-input-wrap">
      <span class="sr-only">筛选课程目录</span>
      ${icons.search}
      <input type="search" id="toc-filter" class="search-input" placeholder="搜索讲次或知识点…" autocomplete="off">
    </label>
    <button type="button" class="btn btn-ghost btn-sm" commandfor="toc-tree-list" command="--toggle-all" aria-expanded="false" data-toggle-all="toc-tree-list" title="展开或收起全部目录">
      <span class="label-expand">展开</span>
      <span class="label-collapse">收起</span>
    </button>
  </div>
  <div class="toc-priority-wrap">
    ${renderPriorityFilterBar({ targetId: 'toc-tree-list', ariaLabel: '按考点分级筛选目录', compact: true })}
    <div id="toc-filter-meta" class="toc-filter-meta" hidden>
      <span id="toc-filter-summary"></span>
      <button type="button" id="toc-current-mismatch" class="toc-mismatch-btn" hidden>本节不在当前筛选范围 · 显示全部</button>
    </div>
  </div>
  <div class="sidebar-tools">
    <button type="button" class="sidebar-tool-btn" data-open-notebook aria-label="打开我的笔记本">
      ${icons.notebook}
      <span>笔记本</span>
      <span class="count-pill" data-notebook-count aria-hidden="true" hidden>0</span>
    </button>
    <button type="button" class="sidebar-tool-btn" data-open-sync aria-label="云端同步设置（未绑定）" title="云端同步设置（未绑定）">
      ${icons.cloud}
      <span>云端同步</span>
      <span class="sync-dot" data-sync-dot data-sync-state="idle" aria-hidden="true"></span>
    </button>
  </div>
  <nav class="toc-scroll" aria-label="课程三级目录">
    <div id="toc-tree-list" class="toc-tree-list">
${partsHtml}
    </div>
    <p id="toc-empty" class="toc-empty-state" hidden>未找到匹配的章节，请尝试其他关键词。</p>
  </nav>
  <div class="toc-footer">
    <a href="${escapeHtml(homeHref)}">← 返回课程总览</a>
    <button type="button" class="btn btn-ghost btn-sm" data-reset-progress>重置进度</button>
  </div>
</div>`;
}

/**
 * Renders the dedicated mobile swipe-to-dismiss native <dialog> navigation drawer.
 * Follows modern-web-guidance: navigation-drawer + prevent-page-scroll-under-modal-dialog.
 */
export function renderMobileDrawer(site, homeHref) {
  const icons = renderIcons();
  return `<dialog class="toc-drawer" id="toc-drawer" aria-label="课程目录抽屉">
  <div class="toc-drawer-scroller">
    <div class="toc-drawer-sheet">
      <div class="toc-drawer-header">
        ${renderBrand(site, homeHref)}
        <button type="button" id="drawer-close" class="icon-btn" aria-label="关闭课程目录" autofocus>
          ${icons.close}
        </button>
      </div>
      <div id="drawer-toc-slot" class="toc-drawer-slot"></div>
    </div>
  </div>
</dialog>`;
}

/**
 * Renders the reusable native Popover API Concept Recall Card.
 * Positioned via CSS Anchor Positioning on desktop (with JS fallback) and
 * bottom sheet on screens <= 640px.
 */
export function renderRecallPopover() {
  const icons = renderIcons();
  return `<div id="concept-popover" popover="auto" class="recall-card" role="dialog" aria-labelledby="recall-term" aria-describedby="recall-brief">
  <div class="recall-sheet-handle" aria-hidden="true"></div>
  <div class="recall-card-inner">
    <div class="recall-card-header">
      <div>
        <div class="recall-meta-row">
          <span id="recall-category" class="recall-category"></span>
          <span id="recall-priority" class="priority-badge" hidden></span>
        </div>
        <h2 id="recall-term" class="recall-term"></h2>
      </div>
      <button type="button" id="recall-close-icon" class="icon-btn" aria-label="关闭概念速览">
        ${icons.close}
      </button>
    </div>
    <div id="recall-brief" class="recall-brief"></div>
    <div id="recall-formula" class="recall-formula" hidden></div>
    <div class="recall-actions">
      <a id="recall-link" class="btn btn-primary btn-sm" href="#">前往详情页 →</a>
      <button type="button" id="recall-save-note" class="btn btn-sm">＋ 收藏笔记</button>
      <button type="button" id="recall-close" class="btn btn-ghost btn-sm">关闭</button>
    </div>
  </div>
</div>`;
}

/**
 * Renders the highlight-to-notebook floating action bar (popover="manual").
 */
export function renderSelectionToolbar() {
  const icons = renderIcons();
  return `<div id="selection-toolbar" popover="manual" class="selection-toolbar" role="toolbar" aria-label="划词笔记操作">
  <button type="button" id="sel-quick-save" class="btn btn-primary btn-sm">＋ 加入笔记本</button>
  <button type="button" id="sel-annotate-save" class="btn btn-sm">带批注收藏</button>
  <button type="button" id="sel-dismiss" class="icon-btn selection-close-btn" aria-label="关闭划词工具栏">
    ${icons.close}
  </button>
</div>`;
}

/**
 * Renders the native modal <dialog> slide-over Notebook Drawer ("我的笔记本").
 * Follows modern-web-guidance: dialog (no redundant role="dialog" / aria-modal).
 */
export function renderNotebookDrawer({ isArticle = false } = {}) {
  const icons = renderIcons();
  const tags = ['全部', '摘录', '必背', '易错', '疑问', '概念'];
  const composerTags = ['摘录', '必背', '易错', '疑问', '概念'];

  return `<dialog id="notebook-drawer" class="notebook-drawer" closedby="any" aria-label="我的笔记本">
  <div class="nb-header">
    <div class="nb-title-wrap">
      <h2 class="nb-title">我的笔记本</h2>
      <span class="count-pill" data-notebook-count>0</span>
    </div>
    <div class="nb-header-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-open-sync title="云端同步设置">
        <span class="sync-dot" data-sync-dot data-sync-state="idle" aria-hidden="true"></span>
        <span>同步</span>
      </button>
      <button type="button" id="notebook-close" class="icon-btn" aria-label="关闭笔记本" autofocus>
        ${icons.close}
      </button>
    </div>
  </div>

  <div class="nb-toolbar">
    <div class="nb-action-row">
      <button type="button" id="nb-new-note-btn" class="btn btn-primary btn-sm">${isArticle ? '＋ 新建本页笔记' : '＋ 新建学习笔记'}</button>
      <button type="button" id="nb-export-md" class="btn btn-sm">导出 .md</button>
      <button type="button" id="nb-copy-md" class="btn btn-sm">复制 Markdown</button>
      <span id="nb-copy-status" class="copy-status" role="status"></span>
    </div>
    <div class="nb-filter-row">
      <label class="search-input-wrap">
        <span class="sr-only">搜索笔记本内容</span>
        ${icons.search}
        <input type="search" id="nb-search" class="search-input" placeholder="搜索摘录、公式或批注…" autocomplete="off">
      </label>
      ${
        isArticle
          ? `<label class="nb-page-only-label"><input type="checkbox" id="nb-current-page-only"><span>仅看本页</span></label>`
          : ''
      }
    </div>
    <div id="nb-tag-filters" class="nb-tag-filters" role="group" aria-label="按标签筛选笔记">
      ${tags
        .map(
          (tag, idx) =>
            `<button type="button" class="nb-tag-pill" data-nb-tag-filter="${escapeHtml(tag)}" aria-pressed="${idx === 0 ? 'true' : 'false'}">${escapeHtml(tag)}</button>`
        )
        .join('\n      ')}
    </div>
  </div>

  <div class="nb-scroll">
    <form id="nb-composer" class="nb-composer" hidden>
      <div class="nb-composer-head">
        <span id="nb-composer-title">添加笔记</span>
        <span id="nb-composer-source" class="part-count"></span>
      </div>
      <div id="nb-quote-preview" class="nb-quote-preview" hidden></div>
      <label id="nb-quote-input-wrap" hidden>
        <span class="sr-only">摘录或公式内容（支持 LaTeX 公式）</span>
        <textarea id="nb-composer-quote" class="nb-textarea" rows="2" placeholder="可选：输入要点摘录或 LaTeX 公式…"></textarea>
      </label>
      <div id="nb-composer-tags" class="nb-tag-filters" role="group" aria-label="选择笔记标签">
        ${composerTags
          .map(
            (tag, idx) =>
              `<button type="button" class="nb-tag-pill" data-nb-composer-tag="${escapeHtml(tag)}" aria-pressed="${idx === 0 ? 'true' : 'false'}">${escapeHtml(tag)}</button>`
          )
          .join('\n        ')}
      </div>
      <label>
        <span class="sr-only">个人批注</span>
        <textarea id="nb-composer-note" class="nb-textarea" rows="3" placeholder="写下你的批注、记忆口诀或易错提醒…"></textarea>
      </label>
      <div class="nb-composer-actions">
        <button type="button" id="nb-composer-cancel" class="btn btn-ghost btn-sm">取消</button>
        <button type="submit" id="nb-composer-save" class="btn btn-primary btn-sm">保存笔记</button>
      </div>
    </form>

    <div id="nb-list" class="nb-list"></div>
    <div id="nb-empty" class="nb-empty" hidden>
      <p id="nb-empty-title" style="margin: 0 0 0.4rem;"><strong>笔记本还是空的</strong></p>
      <p id="nb-empty-desc" style="margin: 0;">在讲义正文中选中任意文字或数学公式即可一键「加入笔记本」，也可以在概念弹窗点击「＋ 收藏笔记」或上方手动新建。</p>
    </div>
  </div>
</dialog>`;
}

/**
 * Renders the native modal <dialog> Cloud Sync panel ("云端同步").
 * Follows modern-web-guidance: dialog (no redundant role="dialog" / aria-modal).
 */
export function renderSyncDialog() {
  const icons = renderIcons();
  return `<dialog id="sync-dialog" class="sync-dialog" closedby="any" aria-labelledby="sync-dialog-title">
  <div class="sync-dialog-head">
    <h2 id="sync-dialog-title" class="sync-dialog-title">云端同步与本机备份</h2>
    <button type="button" id="sync-close" class="icon-btn" aria-label="关闭同步设置" autofocus>
      ${icons.close}
    </button>
  </div>

  <div class="sync-dialog-body">
    <div class="sync-status-card">
      <span class="sync-status-main">
        <span class="sync-dot" data-sync-dot data-sync-state="idle" aria-hidden="true"></span>
        <span id="sync-status-text" role="status" aria-live="polite">未绑定同步码（仅本机存储）</span>
      </span>
      <span id="sync-local-stats" class="part-count"></span>
    </div>
    <span id="sync-action-status" class="copy-status" role="status" aria-live="polite"></span>

    <form id="sync-bind-form" class="sync-section">
      <h3 class="sync-section-title">免注册同步码（跨手机 / 电脑自动同步进度与笔记）</h3>
      <p class="sync-hint">同步码经 HTTPS 传输后在云端经 SHA-256 单向映射为空间 ID，服务器不存明文，遗忘后无法找回。请勿使用 123456 等简单口令以免与他人撞码，强烈建议点击「生成随机同步码」。</p>
      <label for="sync-code-input" class="sr-only">云端同步码</label>
      <input
        id="sync-code-input"
        type="text"
        class="sync-input"
        minlength="6"
        maxlength="128"
        autocomplete="off"
        spellcheck="false"
        placeholder="输入至少 6 位同步码（支持字母/数字/中文），或点击下方生成"
      >
      <div class="sync-form-row">
        <button type="button" id="sync-gen-btn" class="btn btn-sm">生成随机同步码</button>
        <button type="submit" id="sync-bind-btn" class="btn btn-primary btn-sm">绑定并立即同步</button>
      </div>
    </form>

    <div id="sync-bound-section" class="sync-section" hidden>
      <hr class="sync-divider">
      <h3 class="sync-section-title">当前已绑定同步空间</h3>
      <div class="sync-code-box">
        <span id="sync-code-display">••••-••••</span>
        <button type="button" id="sync-toggle-mask" class="btn btn-ghost btn-sm" aria-label="显示同步码明文">显示</button>
      </div>
      <div class="sync-form-row">
        <button type="button" id="sync-copy-code" class="btn btn-sm">复制同步码</button>
        <button type="button" id="sync-copy-link" class="btn btn-sm">复制免输绑定链接</button>
        <button type="button" id="sync-now-btn" class="btn btn-primary btn-sm">立即同步</button>
      </div>
      <span id="sync-copy-status" class="copy-status" role="status" aria-live="polite"></span>
      <p class="sync-hint">免输绑定链接通过 URL <code>#sync=</code> 片段传输，打开后自动从地址栏清除、不留服务器日志。⚠️ 持有同步码或此链接者均可读写或清空该云端空间，请仅发给自己的设备，切勿发入公开群聊。</p>
      <div class="sync-form-row">
        <button type="button" id="sync-unlink-btn" class="btn btn-ghost btn-sm">解除绑定（保留本地）</button>
        <button type="button" id="sync-clear-cloud-btn" class="btn btn-danger btn-sm">清空云端数据</button>
      </div>
    </div>

    <hr class="sync-divider">

    <div class="sync-section">
      <h3 class="sync-section-title">离线备份与恢复（JSON）</h3>
      <p class="sync-hint">无需网络也可随时将全部阅读进度与笔记本导出为 JSON 存档，或在其他设备导入合并。</p>
      <div class="sync-form-row">
        <button type="button" id="sync-export-json" class="btn btn-sm">导出备份 JSON</button>
        <button type="button" id="sync-import-btn" class="btn btn-sm">导入并合并 JSON</button>
        <input type="file" id="sync-import-file" accept="application/json,.json" hidden>
      </div>
      <span id="sync-backup-status" class="copy-status" role="status" aria-live="polite"></span>
    </div>
  </div>
</dialog>`;
}

/**
 * Renders the persistent-toast-notifications compliant manual popover toast
 * and accessible fallback live region for ariaNotify().
 */
export function renderToastRegion() {
  return `<div class="toast-region" role="region" aria-label="阅读状态通知">
  <div id="reading-toast" popover="manual" class="reading-toast">
    <span id="reading-toast-message" class="toast-message"></span>
    <span class="toast-actions">
      <button type="button" id="reading-toast-action" class="btn btn-primary btn-sm" hidden></button>
      <button type="button" id="reading-toast-top" class="btn btn-ghost btn-sm" hidden>回到顶部</button>
      <button type="button" id="reading-toast-close" class="btn btn-ghost btn-sm" popovertarget="reading-toast" popovertargetaction="hide">关闭</button>
    </span>
  </div>
</div>
<p id="sr-announcer-label" class="sr-only" hidden>屏幕阅读器状态播报</p>
<div id="sr-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>`;
}

export function renderSiteFooter(site) {
  const title = site?.title || '课程讲义站';
  const note =
    typeof site?.footerNote === 'string'
      ? site.footerNote.trim()
      : '纯静态离线友好学习站';
  const leftText = note ? `${title} · ${note}` : title;
  return `<footer class="site-footer">
  <span>${escapeHtml(leftText)}</span>
  <span>公式由 KaTeX 构建期预渲染 · 阅读进度与划词笔记本机自动保存，支持免注册云端同步</span>
</footer>`;
}
