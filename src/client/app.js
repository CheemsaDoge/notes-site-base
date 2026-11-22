(() => {
  'use strict';

  const body = document.body;
  if (!body) return;

  const storagePrefix = (body.dataset.storagePrefix || 'notes:v1').trim() || 'notes:v1';
  const themeKey = (body.dataset.themeKey || 'notes-color-scheme').trim() || 'notes-color-scheme';
  const exportPrefix =
    (body.dataset.exportPrefix || body.dataset.siteTitle || '学习讲义').trim() || '学习讲义';
  const dualMode = body.dataset.dualMode !== 'false';
  const defaultReadingStyle =
    body.dataset.readingStyleDefault === 'axiomatic' ? 'axiomatic' : 'explained';
  const defaultFontTheme =
    body.dataset.fontThemeDefault === 'wenkai' || body.dataset.fontThemeDefault === 'sans'
      ? body.dataset.fontThemeDefault
      : 'serif';

  const STORAGE = {
    theme: themeKey,
    lastVisited: `${storagePrefix}:lastVisited`,
    scroll: `${storagePrefix}:scroll`,
    read: `${storagePrefix}:read`,
    readTombstones: `${storagePrefix}:readTombstones`,
    resetAt: `${storagePrefix}:resetAt`,
    priorityMode: `${storagePrefix}:priorityMode`,
    readingStyle: `${storagePrefix}:readingStyle`,
    fontTheme: `${storagePrefix}:fontTheme`,
    jumpIntent: `${storagePrefix}:jumpIntent`,
  };

  const pageType = body.dataset.pageType || '';
  const currentSlug = body.dataset.pageSlug || '';
  const assetBase = body.dataset.assetBase || './';
  const pageBase = body.dataset.pageBase || './';
  const conceptsUrl = body.dataset.conceptsUrl || '';
  const totalPages = Math.max(1, Number(body.dataset.totalPages) || 0);

  const reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkSchemeMql = window.matchMedia('(prefers-color-scheme: dark)');
  const mobileLayoutMql = window.matchMedia('(max-width: 960px)');
  const sheetViewportMql = window.matchMedia('(max-width: 640px)');

  const hasNativePopover = Object.hasOwn(HTMLElement.prototype, 'popover');
  const supportsAnchorArea = Boolean(
    window.CSS?.supports?.('position-area: block-end') &&
      window.CSS?.supports?.('anchor-name: --a')
  );

  /* ========================================================================
     Safe Storage Helpers
     ======================================================================== */

  function readStorageJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorageJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable (private mode / quota); keep UI working gracefully.
    }
  }

  function removeStorageKey(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage errors.
    }
  }

  /* Normalized Progress & Priority State Helpers (compatible with /api/sync) */

  function normalizePriorityModeValue(val) {
    return val === 'core' || val === 'important' ? val : 'all';
  }

  function normalizeReadingStyleValue(val) {
    if (val === 'axiomatic' || val === 'explained') return val;
    return defaultReadingStyle;
  }

  function getReadingStyleState() {
    try {
      const rawStr = localStorage.getItem(STORAGE.readingStyle);
      if (!rawStr) return { value: defaultReadingStyle, updatedAt: 0 };
      if (rawStr === 'axiomatic' || rawStr === 'explained') {
        return { value: rawStr, updatedAt: 0 };
      }
      const parsed = JSON.parse(rawStr);
      if (parsed && typeof parsed === 'object') {
        return {
          value: normalizeReadingStyleValue(parsed.value),
          updatedAt:
            typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
              ? parsed.updatedAt
              : 0,
        };
      }
    } catch {
      // Fall back to default reading style.
    }
    return { value: defaultReadingStyle, updatedAt: 0 };
  }

  function resolvePrefTimestamp(updatedAt) {
    return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
      ? Math.floor(updatedAt)
      : Date.now();
  }

  function saveReadingStyleState(value, updatedAt = Date.now()) {
    const normalized = {
      value: normalizeReadingStyleValue(value),
      updatedAt: resolvePrefTimestamp(updatedAt),
    };
    writeStorageJson(STORAGE.readingStyle, normalized);
    document.documentElement.dataset.readingStyle = normalized.value;
    return normalized;
  }

  function normalizeFontThemeValue(val) {
    if (val === 'serif' || val === 'wenkai' || val === 'sans') return val;
    return defaultFontTheme;
  }

  function getFontThemeState() {
    try {
      const rawStr = localStorage.getItem(STORAGE.fontTheme);
      if (!rawStr) return { value: defaultFontTheme, updatedAt: 0 };
      if (rawStr === 'serif' || rawStr === 'wenkai' || rawStr === 'sans') {
        return { value: rawStr, updatedAt: 0 };
      }
      const parsed = JSON.parse(rawStr);
      if (parsed && typeof parsed === 'object') {
        return {
          value: normalizeFontThemeValue(parsed.value),
          updatedAt:
            typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
              ? parsed.updatedAt
              : 0,
        };
      }
    } catch {
      // Fall back to default font theme.
    }
    return { value: defaultFontTheme, updatedAt: 0 };
  }

  function saveFontThemeState(value, updatedAt = Date.now()) {
    const normalized = {
      value: normalizeFontThemeValue(value),
      updatedAt: resolvePrefTimestamp(updatedAt),
    };
    writeStorageJson(STORAGE.fontTheme, normalized);
    document.documentElement.dataset.fontTheme = normalized.value;
    return normalized;
  }

  function getReadPagesMap() {
    const raw = readStorageJson(STORAGE.read, {});
    const out = {};
    let migrated = false;
    const now = Date.now();
    for (const [slug, val] of Object.entries(raw)) {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        out[slug] = val;
      } else if (val === true) {
        out[slug] = now;
        migrated = true;
      }
    }
    if (migrated) writeStorageJson(STORAGE.read, out);
    return out;
  }

  function getReadTombstonesMap() {
    const raw = readStorageJson(STORAGE.readTombstones, {});
    const out = {};
    for (const [slug, val] of Object.entries(raw)) {
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        out[slug] = val;
      }
    }
    return out;
  }

  function getResetAt() {
    try {
      const n = Number(localStorage.getItem(STORAGE.resetAt) || 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  function setResetAt(ts) {
    try {
      if (ts > 0) {
        localStorage.setItem(STORAGE.resetAt, String(Math.floor(ts)));
      } else {
        localStorage.removeItem(STORAGE.resetAt);
      }
    } catch {
      // Ignore storage errors.
    }
  }

  function getPriorityState() {
    const raw = readStorageJson(STORAGE.priorityMode, null);
    if (raw && typeof raw === 'object') {
      return {
        value: normalizePriorityModeValue(raw.value),
        updatedAt:
          typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0
            ? raw.updatedAt
            : 0,
      };
    }
    return { value: 'all', updatedAt: 0 };
  }

  function savePriorityState(value, updatedAt = Date.now()) {
    const normalized = {
      value: normalizePriorityModeValue(value),
      updatedAt: resolvePrefTimestamp(updatedAt),
    };
    writeStorageJson(STORAGE.priorityMode, normalized);
    return normalized;
  }

  const progressListeners = new Set();
  function onProgressChange(cb) {
    if (typeof cb === 'function') progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  }

  function emitProgressChange(reason = 'update') {
    for (const cb of progressListeners) {
      try {
        cb(reason);
      } catch {
        // Isolate subscriber failures.
      }
    }
  }

  function getProgressState() {
    return {
      resetAt: getResetAt(),
      readPages: getReadPagesMap(),
      readTombstones: getReadTombstonesMap(),
      scrollPositions: readStorageJson(STORAGE.scroll, {}),
      lastVisited: readStorageJson(STORAGE.lastVisited, null),
      priorityMode: getPriorityState(),
      readingStyle: getReadingStyleState(),
      fontTheme: getFontThemeState(),
    };
  }

  let syncFilterUI = () => {};
  let syncReadingStyleUI = () => Promise.resolve({ ok: false });
  let syncFontThemeUI = () => ({ ok: false });
  let jumpToArticleHeadingFn = () => Promise.resolve(false);
  let rebindHeadingObserver = () => {};
  let syncArticleDetailsToggle = () => {};
  let runInitialScrollOrHashRestore = () => {};

  function applyMergedProgress(progress) {
    if (!progress || typeof progress !== 'object') return;
    if (typeof progress.resetAt === 'number' && Number.isFinite(progress.resetAt)) {
      setResetAt(progress.resetAt);
    }
    if (progress.readPages && typeof progress.readPages === 'object') {
      writeStorageJson(STORAGE.read, progress.readPages);
    }
    if (progress.readTombstones && typeof progress.readTombstones === 'object') {
      writeStorageJson(STORAGE.readTombstones, progress.readTombstones);
    }
    if (progress.scrollPositions && typeof progress.scrollPositions === 'object') {
      writeStorageJson(STORAGE.scroll, progress.scrollPositions);
    }
    if (progress.lastVisited && typeof progress.lastVisited === 'object') {
      writeStorageJson(STORAGE.lastVisited, progress.lastVisited);
    } else if (progress.lastVisited === null) {
      removeStorageKey(STORAGE.lastVisited);
    }
    if (progress.priorityMode && typeof progress.priorityMode === 'object') {
      if (Number(progress.priorityMode.updatedAt) > 0) {
        savePriorityState(progress.priorityMode.value, progress.priorityMode.updatedAt);
      } else {
        removeStorageKey(STORAGE.priorityMode);
      }
    }
    if (progress.readingStyle && typeof progress.readingStyle === 'object') {
      if (Number(progress.readingStyle.updatedAt) > 0) {
        saveReadingStyleState(progress.readingStyle.value, progress.readingStyle.updatedAt);
      } else {
        removeStorageKey(STORAGE.readingStyle);
        if (dualMode) {
          document.documentElement.dataset.readingStyle = defaultReadingStyle;
        }
      }
    }
    if (progress.fontTheme && typeof progress.fontTheme === 'object') {
      if (Number(progress.fontTheme.updatedAt) > 0) {
        saveFontThemeState(progress.fontTheme.value, progress.fontTheme.updatedAt);
      } else {
        removeStorageKey(STORAGE.fontTheme);
        document.documentElement.dataset.fontTheme = defaultFontTheme;
      }
    }
    renderProgressUI();
    syncFilterUI(getPriorityState().value);
    syncReadingStyleUI(getReadingStyleState().value, {
      persist: false,
      announce: false,
      preserveScroll: true,
      source: 'sync',
    });
    syncFontThemeUI(getFontThemeState().value, {
      persist: false,
      announce: false,
      source: 'sync',
    });
  }

  /* Reusable dialog helpers per modern-web-guidance: dialog */

  function bindClosedByFallback(dialog) {
    if (!dialog) return;
    dialog.addEventListener('close', () => {
      dialog.returnValue = '';
    });

    if ('closedBy' in HTMLDialogElement.prototype) return;
    const isOutside = (event) => {
      const r = dialog.getBoundingClientRect();
      return (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      );
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (event) => {
      pressedOutside = isOutside(event);
    });
    dialog.addEventListener('pointerup', (event) => {
      if (pressedOutside && isOutside(event)) {
        closeDialogAnimated(dialog);
      }
      pressedOutside = false;
    });
  }

  async function closeDialogAnimated(dialog) {
    if (!dialog || !dialog.open) return;
    if (!supportsTopLayerExit()) {
      dialog.setAttribute('data-closing', '');
      const animations =
        typeof dialog.getAnimations === 'function'
          ? dialog.getAnimations({ subtree: true })
          : [];
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 350)),
        ]);
      }
      if (!dialog.hasAttribute('data-closing')) return;
      dialog.removeAttribute('data-closing');
    }
    if (dialog.open) dialog.close();
  }

  /* ========================================================================
     1. Dark Mode Two-State Toggle (dark-mode-toggle guidance)
     ======================================================================== */

  function initThemeToggle() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) return;

    function getSystemScheme() {
      return darkSchemeMql.matches ? 'dark' : 'light';
    }

    function getStoredScheme() {
      try {
        const val = localStorage.getItem(STORAGE.theme);
        return val === 'light' || val === 'dark' ? val : null;
      } catch {
        return null;
      }
    }

    function syncMetaFromStorage() {
      meta.content = getStoredScheme() ?? 'light dark';
    }

    function toggleTheme() {
      const stored = getStoredScheme();
      const system = getSystemScheme();
      const currentRendered = stored ?? system;
      const target = currentRendered === 'dark' ? 'light' : 'dark';

      // Divergence checked ONLY at storage time: revert to system if target matches OS.
      if (target === system) {
        removeStorageKey(STORAGE.theme);
        meta.content = 'light dark';
      } else {
        try {
          localStorage.setItem(STORAGE.theme, target);
        } catch {
          // Still apply theme even when persistence fails.
        }
        meta.content = target;
      }
    }

    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-theme-toggle]');
      if (!btn) return;
      toggleTheme();
    });

    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE.theme) {
        syncMetaFromStorage();
      }
    });
  }

  /* ========================================================================
     2. Scroll Progress Indicator Fallback (scroll-progress-indicator guidance)
     ======================================================================== */

  function initReadingProgressFallback() {
    const bar = document.getElementById('reading-progress');
    if (!bar) return;
    if (window.CSS?.supports?.('animation-timeline', 'scroll()')) return;

    let ticking = false;
    function updateBar() {
      ticking = false;
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      const ratio =
        scrollable > 0
          ? Math.max(0, Math.min(1, window.scrollY / scrollable))
          : 0;
      bar.style.transform = `scaleX(${ratio})`;
    }

    window.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(updateBar);
        }
      },
      { passive: true }
    );
    window.addEventListener('resize', updateBar, { passive: true });
    updateBar();
  }

  /* ========================================================================
     3. Runtime Probe for Top-Layer Exit Transitions (animate-to-from-top-layer)
     ======================================================================== */

  let cachedDisplayTransitionSupport;
  function canTransitionDisplay() {
    if (cachedDisplayTransitionSupport !== undefined) {
      return cachedDisplayTransitionSupport;
    }
    if (
      !window.CSS?.supports?.('transition-behavior', 'allow-discrete') ||
      !document.body
    ) {
      cachedDisplayTransitionSupport = false;
      return false;
    }
    const probe = document.createElement('div');
    probe.style.cssText =
      'transition: display 1s allow-discrete !important; display: block;';
    document.body.appendChild(probe);
    void getComputedStyle(probe).display;
    probe.style.display = 'none';
    cachedDisplayTransitionSupport = getComputedStyle(probe).display === 'block';
    probe.remove();
    return cachedDisplayTransitionSupport;
  }

  function supportsTopLayerExit() {
    return Boolean(
      window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay()
    );
  }

  async function hidePopoverAnimated(el) {
    if (!el) return;
    const isOpen = hasNativePopover
      ? el.matches(':popover-open')
      : el.classList.contains(':popover-open');
    if (!isOpen) return;

    if (!supportsTopLayerExit()) {
      el.setAttribute('data-closing', '');
      const animations =
        typeof el.getAnimations === 'function'
          ? el.getAnimations({ subtree: true })
          : [];
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 350)),
        ]);
      }
      if (!el.hasAttribute('data-closing')) return;
      el.removeAttribute('data-closing');
    }

    if (hasNativePopover) {
      try {
        el.hidePopover();
      } catch {
        // Already closed.
      }
    } else {
      el.classList.remove(':popover-open');
      el.dispatchEvent(new CustomEvent('popover-fallback-close'));
    }
  }

  /* ========================================================================
     4. Accessible Toast Notifications (persistent-toast-notifications guidance)
     ======================================================================== */

  const toastEl = document.getElementById('reading-toast');
  const toastMsgEl = document.getElementById('reading-toast-message');
  const toastActionBtn = document.getElementById('reading-toast-action');
  const toastTopBtn = document.getElementById('reading-toast-top');
  const toastCloseBtn = document.getElementById('reading-toast-close');
  const srAnnouncer = document.getElementById('sr-announcer');
  const srAnnouncerLabel = document.getElementById('sr-announcer-label');

  let toastTimer = null;
  let toastRemainingMs = 0;
  let toastPriorFocus = null;
  let toastDismissFromFocus = false;
  let toastActionHandler = null;

  function announceForScreenReaders(text) {
    if (typeof document.ariaNotify === 'function') {
      try {
        document.ariaNotify(text);
        return;
      } catch {
        // Fall through to live region.
      }
    }
    if (srAnnouncer) {
      if (srAnnouncerLabel) srAnnouncerLabel.hidden = false;
      srAnnouncer.textContent = '';
      requestAnimationFrame(() => {
        srAnnouncer.textContent = text;
      });
    }
  }

  function restoreToastFocus() {
    const target =
      toastPriorFocus &&
      document.contains(toastPriorFocus) &&
      !toastEl?.contains(toastPriorFocus)
        ? toastPriorFocus
        : document.getElementById('main-content');
    toastPriorFocus = null;
    toastDismissFromFocus = false;
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  function clearToastTimer() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function scheduleToastAutoHide(ms) {
    clearToastTimer();
    if (!ms || !toastEl) return;
    toastRemainingMs = ms;
    toastTimer = setTimeout(() => {
      if (toastEl.matches(':focus-within') || toastEl.matches(':hover')) {
        return;
      }
      hidePopoverAnimated(toastEl);
    }, ms);
  }

  function dismissToast() {
    clearToastTimer();
    if (toastEl) hidePopoverAnimated(toastEl);
  }

  function showToast(message, options = {}) {
    if (!toastEl || !toastMsgEl) return;

    // Suppress background toasts while ANY modal dialog is open (persistent-toast-notifications).
    if (document.querySelector('dialog[open]')) return;

    if (
      document.activeElement instanceof HTMLElement &&
      !toastEl.contains(document.activeElement)
    ) {
      toastPriorFocus = document.activeElement;
    }

    const {
      showTopButton = false,
      actionLabel = '',
      onAction = null,
      autoHideMs = 4500,
    } = options;
    toastMsgEl.textContent = message;
    if (toastTopBtn) {
      toastTopBtn.hidden = !showTopButton;
    }
    toastActionHandler = typeof onAction === 'function' ? onAction : null;
    if (toastActionBtn) {
      if (actionLabel && toastActionHandler) {
        toastActionBtn.textContent = actionLabel;
        toastActionBtn.hidden = false;
      } else {
        toastActionBtn.textContent = '';
        toastActionBtn.hidden = true;
      }
    }
    toastEl.removeAttribute('data-closing');

    if (hasNativePopover) {
      try {
        if (!toastEl.matches(':popover-open')) {
          toastEl.showPopover();
        }
      } catch {
        // Ignore if already open.
      }
    } else {
      toastEl.classList.add(':popover-open');
    }

    const hasShortcut = showTopButton || Boolean(actionLabel && toastActionHandler);
    const announcement = hasShortcut ? `${message}。提供快捷操作。` : message;
    announceForScreenReaders(announcement);

    if (autoHideMs > 0) {
      scheduleToastAutoHide(autoHideMs);
    }
  }

  function initToastHandlers() {
    if (!toastEl) return;

    toastEl.addEventListener('focusin', (event) => {
      clearToastTimer();
      if (
        event.relatedTarget instanceof HTMLElement &&
        !toastEl.contains(event.relatedTarget)
      ) {
        toastPriorFocus = event.relatedTarget;
      }
    });
    toastEl.addEventListener('mouseenter', clearToastTimer);
    toastEl.addEventListener('focusout', () => {
      if (toastRemainingMs > 0 && !toastEl.matches(':focus-within')) {
        scheduleToastAutoHide(2200);
      }
    });
    toastEl.addEventListener('mouseleave', () => {
      if (toastRemainingMs > 0 && !toastEl.matches(':focus-within')) {
        scheduleToastAutoHide(2200);
      }
    });

    if (hasNativePopover) {
      toastEl.addEventListener('toggle', (event) => {
        if (event.newState === 'closed' && toastDismissFromFocus) {
          restoreToastFocus();
        }
      });
    } else {
      toastEl.addEventListener('popover-fallback-close', () => {
        if (toastDismissFromFocus) {
          restoreToastFocus();
        }
      });
    }

    if (toastActionBtn) {
      toastActionBtn.addEventListener('click', () => {
        toastDismissFromFocus = toastEl.contains(document.activeElement);
        const handler = toastActionHandler;
        toastActionHandler = null;
        hidePopoverAnimated(toastEl);
        if (handler) handler();
      });
    }

    if (toastTopBtn) {
      toastTopBtn.addEventListener('click', () => {
        toastDismissFromFocus = toastEl.contains(document.activeElement);
        window.scrollTo({
          top: 0,
          behavior: reducedMotionMql.matches ? 'instant' : 'smooth',
        });
        hidePopoverAnimated(toastEl);
      });
    }

    if (toastCloseBtn) {
      toastCloseBtn.addEventListener('click', (event) => {
        toastDismissFromFocus = toastEl.contains(document.activeElement);
        if (!hasNativePopover || !supportsTopLayerExit()) {
          event.preventDefault();
          hidePopoverAnimated(toastEl);
        }
      });
    }
  }

  /* ========================================================================
     5. Accordion Expand/Collapse All + Instant Filter (accordion guidance)
     ======================================================================== */

  function initAccordionsAndFilters() {
    function syncToggleButton(container) {
      if (!container?.id) return;
      const btn = document.querySelector(
        `[data-toggle-all="${CSS.escape(container.id)}"]`
      );
      if (!btn) return;
      const detailsList = container.querySelectorAll('details:not([hidden])');
      const allOpen =
        detailsList.length > 0 &&
        Array.prototype.every.call(detailsList, (d) => d.open);
      btn.setAttribute('aria-expanded', String(allOpen));
    }

    function toggleAllInContainer(container, btn) {
      if (!container || !btn) return;
      const shouldExpand = btn.getAttribute('aria-expanded') !== 'true';
      for (const details of container.querySelectorAll('details:not([hidden])')) {
        details.open = shouldExpand;
      }
      btn.setAttribute('aria-expanded', String(shouldExpand));
    }

    // Native invoker commands handler (capture because command does not bubble)
    document.addEventListener(
      'command',
      (event) => {
        if (event.command !== '--toggle-all') return;
        toggleAllInContainer(event.target, event.source);
      },
      { capture: true }
    );

    // Fallback for browsers without invoker commands
    if (!Object.hasOwn(HTMLButtonElement.prototype, 'commandForElement')) {
      document.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-toggle-all]');
        if (!btn) return;
        const containerId = btn.dataset.toggleAll;
        const container = document.getElementById(containerId);
        toggleAllInContainer(container, btn);
      });
    }

    // Article in-page collapsible proof/detail Expand/Collapse All (#article-toggle-details)
    const articleToggleDetailsBtn = document.getElementById('article-toggle-details');
    const articleBodyForDetails = document.getElementById('article-body');

    syncArticleDetailsToggle = () => {
      if (!articleToggleDetailsBtn || !articleBodyForDetails) return;
      const boxes = articleBodyForDetails.querySelectorAll('details.detail-box');
      if (boxes.length === 0) {
        articleToggleDetailsBtn.hidden = true;
        articleToggleDetailsBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      articleToggleDetailsBtn.hidden = false;
      const allOpen = Array.prototype.every.call(boxes, (d) => d.open);
      articleToggleDetailsBtn.setAttribute('aria-expanded', String(allOpen));
    };

    if (articleToggleDetailsBtn && articleBodyForDetails) {
      articleToggleDetailsBtn.addEventListener('click', () => {
        const boxes = articleBodyForDetails.querySelectorAll('details.detail-box');
        if (boxes.length === 0) return;
        const shouldExpand = articleToggleDetailsBtn.getAttribute('aria-expanded') !== 'true';
        for (const d of boxes) {
          d.open = shouldExpand;
        }
        articleToggleDetailsBtn.setAttribute('aria-expanded', String(shouldExpand));
      });
    }

    // Keep aria-expanded synced on individual toggle events (capture)
    document.addEventListener(
      'toggle',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLDetailsElement)) return;
        const container = target.closest('#toc-tree-list, #syllabus-tree');
        if (container) syncToggleButton(container);
        if (
          target.classList.contains('detail-box') &&
          articleBodyForDetails?.contains(target)
        ) {
          syncArticleDetailsToggle();
        }
      },
      { capture: true }
    );

    // Initial sync
    for (const id of ['toc-tree-list', 'syllabus-tree']) {
      syncToggleButton(document.getElementById(id));
    }
    syncArticleDetailsToggle();

    function matchesPriorityMode(priority, mode) {
      if (mode === 'core') return priority === 'core';
      if (mode === 'important') return priority === 'core' || priority === 'high';
      return true;
    }

    // Capture original SSR Prev/Next pager HTML once so 'all' restores it cleanly
    const pagerNav = document.getElementById('page-pager');
    const pagerBanner = document.getElementById('pager-mode-banner');
    const pagerBannerText = document.getElementById('pager-mode-text');
    const pagerResetBtn = document.getElementById('pager-mode-reset');
    const originalPagerHtml = pagerNav ? pagerNav.innerHTML : '';

    function buildFilteredPagerCard(item, dir) {
      if (!item) {
        if (dir === 'prev') {
          const ph = document.createElement('div');
          ph.className = 'pager-card pager-card-placeholder';
          ph.setAttribute('aria-hidden', 'true');
          return ph;
        }
        const homeCard = document.createElement('a');
        homeCard.className = 'pager-card pager-card-next';
        homeCard.href = `${assetBase}index.html`;
        const d = document.createElement('span');
        d.className = 'pager-dir';
        d.textContent = '已到达当前筛选末尾 →';
        const ch = document.createElement('span');
        ch.className = 'pager-chapter';
        ch.textContent = '复习总览';
        const t = document.createElement('span');
        t.className = 'pager-title';
        t.textContent = '返回课程首页查看学习进度';
        homeCard.append(d, ch, t);
        return homeCard;
      }

      const link = item.querySelector('a.toc-page-link');
      const card = document.createElement('a');
      card.className = `pager-card pager-card-${dir}`;
      card.href = link?.getAttribute('href') || `./${encodeURIComponent(item.dataset.tocPage || '')}.html`;

      const dirSpan = document.createElement('span');
      dirSpan.className = 'pager-dir';
      const prio = item.dataset.priority || 'normal';
      const badge = document.createElement('span');
      if (prio === 'core' || prio === 'high') {
        badge.className = `priority-badge priority-badge-${prio} priority-badge-compact`;
        badge.textContent = prio === 'core' ? '必考' : '重点';
      }

      if (dir === 'prev') {
        dirSpan.append('← 上一节 ');
        if (badge.textContent) dirSpan.append(badge);
      } else {
        if (badge.textContent) dirSpan.append(badge, ' ');
        dirSpan.append('下一节 →');
      }

      card.append(dirSpan);
      if (item.dataset.chapterTitle) {
        const chSpan = document.createElement('span');
        chSpan.className = 'pager-chapter';
        chSpan.textContent = item.dataset.chapterTitle;
        card.append(chSpan);
      }
      const titleSpan = document.createElement('span');
      titleSpan.className = 'pager-title';
      titleSpan.textContent = item.dataset.pageTitle || item.textContent?.trim() || '';
      card.append(titleSpan);
      return card;
    }

    function updateFilteredPager(mode) {
      if (!pagerNav || pageType !== 'article') return;
      if (mode === 'all') {
        pagerNav.innerHTML = originalPagerHtml;
        if (pagerBanner) pagerBanner.hidden = true;
        return;
      }
      const tocList = document.getElementById('toc-tree-list');
      if (!tocList) return;
      const items = Array.from(tocList.querySelectorAll('.toc-page-item'));
      const currentIdx = items.findIndex((el) => el.dataset.tocPage === currentSlug);

      let prevMatch = null;
      let nextMatch = null;
      if (currentIdx >= 0) {
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (matchesPriorityMode(items[i].dataset.priority || 'normal', mode)) {
            prevMatch = items[i];
            break;
          }
        }
        for (let i = currentIdx + 1; i < items.length; i++) {
          if (matchesPriorityMode(items[i].dataset.priority || 'normal', mode)) {
            nextMatch = items[i];
            break;
          }
        }
      }

      pagerNav.replaceChildren(
        buildFilteredPagerCard(prevMatch, 'prev'),
        buildFilteredPagerCard(nextMatch, 'next')
      );

      if (pagerBanner && pagerBannerText) {
        const modeLabel = mode === 'core' ? '仅看必考' : '必考 + 重点';
        pagerBanner.dataset.mode = mode;
        pagerBannerText.textContent = `当前按「${modeLabel}」顺序切换上下节`;
        pagerBanner.hidden = false;
      }
    }

    // Generic 3-level TOC/Syllabus combined keyword + priority filter with filtered counts
    function bindTreeFilter({
      inputId,
      containerId,
      emptyId,
      metaId,
      summaryId,
      mismatchId,
      partSel,
      chapterSel,
      pageSel,
      isToc = false,
      onUserPriorityChange = null,
    }) {
      const input = document.getElementById(inputId);
      const container = document.getElementById(containerId);
      const emptyEl = document.getElementById(emptyId);
      const metaEl = metaId ? document.getElementById(metaId) : null;
      const summaryEl = summaryId ? document.getElementById(summaryId) : null;
      const mismatchBtn = mismatchId ? document.getElementById(mismatchId) : null;
      const priorityBar = document.querySelector(
        `[data-priority-bar="${CSS.escape(containerId)}"]`
      );
      if (!container || (!input && !priorityBar)) return null;

      let priorityMode = getPriorityState().value;

      // Capture initial open states so clearing both filters restores them cleanly
      const initialOpen = new WeakMap();
      for (const d of container.querySelectorAll('details')) {
        initialOpen.set(d, d.open);
      }

      function applyFilter() {
        const query = input ? input.value.trim().toLowerCase() : '';
        const terms = query ? query.split(/\s+/).filter(Boolean) : [];
        const isFiltered = terms.length > 0 || priorityMode !== 'all';
        const readMap = getReadPagesMap();
        let visibleCount = 0;
        let visibleReadCount = 0;
        let totalCount = 0;
        let currentPageHidden = false;

        for (const partEl of container.querySelectorAll(partSel)) {
          let partVisible = 0;
          let partVisibleRead = 0;
          let partTotal = 0;
          let partTotalRead = 0;

          for (const chapterEl of partEl.querySelectorAll(chapterSel)) {
            let chapterVisible = 0;
            let chapterTotal = 0;

            for (const pageEl of chapterEl.querySelectorAll(pageSel)) {
              chapterTotal += 1;
              partTotal += 1;
              totalCount += 1;
              const slug = pageEl.dataset.tocPage || pageEl.dataset.syllabusPage || '';
              const isRead = Boolean(readMap[slug]);
              if (isRead) partTotalRead += 1;

              const haystack = pageEl.dataset.searchText || '';
              const itemPriority = pageEl.dataset.priority || 'normal';
              const textOk =
                terms.length === 0 || terms.every((t) => haystack.includes(t));
              const prioOk = matchesPriorityMode(itemPriority, priorityMode);
              const matches = textOk && prioOk;
              pageEl.hidden = !matches;
              if (matches) {
                chapterVisible += 1;
                visibleCount += 1;
                if (isRead) {
                  partVisibleRead += 1;
                  visibleReadCount += 1;
                }
              } else if (isToc && slug && slug === currentSlug) {
                currentPageHidden = true;
              }
            }

            chapterEl.hidden = chapterVisible === 0;
            const chBadge = chapterEl.querySelector(':scope > summary [data-chapter-count]');
            if (chBadge) {
              chBadge.textContent = isFiltered
                ? `${chapterVisible}/${chapterTotal} 节`
                : `${chapterTotal} 节`;
            }

            if (isFiltered) {
              if (chapterVisible > 0) chapterEl.open = true;
            } else {
              chapterEl.open = Boolean(initialOpen.get(chapterEl));
            }
            partVisible += chapterVisible;
          }

          partEl.hidden = partVisible === 0;
          const partBadge = partEl.querySelector(':scope > summary [data-part-progress]');
          if (partBadge) {
            partBadge.textContent = isFiltered
              ? `${partVisibleRead}/${partVisible}`
              : `${partTotalRead}/${partTotal}`;
          }

          if (isFiltered) {
            if (partVisible > 0) partEl.open = true;
          } else {
            partEl.open = Boolean(initialOpen.get(partEl));
          }
        }

        if (emptyEl) {
          emptyEl.hidden = visibleCount > 0;
        }
        if (metaEl && summaryEl) {
          if (isFiltered) {
            const modeLabel =
              priorityMode === 'core'
                ? '仅看必考'
                : priorityMode === 'important'
                  ? '必考+重点'
                  : '筛选结果';
            summaryEl.textContent = `${modeLabel}：${visibleReadCount}/${visibleCount} 节已读（共 ${totalCount} 节）`;
            metaEl.hidden = false;
          } else {
            summaryEl.textContent = '';
            metaEl.hidden = true;
          }
        }
        if (mismatchBtn) {
          mismatchBtn.hidden = !(isToc && currentPageHidden && priorityMode !== 'all');
        }
        if (isToc) {
          updateFilteredPager(priorityMode);
        }
        syncToggleButton(container);
      }

      function setPriorityMode(nextMode, { clearSearch = false, persist = true } = {}) {
        const normalized = normalizePriorityModeValue(nextMode);
        if (clearSearch && input) {
          input.value = '';
        }
        priorityMode = normalized;
        if (priorityBar) {
          for (const btn of priorityBar.querySelectorAll('[data-priority-filter]')) {
            btn.setAttribute(
              'aria-pressed',
              String(btn.dataset.priorityFilter === priorityMode)
            );
          }
        }
        applyFilter();
        if (persist && typeof onUserPriorityChange === 'function') {
          onUserPriorityChange(priorityMode);
        }
      }

      if (input) {
        input.addEventListener('input', applyFilter);
      }

      if (priorityBar) {
        priorityBar.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-priority-filter]');
          if (!btn) return;
          setPriorityMode(btn.dataset.priorityFilter || 'all', { persist: true });
        });
      }

      if (mismatchBtn) {
        mismatchBtn.addEventListener('click', () => {
          setPriorityMode('all', { clearSearch: true, persist: true });
        });
      }

      // Apply initial persisted mode on boot
      setPriorityMode(priorityMode, { persist: false });

      return { setPriorityMode, applyFilter };
    }

    let tocFilterApi = null;
    let syllabusFilterApi = null;
    let conceptFilterApi = null;

    function persistAndBroadcastPriority(nextMode) {
      savePriorityState(nextMode, Date.now());
      if (tocFilterApi) tocFilterApi.setPriorityMode(nextMode, { persist: false });
      if (syllabusFilterApi) syllabusFilterApi.setPriorityMode(nextMode, { persist: false });
      if (conceptFilterApi) conceptFilterApi.setPriorityMode(nextMode, { persist: false });
      emitProgressChange('priorityMode');
    }

    tocFilterApi = bindTreeFilter({
      inputId: 'toc-filter',
      containerId: 'toc-tree-list',
      emptyId: 'toc-empty',
      metaId: 'toc-filter-meta',
      summaryId: 'toc-filter-summary',
      mismatchId: 'toc-current-mismatch',
      partSel: '.toc-part',
      chapterSel: '.toc-chapter',
      pageSel: '.toc-page-item',
      isToc: true,
      onUserPriorityChange: persistAndBroadcastPriority,
    });

    syllabusFilterApi = bindTreeFilter({
      inputId: 'syllabus-filter',
      containerId: 'syllabus-tree',
      emptyId: 'syllabus-empty',
      metaId: 'syllabus-filter-meta',
      summaryId: 'syllabus-filter-summary',
      partSel: '.syllabus-part',
      chapterSel: '.syllabus-chapter',
      pageSel: '.syllabus-page-item',
      isToc: false,
      onUserPriorityChange: persistAndBroadcastPriority,
    });

    if (pagerResetBtn) {
      pagerResetBtn.addEventListener('click', () => {
        persistAndBroadcastPriority('all');
      });
    }

    // Home "只看核心必考大纲" shortcut button from exam sprint banner
    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-activate-priority]');
      if (!btn || !syllabusFilterApi) return;
      const mode = btn.dataset.activatePriority || 'core';
      syllabusFilterApi.setPriorityMode(mode, { clearSearch: true, persist: true });
    });

    // Home "查看目录" jump expands target part (resetting restrictive filter/search if needed)
    document.addEventListener('click', (event) => {
      const jump = event.target.closest('[data-expand-part]');
      if (!jump) return;
      const partId = jump.dataset.expandPart;
      const targetPart = document.getElementById(`syllabus-part-${partId}`);
      if (targetPart) {
        if (targetPart.hidden && syllabusFilterApi) {
          syllabusFilterApi.setPriorityMode('all', { clearSearch: true, persist: true });
        }
        targetPart.open = true;
        for (const ch of targetPart.querySelectorAll('details:not([hidden])')) {
          ch.open = true;
        }
      }
    });

    // Home concept index combined keyword + priority filter
    const conceptFilter = document.getElementById('concept-index-filter');
    const conceptGrid = document.getElementById('concept-index-grid');
    const conceptCount = document.getElementById('concept-index-count');
    const conceptPriorityBar = document.querySelector(
      '[data-priority-bar="concept-index-grid"]'
    );
    if (conceptGrid && (conceptFilter || conceptPriorityBar)) {
      const chips = Array.from(
        conceptGrid.querySelectorAll('[data-concept-search]')
      );
      let conceptPrioMode = getPriorityState().value;

      const applyConceptFilter = () => {
        const q = conceptFilter ? conceptFilter.value.trim().toLowerCase() : '';
        let shown = 0;
        for (const chip of chips) {
          const textOk = !q || (chip.dataset.conceptSearch || '').includes(q);
          const prioOk = matchesPriorityMode(
            chip.dataset.priority || 'normal',
            conceptPrioMode
          );
          const ok = textOk && prioOk;
          chip.hidden = !ok;
          if (ok) shown += 1;
        }
        if (conceptCount) {
          conceptCount.textContent =
            q || conceptPrioMode !== 'all'
              ? `匹配 ${shown} / ${chips.length} 个概念`
              : `共 ${chips.length} 个概念`;
        }
      };

      const setConceptPriorityMode = (nextMode, { persist = false } = {}) => {
        conceptPrioMode = normalizePriorityModeValue(nextMode);
        if (conceptPriorityBar) {
          for (const b of conceptPriorityBar.querySelectorAll('[data-priority-filter]')) {
            b.setAttribute(
              'aria-pressed',
              String(b.dataset.priorityFilter === conceptPrioMode)
            );
          }
        }
        applyConceptFilter();
        if (persist) {
          persistAndBroadcastPriority(conceptPrioMode);
        }
      };

      if (conceptFilter) {
        conceptFilter.addEventListener('input', applyConceptFilter);
      }

      if (conceptPriorityBar) {
        conceptPriorityBar.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-priority-filter]');
          if (!btn) return;
          setConceptPriorityMode(btn.dataset.priorityFilter || 'all', { persist: true });
        });
      }

      conceptFilterApi = { setPriorityMode: setConceptPriorityMode, applyFilter: applyConceptFilter };
      setConceptPriorityMode(conceptPrioMode, { persist: false });
    }

    syncFilterUI = (nextMode) => {
      const mode = nextMode ? normalizePriorityModeValue(nextMode) : getPriorityState().value;
      if (tocFilterApi) tocFilterApi.setPriorityMode(mode, { persist: false });
      if (syllabusFilterApi) syllabusFilterApi.setPriorityMode(mode, { persist: false });
      if (conceptFilterApi) conceptFilterApi.setPriorityMode(mode, { persist: false });
    };
  }

  /* ========================================================================
     6. Mobile Swipe-to-Dismiss Native <dialog> TOC Drawer (navigation-drawer)
     ======================================================================== */

  function initMobileDrawer() {
    const drawer = document.getElementById('toc-drawer');
    const openBtn = document.getElementById('drawer-open');
    const closeBtn = document.getElementById('drawer-close');
    const sidebarSlot = document.getElementById('sidebar-toc-slot');
    const drawerSlot = document.getElementById('drawer-toc-slot');
    const tocMount = document.getElementById('toc-mount');

    if (!drawer || !openBtn || !closeBtn || !tocMount) return;

    const scroller = drawer.querySelector('.toc-drawer-scroller');
    const sheet = drawer.querySelector('.toc-drawer-sheet');
    if (!scroller || !sheet) return;

    let drawerState = 'closed'; // 'closed' | 'opening' | 'open' | 'closing'
    let sheetEntered = false;
    let closeFallbackTimer = null;

    function mountTocInSlot(mobile) {
      const targetSlot = mobile ? drawerSlot : sidebarSlot;
      if (targetSlot && tocMount.parentElement !== targetSlot) {
        targetSlot.appendChild(tocMount);
      }
    }

    function finalizeDrawerClosed() {
      if (closeFallbackTimer) {
        clearTimeout(closeFallbackTimer);
        closeFallbackTimer = null;
      }
      drawerState = 'closed';
      sheetEntered = false;
      if (drawer.open) {
        drawer.close();
      }
      if (!window.CSS?.supports?.('animation-timeline: scroll()')) {
        drawer.style.setProperty('--drawer-backdrop', '0');
      }
      openBtn.setAttribute('aria-expanded', 'false');
    }

    async function openDrawer() {
      if (drawer.open && drawerState === 'open') return;
      mountTocInSlot(true);
      drawerState = 'opening';
      sheetEntered = false;
      document.dispatchEvent(new CustomEvent('notes:overlay-open', { detail: { source: 'toc-drawer' } }));
      drawer.showModal();

      // Scroll only the vertical TOC nav container (never scrollIntoView, which
      // would also scroll .toc-drawer-scroller and cancel the horizontal slide-in).
      const tocScroll = tocMount.querySelector('.toc-scroll');
      const activeLink = tocMount.querySelector('[aria-current="page"]');
      if (tocScroll && activeLink) {
        const linkRect = activeLink.getBoundingClientRect();
        const scrollRect = tocScroll.getBoundingClientRect();
        tocScroll.scrollTop +=
          linkRect.top - scrollRect.top - tocScroll.clientHeight / 2 + linkRect.height / 2;
      }

      if (!window.CSS?.supports?.('scroll-initial-target', 'nearest')) {
        // Jump to closed stop first; wait two rAFs so browser commits it.
        scroller.scrollTo({ left: scroller.offsetWidth, behavior: 'instant' });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
      }

      if (drawerState !== 'opening') return;
      scroller.scrollTo({ left: 0, behavior: 'auto' });
    }

    function closeDrawer() {
      if (!drawer.open) return;
      drawerState = 'closing';
      scroller.scrollTo({ left: scroller.offsetWidth, behavior: 'auto' });

      // Safety close for reduced-motion / instant scroll edge cases
      if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
      closeFallbackTimer = setTimeout(() => {
        if (drawerState === 'closing') {
          finalizeDrawerClosed();
        }
      }, 450);
    }

    const visibleThreshold = Math.min(0.05, 1 / Math.max(window.innerWidth, 320));
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        if (entry.intersectionRatio >= visibleThreshold) {
          sheetEntered = true;
        }
        if (entry.intersectionRatio >= 0.96) {
          drawerState = 'open';
          openBtn.setAttribute('aria-expanded', 'true');
        } else if (
          entry.intersectionRatio < visibleThreshold &&
          (sheetEntered || drawerState === 'open' || drawerState === 'closing')
        ) {
          finalizeDrawerClosed();
        }
      },
      { root: drawer, threshold: [visibleThreshold, 0.96] }
    );
    observer.observe(sheet);

    // Scroll-driven backdrop opacity fallback when animation-timeline unsupported
    if (!window.CSS?.supports?.('animation-timeline: scroll()')) {
      scroller.addEventListener(
        'scroll',
        () => {
          const width = Math.max(1, sheet.offsetWidth);
          const ratio = Math.max(0, Math.min(1, 1 - scroller.scrollLeft / width));
          drawer.style.setProperty('--drawer-backdrop', String(ratio));
        },
        { passive: true }
      );
    }

    openBtn.addEventListener('click', openDrawer);
    closeBtn.addEventListener('click', closeDrawer);

    // Light-dismiss by tapping dimmed area outside sheet (instead of closedby="any")
    drawer.addEventListener('click', (event) => {
      if (!sheet.contains(event.target)) {
        closeDrawer();
      }
    });

    // Animated Escape dismiss
    drawer.addEventListener('cancel', (event) => {
      if (event.cancelable) {
        event.preventDefault();
        closeDrawer();
      }
    });

    // Keep state synced if native Escape forces instant close
    drawer.addEventListener('close', () => {
      drawerState = 'closed';
      sheetEntered = false;
      openBtn.setAttribute('aria-expanded', 'false');
    });

    // Close drawer if user clicks current-page link inside TOC
    tocMount.addEventListener('click', (event) => {
      const link = event.target.closest('a.toc-page-link');
      if (link && drawer.open) {
        if (link.getAttribute('aria-current') === 'page') {
          event.preventDefault();
          closeDrawer();
        }
      }
    });

    // Sync TOC mount between desktop sidebar and mobile drawer
    function syncViewportMount() {
      if (mobileLayoutMql.matches) {
        mountTocInSlot(true);
      } else {
        if (drawer.open) finalizeDrawerClosed();
        mountTocInSlot(false);
      }
    }

    mobileLayoutMql.addEventListener('change', syncViewportMount);
    syncViewportMount();
  }

  /* ========================================================================
     7. Concept Recall Popover (viewport-aware-dropdowns + top-layer fallback)
     ======================================================================== */

  let conceptsCache = null;
  let conceptsPromise = null;

  function loadConceptsViaScriptFallback() {
    if (window.__CONCEPTS__ && typeof window.__CONCEPTS__ === 'object') {
      conceptsCache = window.__CONCEPTS__;
      return Promise.resolve(conceptsCache);
    }
    const assetBase = body.dataset.assetBase || './';
    const scriptUrl = `${assetBase}assets/concepts-data.js`;
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      script.onload = () => {
        conceptsCache =
          window.__CONCEPTS__ && typeof window.__CONCEPTS__ === 'object'
            ? window.__CONCEPTS__
            : {};
        resolve(conceptsCache);
      };
      script.onerror = () => resolve({});
      document.head.appendChild(script);
    });
  }

  async function loadConcepts() {
    if (conceptsCache) return conceptsCache;
    if (window.__CONCEPTS__ && typeof window.__CONCEPTS__ === 'object') {
      conceptsCache = window.__CONCEPTS__;
      return conceptsCache;
    }
    if (!conceptsPromise) {
      conceptsPromise = (async () => {
        if (conceptsUrl && window.location.protocol !== 'file:') {
          try {
            const res = await fetch(conceptsUrl);
            if (res.ok) {
              const data = await res.json();
              if (data && typeof data === 'object') {
                conceptsCache = data;
                return conceptsCache;
              }
            }
          } catch {
            // Fall through to script fallback (e.g., offline / file://).
          }
        }
        return loadConceptsViaScriptFallback();
      })();
    }
    return conceptsPromise;
  }

  function scheduleConceptPrefetch() {
    if (!document.querySelector('a.concept-ref[data-concept], [data-preview-concept]')) {
      return;
    }
    let warmed = false;
    const warmOnce = () => {
      if (warmed || conceptsCache || conceptsPromise) return;
      warmed = true;
      loadConcepts();
    };

    // Prefetch lazily on idle (respecting Data Saver) so initial render is unblocked
    if (!navigator.connection?.saveData) {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(warmOnce, { timeout: 2500 });
      } else {
        setTimeout(warmOnce, 1200);
      }
    }

    // Also warm immediately on first pointerover / focusin of any concept trigger
    const onIntent = (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('a.concept-ref[data-concept], [data-preview-concept]')
      ) {
        warmOnce();
        document.removeEventListener('pointerover', onIntent);
        document.removeEventListener('focusin', onIntent);
      }
    };
    document.addEventListener('pointerover', onIntent, { passive: true });
    document.addEventListener('focusin', onIntent, { passive: true });
  }

  let activeConceptRecord = null;
  let hideRecallPopoverFn = () => {};

  function initConceptRecallPopover() {
    const popover = document.getElementById('concept-popover');
    if (!popover) return;

    scheduleConceptPrefetch();

    const categoryEl = document.getElementById('recall-category');
    const priorityEl = document.getElementById('recall-priority');
    const termEl = document.getElementById('recall-term');
    const briefEl = document.getElementById('recall-brief');
    const formulaEl = document.getElementById('recall-formula');
    const linkEl = document.getElementById('recall-link');
    const closeBtn = document.getElementById('recall-close');
    const closeIconBtn = document.getElementById('recall-close-icon');

    let activeTrigger = null;
    let exitingAnchorEl = null;
    let anchorCleanupSeq = 0;
    let anchorCleanupTimer = null;
    let anchorCleanupRemoveListeners = null;
    let openRequestId = 0;

    function isPopoverOpenNow() {
      return hasNativePopover
        ? popover.matches(':popover-open')
        : popover.classList.contains(':popover-open');
    }

    function flushExitingAnchor(keepEl = null) {
      anchorCleanupSeq += 1;
      if (anchorCleanupTimer) {
        clearTimeout(anchorCleanupTimer);
        anchorCleanupTimer = null;
      }
      if (anchorCleanupRemoveListeners) {
        anchorCleanupRemoveListeners();
        anchorCleanupRemoveListeners = null;
      }
      if (exitingAnchorEl && exitingAnchorEl !== keepEl) {
        exitingAnchorEl.style.anchorName = '';
      }
      exitingAnchorEl = null;
    }

    function scheduleAnchorCleanup(triggerEl) {
      flushExitingAnchor(triggerEl);
      if (!triggerEl) return;

      exitingAnchorEl = triggerEl;
      const mySeq = ++anchorCleanupSeq;

      const finalize = () => {
        if (anchorCleanupTimer) {
          clearTimeout(anchorCleanupTimer);
          anchorCleanupTimer = null;
        }
        if (anchorCleanupRemoveListeners) {
          anchorCleanupRemoveListeners();
          anchorCleanupRemoveListeners = null;
        }
        if (anchorCleanupSeq !== mySeq) return;
        if (exitingAnchorEl === triggerEl) {
          exitingAnchorEl = null;
        }
        if (triggerEl !== activeTrigger) {
          triggerEl.style.anchorName = '';
        }
      };

      // Wait one frame so Chrome commits closed styles & registers CSSTransition
      // before inspecting getAnimations() or computed display.
      requestAnimationFrame(() => {
        if (anchorCleanupSeq !== mySeq) return;

        const anims =
          typeof popover.getAnimations === 'function' ? popover.getAnimations() : [];
        if (anims.length > 0) {
          anchorCleanupTimer = setTimeout(finalize, 400);
          Promise.allSettled(anims.map((a) => a.finished)).then(finalize);
          return;
        }

        const display =
          typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(popover).display
            : 'none';
        if (display !== 'none') {
          const onEnd = (event) => {
            if (event.target === popover) finalize();
          };
          popover.addEventListener('transitionend', onEnd);
          popover.addEventListener('transitioncancel', onEnd);
          anchorCleanupRemoveListeners = () => {
            popover.removeEventListener('transitionend', onEnd);
            popover.removeEventListener('transitioncancel', onEnd);
          };
          anchorCleanupTimer = setTimeout(finalize, 280);
          return;
        }

        finalize();
      });
    }

    hideRecallPopoverFn = ({ freezePosition = false } = {}) => {
      if (freezePosition && isPopoverOpenNow() && !sheetViewportMql.matches) {
        const rect = popover.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          popover.dataset.positioned = 'js';
          popover.style.top = `${Math.round(rect.top)}px`;
          popover.style.left = `${Math.round(rect.left)}px`;
        }
      }
      return hidePopoverAnimated(popover);
    };

    function positionWithJsFallback(triggerEl) {
      popover.dataset.positioned = 'js';
      const triggerRect = triggerEl.getBoundingClientRect();
      const cardRect = popover.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 8;
      const margin = 12;

      let top = triggerRect.bottom + gap;
      if (top + cardRect.height > vh - margin && triggerRect.top - gap - cardRect.height >= margin) {
        top = triggerRect.top - cardRect.height - gap;
      }
      top = Math.max(margin, Math.min(top, vh - cardRect.height - margin));

      let left = triggerRect.left;
      if (left + cardRect.width > vw - margin) {
        left = vw - cardRect.width - margin;
      }
      left = Math.max(margin, left);

      popover.style.top = `${Math.round(top)}px`;
      popover.style.left = `${Math.round(left)}px`;
    }

    function showRecallPopoverNative(triggerEl) {
      if (popover.matches(':popover-open')) {
        popover.hidePopover();
      }
      try {
        popover.showPopover({ source: triggerEl });
      } catch {
        popover.showPopover();
      }
    }

    async function openRecallCard(triggerEl, conceptId, fallbackHref) {
      const requestId = ++openRequestId;
      const map = await loadConcepts();
      if (requestId !== openRequestId) return;

      const concept = map?.[conceptId];
      if (!concept) {
        if (fallbackHref && triggerEl.tagName === 'A') {
          window.location.href = fallbackHref;
        }
        return;
      }

      flushExitingAnchor(triggerEl);
      if (activeTrigger && activeTrigger !== triggerEl) {
        activeTrigger.classList.remove('is-popover-source');
        activeTrigger.style.anchorName = '';
      }
      activeTrigger = triggerEl;
      activeConceptRecord = concept;
      activeTrigger.classList.add('is-popover-source');

      categoryEl.textContent = concept.category || '核心概念';
      if (priorityEl) {
        if (concept.priority === 'core' || concept.priority === 'high') {
          priorityEl.className = `priority-badge priority-badge-${concept.priority}`;
          priorityEl.textContent =
            concept.examTag || (concept.priority === 'core' ? '核心必考' : '高频重点');
          priorityEl.hidden = false;
        } else {
          priorityEl.textContent = '';
          priorityEl.hidden = true;
        }
      }
      termEl.textContent = concept.term || conceptId;
      briefEl.innerHTML = concept.briefHtml || '';

      if (concept.formulaHtml) {
        formulaEl.innerHTML = concept.formulaHtml;
        formulaEl.hidden = false;
      } else {
        formulaEl.innerHTML = '';
        formulaEl.hidden = true;
      }

      const targetHref =
        fallbackHref || `${pageBase}${encodeURIComponent(concept.targetPage)}.html`;
      if (concept.targetPage && concept.targetPage === currentSlug) {
        linkEl.href = '#article-body';
        linkEl.textContent = '查看本节详解 ↓';
      } else {
        linkEl.href = targetHref;
        linkEl.textContent = concept.targetPageTitle
          ? `前往详情页：${concept.targetPageTitle} →`
          : '前往详情页 →';
      }

      popover.removeAttribute('data-closing');
      const isBottomSheet = sheetViewportMql.matches;

      if (isBottomSheet) {
        delete popover.dataset.positioned;
        popover.style.top = '';
        popover.style.left = '';
        triggerEl.style.anchorName = '';
      } else if (supportsAnchorArea && hasNativePopover) {
        delete popover.dataset.positioned;
        popover.style.top = '';
        popover.style.left = '';
        triggerEl.style.anchorName = '--active-concept';
      } else {
        popover.dataset.positioned = 'js';
        triggerEl.style.anchorName = '';
      }

      document.dispatchEvent(new CustomEvent('notes:overlay-open', { detail: { source: 'concept-popover' } }));
      if (hasNativePopover) {
        showRecallPopoverNative(triggerEl);
      } else {
        popover.classList.add(':popover-open');
      }

      if (!isBottomSheet && (!supportsAnchorArea || !hasNativePopover)) {
        positionWithJsFallback(triggerEl);
      }

      // Move keyboard & AT focus into the dialog without scrolling the page
      (closeIconBtn || linkEl)?.focus({ preventScroll: true });
    }

    function onPopoverClosed() {
      if (hasNativePopover && popover.matches(':popover-open')) return;
      const previous = activeTrigger;
      if (previous) {
        previous.classList.remove('is-popover-source');
      }
      activeTrigger = null;
      activeConceptRecord = null;
      scheduleAnchorCleanup(previous);
      if (
        previous &&
        document.contains(previous) &&
        (document.activeElement === document.body ||
          popover.contains(document.activeElement))
      ) {
        previous.focus({ preventScroll: true });
      }
    }

    // Delegate clicks on article first-mention links and concept preview chips
    document.addEventListener('click', (event) => {
      const conceptLink = event.target.closest('a.concept-ref[data-concept]');
      if (conceptLink) {
        // Preserve Ctrl / Cmd / Shift / middle click for opening target page directly
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        openRecallCard(
          conceptLink,
          conceptLink.dataset.concept,
          conceptLink.getAttribute('href')
        );
        return;
      }

      const previewBtn = event.target.closest('[data-preview-concept]');
      if (previewBtn) {
        event.preventDefault();
        openRecallCard(
          previewBtn,
          previewBtn.dataset.previewConcept,
          previewBtn.dataset.previewHref
        );
      }
    });

    for (const btn of [closeBtn, closeIconBtn]) {
      if (btn) {
        btn.addEventListener('click', () => hidePopoverAnimated(popover));
      }
    }

    if (linkEl) {
      linkEl.addEventListener('click', () => {
        if (linkEl.getAttribute('href')?.startsWith('#')) {
          hidePopoverAnimated(popover);
        }
      });
    }

    if (hasNativePopover) {
      popover.addEventListener('toggle', (event) => {
        if (event.newState === 'closed') {
          onPopoverClosed();
        }
      });
    } else {
      // Fallback light-dismiss & Escape for pre-Popover browsers
      popover.addEventListener('popover-fallback-close', onPopoverClosed);
      document.addEventListener('click', (event) => {
        if (!popover.classList.contains(':popover-open')) return;
        if (
          popover.contains(event.target) ||
          event.target.closest('a.concept-ref[data-concept], [data-preview-concept]')
        ) {
          return;
        }
        hidePopoverAnimated(popover);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && popover.classList.contains(':popover-open')) {
          hidePopoverAnimated(popover);
        }
      });
    }

    // Re-sync anchor/sheet/JS positioning on resize, orientation change, and inner scroll (e.g. .table-wrap)
    const syncJsPosition = () => {
      if (!activeTrigger) {
        if (sheetViewportMql.matches) flushExitingAnchor(null);
        return;
      }
      if (!isPopoverOpenNow()) return;
      flushExitingAnchor(activeTrigger);
      if (sheetViewportMql.matches) {
        delete popover.dataset.positioned;
        popover.style.top = '';
        popover.style.left = '';
        activeTrigger.style.anchorName = '';
      } else if (supportsAnchorArea && hasNativePopover) {
        delete popover.dataset.positioned;
        popover.style.top = '';
        popover.style.left = '';
        activeTrigger.style.anchorName = '--active-concept';
      } else {
        popover.dataset.positioned = 'js';
        positionWithJsFallback(activeTrigger);
      }
    };

    sheetViewportMql.addEventListener('change', syncJsPosition);
    window.addEventListener('resize', syncJsPosition, { passive: true });
    window.addEventListener('scroll', syncJsPosition, { capture: true, passive: true });
  }

  /* ========================================================================
     8. Progress Persistence, Scroll Restoration & Home Dashboard Hydration
     ======================================================================== */

  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSec < 60) return '刚刚阅读';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} 天前`;
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  let defaultContinueState = null;

  function captureContinueDefaults() {
    if (defaultContinueState || pageType !== 'home') return;
    const eyebrow = document.querySelector('[data-continue-eyebrow]');
    const timeEl = document.querySelector('[data-continue-time]');
    const chapterEl = document.querySelector('[data-continue-chapter]');
    const titleEl = document.querySelector('[data-continue-title]');
    const ctaEl = document.querySelector('[data-continue-cta]');
    defaultContinueState = {
      eyebrow: eyebrow?.textContent || '',
      time: timeEl?.textContent || '',
      chapter: chapterEl?.textContent || '',
      title: titleEl?.textContent || '',
      ctaText: ctaEl?.textContent || '',
      ctaHref: ctaEl?.getAttribute('href') || '',
    };
  }

  function renderProgressUI() {
    captureContinueDefaults();
    const readMap = getReadPagesMap();
    const readCount = Object.keys(readMap).length;
    const clampedRead = Math.min(readCount, totalPages);
    const pct = totalPages > 0 ? Math.round((clampedRead / totalPages) * 100) : 0;

    // Overall progress text & bars
    for (const el of document.querySelectorAll('[data-overall-progress-text]')) {
      el.textContent =
        pageType === 'home'
          ? `${clampedRead} / ${totalPages} 节 (${pct}%)`
          : `${clampedRead} / ${totalPages} 节`;
    }
    for (const el of document.querySelectorAll('[data-overall-progress-fill]')) {
      el.style.inlineSize = `${pct}%`;
    }
    for (const el of document.querySelectorAll('[data-overall-progressbar]')) {
      el.setAttribute('aria-valuenow', String(clampedRead));
    }
    for (const el of document.querySelectorAll('[data-mobile-progress-pct]')) {
      el.textContent = `${pct}%`;
    }

    // Per-page read checkmarks (TOC + Home syllabus)
    for (const link of document.querySelectorAll('[data-slug]')) {
      const slug = link.dataset.slug;
      link.classList.toggle('is-read', Boolean(readMap[slug]));
    }

    // Per-part progress counts & bars
    const partGroups = document.querySelectorAll(
      '[data-toc-part], [data-syllabus-part]'
    );
    const partStats = new Map();
    for (const partEl of partGroups) {
      const partId = partEl.dataset.tocPart || partEl.dataset.syllabusPart;
      if (!partId || partStats.has(partId)) continue;
      const links = partEl.querySelectorAll('[data-slug]');
      const total = links.length;
      let done = 0;
      for (const l of links) {
        if (readMap[l.dataset.slug]) done += 1;
      }
      partStats.set(partId, { done, total });
    }

    for (const [partId, { done, total }] of partStats.entries()) {
      const partPct = total > 0 ? Math.round((done / total) * 100) : 0;
      for (const badge of document.querySelectorAll(
        `[data-part-progress="${CSS.escape(partId)}"]`
      )) {
        badge.textContent = `${done}/${total}`;
      }
      for (const fill of document.querySelectorAll(
        `[data-part-progress-fill="${CSS.escape(partId)}"]`
      )) {
        fill.style.inlineSize = `${partPct}%`;
      }
    }

    // Article manual read-toggle buttons
    if (pageType === 'article' && currentSlug) {
      const isRead = Boolean(readMap[currentSlug]);
      for (const btn of document.querySelectorAll('[data-read-toggle]')) {
        btn.setAttribute('aria-pressed', String(isRead));
        const label = btn.querySelector('[data-read-toggle-label]');
        if (label) {
          label.textContent = isRead ? '已读 · 点击取消' : '标记为已读';
        }
      }
    }

    // Home "继续上次阅读" card hydration
    if (pageType === 'home') {
      const lastVisited = readStorageJson(STORAGE.lastVisited, null);
      const scrollMap = readStorageJson(STORAGE.scroll, {});
      const hasAnyProgress =
        Boolean(lastVisited?.slug) ||
        readCount > 0 ||
        Object.keys(scrollMap).length > 0;

      const resetBtn = document.getElementById('home-reset-btn');
      if (resetBtn) {
        resetBtn.hidden = !hasAnyProgress;
      }

      const eyebrow = document.querySelector('[data-continue-eyebrow]');
      const timeEl = document.querySelector('[data-continue-time]');
      const chapterEl = document.querySelector('[data-continue-chapter]');
      const titleEl = document.querySelector('[data-continue-title]');
      const ctaEl = document.querySelector('[data-continue-cta]');

      if (lastVisited?.slug) {
        const savedScroll = scrollMap[lastVisited.slug];
        const scrollPct =
          savedScroll && typeof savedScroll.ratio === 'number'
            ? Math.round(savedScroll.ratio * 100)
            : 0;

        if (eyebrow) eyebrow.textContent = '继续上次阅读';
        if (timeEl) {
          const rel = formatRelativeTime(lastVisited.timestamp);
          timeEl.textContent =
            scrollPct > 5 ? `${rel} · 已读至 ${scrollPct}%` : rel;
        }
        if (chapterEl) {
          chapterEl.textContent =
            [lastVisited.partTitle, lastVisited.chapterTitle]
              .filter(Boolean)
              .join(' · ') || '上次停留小节';
        }
        if (titleEl) {
          titleEl.textContent = lastVisited.title || lastVisited.shortTitle || '';
        }
        if (ctaEl) {
          ctaEl.href = `${pageBase}${encodeURIComponent(lastVisited.slug)}.html`;
          ctaEl.textContent = '继续上次阅读 →';
        }
      } else if (defaultContinueState) {
        if (eyebrow) eyebrow.textContent = defaultContinueState.eyebrow;
        if (timeEl) timeEl.textContent = defaultContinueState.time;
        if (chapterEl) chapterEl.textContent = defaultContinueState.chapter;
        if (titleEl) titleEl.textContent = defaultContinueState.title;
        if (ctaEl) {
          ctaEl.setAttribute('href', defaultContinueState.ctaHref);
          ctaEl.textContent = defaultContinueState.ctaText;
        }
      }
    }

    // 404 page quick continue button
    if (pageType === '404') {
      const lastVisited = readStorageJson(STORAGE.lastVisited, null);
      const continue404 = document.getElementById('notfound-continue-link');
      if (continue404) {
        if (lastVisited?.slug) {
          continue404.href = `${pageBase}${encodeURIComponent(lastVisited.slug)}.html`;
          continue404.textContent = `继续阅读：${lastVisited.shortTitle || lastVisited.title} →`;
          continue404.hidden = false;
        } else {
          continue404.hidden = true;
        }
      }
    }
    // Sync filtered TOC / syllabus part badges if a filter is currently active
    syncFilterUI();
  }

  function resetLocalProgress() {
    const now = Date.now();
    removeStorageKey(STORAGE.lastVisited);
    removeStorageKey(STORAGE.scroll);
    removeStorageKey(STORAGE.read);
    removeStorageKey(STORAGE.readTombstones);
    setResetAt(now);
    renderProgressUI();
    emitProgressChange('reset');
  }

  function initProgressTracking() {
    renderProgressUI();

    // Reset progress handler
    document.addEventListener('click', (event) => {
      const resetBtn = event.target.closest('[data-reset-progress]');
      if (!resetBtn) return;
      if (!window.confirm('确定要清除所有已读标记与上次阅读位置吗？（笔记不会被清除）')) return;
      resetLocalProgress();
      showToast('已清除学习进度记录', { autoHideMs: 3200 });
    });

    // Cross-tab progress & priority filter sync
    window.addEventListener('storage', (event) => {
      if (
        event.key === STORAGE.read ||
        event.key === STORAGE.readTombstones ||
        event.key === STORAGE.resetAt ||
        event.key === STORAGE.lastVisited ||
        event.key === STORAGE.scroll
      ) {
        renderProgressUI();
      } else if (event.key === STORAGE.priorityMode) {
        syncFilterUI(getPriorityState().value);
      } else if (event.key === STORAGE.readingStyle) {
        syncReadingStyleUI(getReadingStyleState().value, {
          persist: false,
          announce: false,
          preserveScroll: true,
          source: 'storage',
        });
      } else if (event.key === STORAGE.fontTheme) {
        syncFontThemeUI(getFontThemeState().value, {
          persist: false,
          announce: false,
          source: 'storage',
        });
      }
    });

    if (pageType !== 'article' || !currentSlug) return;

    // Record last visited immediately
    writeStorageJson(STORAGE.lastVisited, {
      slug: currentSlug,
      title: body.dataset.pageTitle || document.title,
      shortTitle: body.dataset.pageShortTitle || body.dataset.pageTitle || '',
      chapterTitle: body.dataset.chapterTitle || '',
      partTitle: body.dataset.partTitle || '',
      timestamp: Date.now(),
    });
    emitProgressChange('visit');

    // Mutable heading list & observer so reading-style swaps rebind cleanly with zero leaks
    let articleHeadings = [];
    let headingObserver = null;

    let manuallyUnmarked = false;
    let autoMarkedThisVisit = false;

    function markCurrentPageRead(isRead, announce = false) {
      const now = Date.now();
      const readMap = getReadPagesMap();
      const tombMap = getReadTombstonesMap();
      if (isRead) {
        readMap[currentSlug] = now;
        delete tombMap[currentSlug];
      } else {
        delete readMap[currentSlug];
        tombMap[currentSlug] = now;
      }
      writeStorageJson(STORAGE.read, readMap);
      writeStorageJson(STORAGE.readTombstones, tombMap);
      renderProgressUI();
      emitProgressChange('readToggle');
      if (announce) {
        showToast(isRead ? '已标记本节为已读' : '已取消本节已读标记', {
          autoHideMs: 2800,
        });
      }
    }

    // Manual toggle read button
    document.addEventListener('click', (event) => {
      const toggleBtn = event.target.closest('[data-read-toggle]');
      if (!toggleBtn) return;
      const readMap = getReadPagesMap();
      const nextState = !readMap[currentSlug];
      manuallyUnmarked = !nextState;
      markCurrentPageRead(nextState, true);
    });

    function revealDetailsAncestors(targetEl) {
      let opened = false;
      for (
        let d = targetEl?.closest?.('details');
        d;
        d = d.parentElement?.closest?.('details')
      ) {
        if (!d.open) {
          d.open = true;
          opened = true;
        }
      }
      return opened;
    }

    function revealHashTargetIfCollapsed(shouldScroll) {
      if (!window.location.hash || window.location.hash.length < 2) return;
      let rawId = window.location.hash.slice(1);
      try {
        rawId = decodeURIComponent(rawId);
      } catch {
        // Keep raw fragment if malformed.
      }
      const targetEl = document.getElementById(rawId);
      if (!targetEl) return;
      const expanded = revealDetailsAncestors(targetEl);
      if (expanded || shouldScroll) {
        requestAnimationFrame(() => {
          targetEl.scrollIntoView({
            behavior: reducedMotionMql.matches ? 'instant' : 'smooth',
            block: 'start',
          });
        });
      }
    }

    window.addEventListener('hashchange', () => revealHashTargetIfCollapsed(true));

    // Restore scroll position on refresh/return if no explicit #hash in URL
    // Deferred until boot reading-style swap finishes when user prefers axiomatic mode
    // Deferred until boot reading-style hydration finishes in initReadingStyleSwitcher()
    let restorePending = true;
    let initialRestoreDone = false;

    function consumePendingJumpIntent() {
      try {
        const raw = sessionStorage.getItem(STORAGE.jumpIntent);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
          sessionStorage.removeItem(STORAGE.jumpIntent);
          return null;
        }
        const age = Date.now() - (Number(parsed.ts) || 0);
        if (age > 30000) {
          sessionStorage.removeItem(STORAGE.jumpIntent);
          return null;
        }
        if (parsed.slug !== currentSlug) return null;
        sessionStorage.removeItem(STORAGE.jumpIntent);
        return {
          headingId: String(parsed.headingId || ''),
          headingText: String(parsed.headingText || ''),
        };
      } catch {
        return null;
      }
    }

    runInitialScrollOrHashRestore = () => {
      if (initialRestoreDone) return;
      initialRestoreDone = true;

      const intent = consumePendingJumpIntent();
      if (intent && (intent.headingId || intent.headingText)) {
        restorePending = false;
        jumpToArticleHeadingFn({
          headingId: intent.headingId,
          headingText: intent.headingText,
          instant: true,
        });
        return;
      }

      if (window.location.hash) {
        restorePending = false;
        revealHashTargetIfCollapsed(false);
        return;
      }
      const scrollMap = readStorageJson(STORAGE.scroll, {});
      const saved = scrollMap[currentSlug];
      if (saved && typeof saved.y === 'number' && saved.y > 90) {
        restorePending = true;
        requestAnimationFrame(() => {
          const maxScroll = Math.max(
            0,
            document.documentElement.scrollHeight - window.innerHeight
          );
          if (maxScroll > 90) {
            const targetY =
              saved.y > maxScroll && typeof saved.ratio === 'number'
                ? Math.round(saved.ratio * maxScroll)
                : Math.min(saved.y, maxScroll);
            window.scrollTo({ top: targetY, behavior: 'instant' });
            if (targetY > 90) {
              showToast('已恢复上次阅读位置', {
                showTopButton: true,
                autoHideMs: 5200,
              });
            }
          }
          restorePending = false;
        });
      } else {
        restorePending = false;
      }
    };

    function findCurrentHeadingId() {
      let currentId = '';
      const threshold = 110;
      for (const h of articleHeadings) {
        if (h.getBoundingClientRect().top <= threshold) {
          currentId = h.id;
        } else {
          break;
        }
      }
      return currentId;
    }

    function saveScrollSnapshot() {
      // Do not overwrite saved scroll position with y: 0 before background-tab rAF runs
      if (restorePending) return;
      const scrollable = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
      const y = Math.round(window.scrollY);
      const ratio = scrollable > 0 ? Math.min(1, Math.max(0, y / scrollable)) : 1;

      const scrollMap = readStorageJson(STORAGE.scroll, {});
      scrollMap[currentSlug] = {
        y,
        ratio: Number(ratio.toFixed(4)),
        headingId: findCurrentHeadingId(),
        updatedAt: Date.now(),
      };
      writeStorageJson(STORAGE.scroll, scrollMap);
      emitProgressChange('scroll');

      // Auto-mark read when scrolled near bottom
      if (!manuallyUnmarked && !autoMarkedThisVisit && scrollable > 80 && ratio >= 0.85) {
        const readMap = getReadPagesMap();
        if (!readMap[currentSlug]) {
          autoMarkedThisVisit = true;
          markCurrentPageRead(true, false);
        }
      }
    }

    let scrollThrottleTimer = null;
    window.addEventListener(
      'scroll',
      () => {
        if (scrollThrottleTimer) return;
        scrollThrottleTimer = setTimeout(() => {
          scrollThrottleTimer = null;
          saveScrollSnapshot();
        }, 200);
      },
      { passive: true }
    );

    window.addEventListener('pagehide', saveScrollSnapshot);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        saveScrollSnapshot();
      }
    });

    // Short micro-page auto-read after 5s of viewing
    const shortPageScrollable =
      document.documentElement.scrollHeight - window.innerHeight;
    if (shortPageScrollable <= 80) {
      setTimeout(() => {
        if (manuallyUnmarked || document.visibilityState !== 'visible') return;
        const readMap = getReadPagesMap();
        if (!readMap[currentSlug]) {
          autoMarkedThisVisit = true;
          markCurrentPageRead(true, false);
        }
      }, 5000);
    }

    // Right On-Page TOC active heading highlight (rebindable across reading-style swaps)
    rebindHeadingObserver = () => {
      if (headingObserver) {
        headingObserver.disconnect();
        headingObserver = null;
      }
      articleHeadings = Array.from(
        document.querySelectorAll('#article-body h2[id], #article-body h3[id], #article-body h4[id]')
      );
      const ontocLinks = Array.from(document.querySelectorAll('[data-ontoc-link]'));
      if (ontocLinks.length === 0 || articleHeadings.length === 0) return;

      const linkById = new Map(
        ontocLinks.map((el) => [el.dataset.ontocLink, el])
      );
      let activeHeadingId = '';

      function setActiveHeading(id) {
        if (!id || id === activeHeadingId) return;
        activeHeadingId = id;
        for (const [hid, el] of linkById.entries()) {
          el.classList.toggle('is-active', hid === id);
        }
      }

      headingObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setActiveHeading(entry.target.id);
              break;
            }
          }
        },
        { rootMargin: '-80px 0px -65% 0px', threshold: 0 }
      );

      for (const h of articleHeadings) {
        headingObserver.observe(h);
      }

      setActiveHeading(findCurrentHeadingId() || articleHeadings[0].id);
    };

    rebindHeadingObserver();
  }

  /* ========================================================================
     9. Dual Reading-Style Switcher ("讲解式 ↔ 公理版")
     Follows modern-web-guidance: accessibility (aria-pressed, quiet live region).
     ======================================================================== */

  const READING_STYLE_LABELS = {
    explained: body.dataset.readingStyleExplainedLabel || '讲解式',
    axiomatic: body.dataset.readingStyleAxiomaticLabel || '公理版',
  };

  const READING_STYLE_HINTS = {
    explained: body.dataset.readingStyleExplainedHint || '从直觉与例子出发循序推导',
    axiomatic: body.dataset.readingStyleAxiomaticHint || '精简定义与考纲标准证明',
  };

  // Shared per-element live-region controller so reading-style & font-theme
  // announcements sharing #reading-style-status never collide on timers.
  const prefsStatusState = new WeakMap();
  function announcePrefsStatus(el, message, isError = false, durationMs = 2600) {
    if (!el) return;
    let state = prefsStatusState.get(el);
    if (!state) {
      state = { timer: null, lastMsg: '' };
      prefsStatusState.set(el, state);
    }
    if (state.timer) clearTimeout(state.timer);
    let msg = message;
    if (msg === state.lastMsg) msg += '\u00A0';
    state.lastMsg = msg;
    el.classList.toggle('is-error', isError);
    el.classList.add('is-visible');
    el.textContent = '';
    requestAnimationFrame(() => {
      el.textContent = msg;
    });
    state.timer = setTimeout(() => {
      el.classList.remove('is-visible', 'is-error');
      el.textContent = '';
      state.timer = null;
    }, durationMs);
  }

  function initReadingStyleSwitcher() {
    const articleEl = document.getElementById('article-body');
    const axiomaticUrl = body.dataset.axiomaticUrl || '';
    const statusEl =
      document.getElementById('reading-style-status') ||
      document.getElementById('home-font-status');
    const inlineTocSlot = document.getElementById('inline-toc-slot');
    const ontocAside = document.getElementById('ontoc-aside');
    const ontocList = document.getElementById('ontoc-list');
    const contentStage = document.querySelector('.content-stage');
    const metaReadEl = document.querySelector('[data-meta-read-minutes]');
    const metaWordEl = document.querySelector('[data-meta-word-count]');
    const metaConceptEl = document.querySelector('[data-meta-concept-count]');

    const viewCache = new Map();
    let axiomaticPromise = null;
    let displayedMode = 'explained';
    let switchSeq = 0;

    function stripHeadingDecor(hEl) {
      const clone = hEl.cloneNode(true);
      for (const junk of clone.querySelectorAll('.heading-anchor, .sr-only')) {
        junk.remove();
      }
      return (clone.textContent || '').trim();
    }

    function normalizeHeadingKey(text) {
      return String(text || '')
        .replace(/^[\d一二三四五六七八九十百]+[、.．:：\s]+/, '')
        .replace(/\s+/g, '')
        .toLowerCase();
    }

    function extractHeadingsFromDom(root) {
      if (!root) return [];
      return Array.from(root.querySelectorAll('h2[id], h3[id], h4[id]')).map((h) => ({
        id: h.id,
        level: Number(h.tagName.slice(1)) || 2,
        text: stripHeadingDecor(h),
      }));
    }

    function parseLeadingNumber(text) {
      const m = String(text || '').match(/\d+/);
      return m ? Number(m[0]) : 0;
    }

    // Snapshot initial SSR explained view into memory cache for instant 0ms switch-back
    if (pageType === 'article' && articleEl) {
      viewCache.set('explained', {
        style: 'explained',
        html: articleEl.innerHTML,
        headings: extractHeadingsFromDom(articleEl),
        readMinutes: parseLeadingNumber(metaReadEl?.textContent),
        wordCount: parseLeadingNumber(metaWordEl?.textContent),
        referencedConceptCount: metaConceptEl?.hidden
          ? 0
          : parseLeadingNumber(metaConceptEl?.textContent),
      });
    }

    function showStyleStatus(message, isError = false, durationMs = 2600) {
      announcePrefsStatus(statusEl, message, isError, durationMs);
    }

    function updateStyleControlsUI(mode) {
      const normalized = normalizeReadingStyleValue(mode);
      document.documentElement.dataset.readingStyle = normalized;
      for (const btn of document.querySelectorAll('[data-reading-style-btn]')) {
        btn.setAttribute(
          'aria-pressed',
          String(btn.dataset.readingStyleBtn === normalized)
        );
      }
      for (const hint of document.querySelectorAll('[data-reading-style-hint]')) {
        hint.textContent = READING_STYLE_HINTS[normalized];
      }
    }

    function fetchAxiomaticView() {
      if (viewCache.has('axiomatic')) {
        return Promise.resolve(viewCache.get('axiomatic'));
      }
      if (!axiomaticUrl) {
        return Promise.reject(new Error('No axiomatic view URL'));
      }
      if (axiomaticPromise) return axiomaticPromise;
      axiomaticPromise = fetch(axiomaticUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (!data || typeof data.html !== 'string') {
            throw new Error('Invalid axiomatic view payload');
          }
          viewCache.set('axiomatic', data);
          return data;
        })
        .catch((err) => {
          axiomaticPromise = null;
          throw err;
        });
      return axiomaticPromise;
    }

    function rebuildArticleTocs(headings) {
      const list = Array.isArray(headings) ? headings : [];

      if (inlineTocSlot) {
        if (list.length >= 2) {
          const details = document.createElement('details');
          details.className = 'inline-toc';
          const summary = document.createElement('summary');
          const sumSpan = document.createElement('span');
          sumSpan.textContent = `本页小节导航（${list.length}）`;
          summary.appendChild(sumSpan);

          const ul = document.createElement('ul');
          ul.className = 'inline-toc-list';
          for (const h of list) {
            const li = document.createElement('li');
            li.className = `inline-toc-h${h.level || 2}`;
            const a = document.createElement('a');
            a.href = `#${h.id}`;
            a.textContent = h.text || '';
            li.appendChild(a);
            ul.appendChild(li);
          }
          details.append(summary, ul);
          inlineTocSlot.replaceChildren(details);
        } else {
          inlineTocSlot.replaceChildren();
        }
      }

      if (ontocList && ontocAside) {
        const frag = document.createDocumentFragment();
        for (const h of list) {
          const li = document.createElement('li');
          li.className = `ontoc-item-h${h.level || 2}`;
          const a = document.createElement('a');
          a.className = 'ontoc-link';
          a.href = `#${h.id}`;
          a.dataset.ontocLink = h.id;
          a.textContent = h.text || '';
          li.appendChild(a);
          frag.appendChild(li);
        }
        ontocList.replaceChildren(frag);
        const hasAny = list.length > 0;
        ontocAside.hidden = !hasAny;
        if (contentStage) {
          contentStage.classList.toggle('has-ontoc', hasAny);
        }
      }
    }

    function updateArticleMetaPills(view) {
      if (metaReadEl) {
        const mins = Number(view.readMinutes) || 0;
        metaReadEl.textContent = mins > 0 ? `预计 ${mins} 分钟` : '';
        metaReadEl.hidden = mins <= 0;
      }
      if (metaWordEl) {
        const wc = Number(view.wordCount) || 0;
        metaWordEl.textContent = wc > 0 ? `约 ${wc} 字` : '';
        metaWordEl.hidden = wc <= 0;
      }
      if (metaConceptEl) {
        const cc = Number(view.referencedConceptCount) || 0;
        metaConceptEl.textContent = cc > 0 ? `含 ${cc} 个前置概念速览` : '';
        metaConceptEl.hidden = cc <= 0;
      }
    }

    function findCurrentHeadingSnapshot() {
      if (!articleEl) return null;
      const headings = Array.from(
        articleEl.querySelectorAll('h2[id], h3[id], h4[id]')
      );
      let current = null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= 130) {
          current = h;
        } else {
          break;
        }
      }
      if (!current) return null;
      return { id: current.id, text: stripHeadingDecor(current) };
    }

    function findMatchingHeadingInArticle(headingId, headingText) {
      if (!articleEl) return null;
      const wantedKey = normalizeHeadingKey(headingText);
      const candidates = Array.from(
        articleEl.querySelectorAll('h2[id], h3[id], h4[id]')
      );
      const byId = headingId ? document.getElementById(headingId) : null;
      if (byId && articleEl.contains(byId)) {
        if (!wantedKey) return byId;
        if (normalizeHeadingKey(stripHeadingDecor(byId)) === wantedKey) {
          return byId;
        }
      }
      if (!wantedKey) return null;

      // Pass 1: exact normalized title match across all headings first
      const exactMatch = candidates.find(
        (h) => normalizeHeadingKey(stripHeadingDecor(h)) === wantedKey
      );
      if (exactMatch) return exactMatch;

      // Pass 2: substring fallback only when both normalized keys have length >= 3
      if (wantedKey.length >= 3) {
        const subMatch = candidates.find((h) => {
          const hk = normalizeHeadingKey(stripHeadingDecor(h));
          return hk.length >= 3 && (hk.includes(wantedKey) || wantedKey.includes(hk));
        });
        if (subMatch) return subMatch;
      }
      return null;
    }

    function restoreReadingAnchor(prevRatio, prevHeading, prevScrollY) {
      if (prevScrollY <= 120) return;
      if (prevHeading && articleEl) {
        const match = findMatchingHeadingInArticle(prevHeading.id, prevHeading.text);
        if (match) {
          match.scrollIntoView({ behavior: 'instant', block: 'start' });
          return;
        }
      }
      const nextScrollable = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
      if (nextScrollable > 80) {
        window.scrollTo({
          top: Math.round(prevRatio * nextScrollable),
          behavior: 'instant',
        });
      }
    }

    async function setReadingStyle(
      mode,
      { persist = true, announce = true, preserveScroll = true, source = 'user' } = {}
    ) {
      const targetMode = normalizeReadingStyleValue(mode);
      const mySeq = ++switchSeq;

      // On Home / 404 pages, persist and update controls immediately
      if (pageType !== 'article' || !articleEl) {
        const changed = targetMode !== displayedMode;
        if (persist && changed) {
          saveReadingStyleState(targetMode, Date.now());
          emitProgressChange('readingStyle');
        }
        displayedMode = targetMode;
        delete document.documentElement.dataset.readingStylePending;
        updateStyleControlsUI(targetMode);
        document.dispatchEvent(
          new CustomEvent('notes:reading-style-change', {
            detail: { mode: targetMode, source },
          })
        );
        if (announce && changed) {
          showStyleStatus(
            targetMode === 'axiomatic'
              ? `已设为默认${READING_STYLE_LABELS.axiomatic}`
              : `已设为默认${READING_STYLE_LABELS.explained}`,
            false,
            2400
          );
        }
        return { ok: true, mode: targetMode };
      }

      if (targetMode === displayedMode && viewCache.has(targetMode)) {
        delete articleEl.dataset.switching;
        delete document.documentElement.dataset.readingStylePending;
        if (persist) {
          saveReadingStyleState(targetMode, Date.now());
          emitProgressChange('readingStyle');
        }
        updateStyleControlsUI(targetMode);
        return { ok: true, mode: targetMode };
      }

      // Close floating concept card & selection toolbar to prevent ghost anchors
      hideRecallPopoverFn({ freezePosition: true });
      document.dispatchEvent(
        new CustomEvent('notes:overlay-open', {
          detail: { source: 'reading-style-switch' },
        })
      );

      let view = viewCache.get(targetMode);
      if (!view && targetMode === 'axiomatic') {
        articleEl.dataset.switching = 'true';
        try {
          view = await fetchAxiomaticView();
        } catch {
          if (mySeq !== switchSeq) return { ok: false, reason: 'stale' };
          delete articleEl.dataset.switching;
          delete document.documentElement.dataset.readingStylePending;
          updateStyleControlsUI(displayedMode);
          if (announce || source === 'boot') {
            const failMsg =
              window.location.protocol === 'file:'
                ? `本地离线文件模式仅内嵌${READING_STYLE_LABELS.explained}正文，已保留${READING_STYLE_LABELS.explained}`
                : `当前离线或无法加载${READING_STYLE_LABELS.axiomatic}，已保留${READING_STYLE_LABELS.explained}正文`;
            showStyleStatus(failMsg, true, 3600);
          }
          if (source === 'boot') runInitialScrollOrHashRestore();
          return { ok: false, reason: 'fetch-failed', mode: displayedMode };
        }
      }

      if (mySeq !== switchSeq) return { ok: false, reason: 'stale' };
      if (!view) {
        delete articleEl.dataset.switching;
        delete document.documentElement.dataset.readingStylePending;
        return { ok: false, reason: 'missing-view' };
      }

      // Persist only after target view is verified ready (prevents offline/file:// poison)
      if (persist) {
        saveReadingStyleState(targetMode, Date.now());
        emitProgressChange('readingStyle');
      }

      const prevScrollY = window.scrollY;
      const prevScrollable = Math.max(
        1,
        document.documentElement.scrollHeight - window.innerHeight
      );
      const prevRatio = Math.min(1, Math.max(0, prevScrollY / prevScrollable));
      const prevHeading = preserveScroll ? findCurrentHeadingSnapshot() : null;

      // Mount compiled HTML safely via DOMParser + replaceChildren (zero raw innerHTML write)
      const parsed = new DOMParser().parseFromString(view.html, 'text/html');
      articleEl.replaceChildren(...parsed.body.childNodes);

      const resolvedHeadings =
        Array.isArray(view.headings) && view.headings.length > 0
          ? view.headings
          : extractHeadingsFromDom(articleEl);
      rebuildArticleTocs(resolvedHeadings);
      updateArticleMetaPills(view);
      rebindHeadingObserver();
      syncArticleDetailsToggle();

      displayedMode = targetMode;
      delete articleEl.dataset.switching;
      delete document.documentElement.dataset.readingStylePending;
      updateStyleControlsUI(targetMode);

      if (preserveScroll) {
        restoreReadingAnchor(prevRatio, prevHeading, prevScrollY);
      }
      if (source === 'boot') {
        runInitialScrollOrHashRestore();
      }

      document.dispatchEvent(
        new CustomEvent('notes:reading-style-change', {
          detail: { mode: targetMode, source },
        })
      );

      if (announce) {
        showStyleStatus(
          targetMode === 'axiomatic'
            ? `已切换为${READING_STYLE_LABELS.axiomatic}`
            : `已切换为${READING_STYLE_LABELS.explained}`,
          false,
          2400
        );
      }
      return { ok: true, mode: targetMode };
    }

    async function jumpToArticleHeading({
      headingId = '',
      headingText = '',
      instant = false,
    } = {}) {
      if (pageType !== 'article' || !articleEl) return false;
      let targetEl = findMatchingHeadingInArticle(headingId, headingText);
      let switchedLabel = '';

      if (!targetEl && dualMode && (headingId || headingText) && axiomaticUrl) {
        const currentMode = displayedMode;
        const otherMode = currentMode === 'explained' ? 'axiomatic' : 'explained';
        const res = await setReadingStyle(otherMode, {
          persist: false,
          announce: false,
          preserveScroll: false,
          source: 'notebook-jump',
        });
        if (res?.ok) {
          const foundInOther = findMatchingHeadingInArticle(headingId, headingText);
          if (foundInOther) {
            targetEl = foundInOther;
            switchedLabel =
              otherMode === 'axiomatic'
                ? READING_STYLE_LABELS.axiomatic
                : READING_STYLE_LABELS.explained;
            // Persist matched mode so a later cloud sync does not snap back
            saveReadingStyleState(otherMode, Date.now());
            emitProgressChange('readingStyle');
          } else {
            await setReadingStyle(currentMode, {
              persist: false,
              announce: false,
              preserveScroll: false,
              source: 'notebook-jump-revert',
            });
          }
        }
      }

      if (!targetEl) {
        targetEl = (headingId && document.getElementById(headingId)) || articleEl;
      }
      if (!targetEl) return false;

      for (
        let d = targetEl.closest?.('details');
        d;
        d = d.parentElement?.closest?.('details')
      ) {
        d.open = true;
      }
      targetEl.scrollIntoView({
        behavior: instant || reducedMotionMql.matches ? 'instant' : 'smooth',
        block: 'start',
      });
      targetEl.classList.remove('is-jump-highlight');
      void targetEl.offsetWidth;
      targetEl.classList.add('is-jump-highlight');
      if (switchedLabel) {
        showToast(`已切换至「${switchedLabel}」并定位到对应小节`, {
          autoHideMs: 3400,
        });
      }
      return true;
    }

    jumpToArticleHeadingFn = jumpToArticleHeading;

    if (!dualMode) {
      delete document.documentElement.dataset.readingStylePending;
      if (pageType === 'article') runInitialScrollOrHashRestore();
      return {
        getReadingStyle: () => defaultReadingStyle,
        getPreferredReadingStyle: () => defaultReadingStyle,
        setReadingStyle: () => Promise.resolve({ ok: false, reason: 'single-mode' }),
        jumpToArticleHeading,
        canSwitchReadingStyle: () => false,
      };
    }

    syncReadingStyleUI = setReadingStyle;

    // Click handler for all reading-style toggle buttons (Article + Home)
    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-reading-style-btn]');
      if (!btn) return;
      const nextMode = btn.dataset.readingStyleBtn || 'explained';
      setReadingStyle(nextMode, {
        persist: true,
        announce: true,
        preserveScroll: true,
        source: 'user',
      });
    });

    // Silent 0ms prefetch of axiomatic JSON on hover / focus of the 公理版 button
    if (pageType === 'article' && axiomaticUrl) {
      const triggerPrefetch = () => {
        if (!viewCache.has('axiomatic') && !axiomaticPromise) {
          fetchAxiomaticView().catch(() => {});
        }
      };
      for (const btn of document.querySelectorAll('[data-reading-style-btn="axiomatic"]')) {
        btn.addEventListener('pointerenter', triggerPrefetch, { passive: true });
        btn.addEventListener('focusin', triggerPrefetch, { passive: true });
      }
    }

    // Boot hydration: honor persisted preference cleanly
    const initialMode = getReadingStyleState().value;
    if (pageType !== 'article' || !articleEl) {
      displayedMode = initialMode;
    }
    updateStyleControlsUI(initialMode);
    if (pageType === 'article' && initialMode === 'axiomatic' && axiomaticUrl) {
      setReadingStyle('axiomatic', {
        persist: false,
        announce: false,
        preserveScroll: false,
        source: 'boot',
      });
    } else {
      delete document.documentElement.dataset.readingStylePending;
      if (pageType === 'article') runInitialScrollOrHashRestore();
    }

    return {
      getReadingStyle: () =>
        pageType === 'article' ? displayedMode : getReadingStyleState().value,
      getPreferredReadingStyle: () => getReadingStyleState().value,
      setReadingStyle,
      jumpToArticleHeading,
      canSwitchReadingStyle: () => Boolean(pageType === 'article' && axiomaticUrl),
    };
  }

  /* ========================================================================
     10. Triple Editorial Font Theme Switcher ("宋体 | 文楷 | 黑体")
     Follows modern-web-guidance: accessibility (aria-pressed, quiet live region).
     ======================================================================== */

  const FONT_THEME_META = {
    serif: {
      label: '宋体',
      hint: 'Claude 出版风：Source Serif 4 + 思源宋体',
    },
    wenkai: {
      label: '文楷',
      hint: '温和讲义风：Source Serif 4 + 霞鹜文楷',
    },
    sans: {
      label: '黑体',
      hint: '简洁无衬线：Inter + 系统黑体',
    },
  };

  function initFontThemeSwitcher() {
    const statusEl =
      document.getElementById('reading-style-status') ||
      document.getElementById('home-font-status');
    let currentTheme = getFontThemeState().value;

    function updateFontControlsUI(theme) {
      const normalized = normalizeFontThemeValue(theme);
      document.documentElement.dataset.fontTheme = normalized;
      for (const btn of document.querySelectorAll('[data-font-theme-btn]')) {
        btn.setAttribute(
          'aria-pressed',
          String(btn.dataset.fontThemeBtn === normalized)
        );
      }
      const meta = FONT_THEME_META[normalized];
      for (const hint of document.querySelectorAll('[data-font-theme-hint]')) {
        hint.textContent = meta.hint;
      }
    }

    function setFontTheme(
      theme,
      { persist = true, announce = true, source = 'user' } = {}
    ) {
      const target = normalizeFontThemeValue(theme);
      const changed = target !== currentTheme;
      currentTheme = target;
      if (persist) {
        saveFontThemeState(target, Date.now());
        emitProgressChange('fontTheme');
      }
      updateFontControlsUI(target);
      document.dispatchEvent(
        new CustomEvent('notes:font-theme-change', {
          detail: { theme: target, source },
        })
      );
      if (announce && (changed || source === 'api')) {
        announcePrefsStatus(
          statusEl,
          `已切换为${FONT_THEME_META[target].label}字体`,
          false,
          2400
        );
      }
      return { ok: true, theme: target };
    }

    syncFontThemeUI = setFontTheme;

    document.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-font-theme-btn]');
      if (!btn) return;
      const nextTheme = normalizeFontThemeValue(btn.dataset.fontThemeBtn);
      if (nextTheme === currentTheme) return;
      setFontTheme(nextTheme, { persist: true, announce: true, source: 'user' });
    });

    // Boot hydration: honor persisted preference cleanly with zero FOUC
    updateFontControlsUI(currentTheme);

    return {
      getFontTheme: () => currentTheme,
      setFontTheme: (theme, opts = {}) =>
        setFontTheme(theme, {
          persist: true,
          announce: true,
          source: 'api',
          ...opts,
        }),
    };
  }

  /* ========================================================================
     Bootstrap & Shared Bridge for notebook-sync.js
     ======================================================================== */

  initThemeToggle();
  initReadingProgressFallback();
  initToastHandlers();
  initAccordionsAndFilters();
  initMobileDrawer();
  initConceptRecallPopover();
  initProgressTracking();
  const readingStyleApi = initReadingStyleSwitcher();
  const fontThemeApi = initFontThemeSwitcher();

  const siteAppApi = {
    pageType,
    currentSlug,
    assetBase,
    pageBase,
    totalPages,
    storagePrefix,
    themeKey,
    exportPrefix,
    dualMode,
    defaultReadingStyle,
    defaultFontTheme,
    hasNativePopover,
    storageKeys: STORAGE,
    readStorageJson,
    writeStorageJson,
    removeStorageKey,
    formatRelativeTime,
    getProgressState,
    applyMergedProgress,
    resetLocalProgress,
    onProgressChange,
    renderProgressUI,
    showToast,
    dismissToast,
    hidePopoverAnimated,
    supportsTopLayerExit,
    bindClosedByFallback,
    closeDialogAnimated,
    loadConcepts,
    getReadingStyle: readingStyleApi.getReadingStyle,
    getPreferredReadingStyle: readingStyleApi.getPreferredReadingStyle,
    setReadingStyle: readingStyleApi.setReadingStyle,
    getFontTheme: fontThemeApi.getFontTheme,
    setFontTheme: fontThemeApi.setFontTheme,
    jumpToArticleHeading: readingStyleApi.jumpToArticleHeading,
    canSwitchReadingStyle: readingStyleApi.canSwitchReadingStyle,
    revealDetailsAncestors: (targetEl) => {
      for (
        let d = targetEl?.closest?.('details');
        d;
        d = d.parentElement?.closest?.('details')
      ) {
        d.open = true;
      }
    },
    isRecallPopoverOpen: () => {
      const p = document.getElementById('concept-popover');
      if (!p) return false;
      return hasNativePopover ? p.matches(':popover-open') : p.classList.contains(':popover-open');
    },
    getActiveConcept: () => activeConceptRecord,
    hideRecallPopover: (opts) => hideRecallPopoverFn(opts),
  };

  window.NotesSiteApp = siteAppApi;
  window.__NOTES_SITE_APP__ = siteAppApi;
  Object.defineProperty(window, 'AlgebraApp', {
    get: () => siteAppApi,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(window, '__ALGEBRA_APP__', {
    get: () => siteAppApi,
    enumerable: false,
    configurable: true,
  });
})();
