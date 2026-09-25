// ==UserScript==
// @name         Arena Sidebar Tweaks
// @namespace    https://arena.ai/
// @version      0.7.2
// @description  Rebuilds the chat sidebar as the real thing: grouping by Folders (drag & drop, right-click, native "..." menu), Active time, Month, or Type — plus a Native escape mode. Mode picker / sync / settings live in a Leaderboard-style hover flyout at the sidebar's bottom. Auto-sort rules, history sync via the site's own API (scroll-sweep fallback).
// @author       HumbleDeer + Arena Agent Mode
// @match        https://arena.ai/*
// @match        https://*.arena.ai/*
// @icon         https://arena.ai/images/favicon-rebrand.svg
// @grant        none
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

// // // https://upload.wikimedia.org/wikipedia/commons/c/c3/Emoji_u1f34d.svg // da's a pineapple fren

/*
 * ============================================================================
 *  WHAT IT DOES
 * ============================================================================
 *  - The script's list REPLACES the sidebar content permanently. Grouping is
 *    a mode, picked from a flyout at the bottom of the sidebar:
 *        Folders   – your groups + Unsorted (drag & drop, move menus)
 *        Time      – Today / Yesterday / Older (≈ the stock behavior)
 *        Month     – one group per calendar month
 *        Type      – Agent / Battle / Side-by-Side / …
 *        Native    – escape hatch: the untouched original list
 *    Keyboard: Ctrl+Alt+G toggles between Native and the last custom mode.
 *  - The bottom row is styled (and behaves) like the site's Leaderboard row:
 *    hover/click opens a popover built from the site's own flyout anatomy
 *    (top-level anchor entries, then border-t separated sections with mono
 *    uppercase labels). It holds the grouping modes, Native, Sync and
 *    Settings. No stats, no permanently rendered chrome.
 *  - Rows use the site's own markup vocabulary (data-sidebar="menu-item" /
 *    "menu-button", the observed row class string, icon chip, body-sm title),
 *    so theme styling applies natively. Groups use data-sidebar="group" +
 *    "group-label" + "group-content" like the stock sections. Collapsible
 *    group chevrons point DOWN when expanded and RIGHT when collapsed.
 *  - Move chats: drag & drop onto a folder, right-click -> "Move to", or the
 *    native "..." menu -> injected "Move to…" item (works in every mode).
 *  - Optional rules ("Work | invoice" or "/deploy|build/i") auto-file a chat
 *    the first time the script learns about it (API, DOM, or menu). There is
 *    a global on/off toggle in settings.
 *  - History sync via GET /api/history/unified?limit=20 (unfiltered — the
 *    sidebar lists agentic sessions AND evaluations), cursor-paginated with
 *    URLSearchParams so '+'-bearing cursors are encoded correctly. Throttled
 *    background sync at boot (toggleable), on demand from the flyout, with
 *    an automatic scroll-sweep fallback if the API fails.
 *  - Chats are tracked in a local registry keyed by their sidebar URL, so
 *    every mode renders instantly after reloads / sidebar collapses.
 *
 *  URL SHAPES (observed): agent sessions link as /agent/<uuid>; most other
 *  conversations as /c/<uuid> when opened from the sidebar. API-only chats
 *  get type-appropriate placeholder hrefs; wrong guesses self-heal (records
 *  and their assignments are re-keyed when the real link shows up in the DOM).
 *
 *  RESILIENCE: the site's React app may re-render/clobber any DOM at any time
 *  (sidebar collapse/reopen rebuilds everything; Radix menus unmount on
 *  close). Nothing important lives in the DOM: state is in localStorage, and
 *  a MutationObserver re-mounts the panel, re-applies the view attribute and
 *  re-injects menu items whenever the app rips them out. All DOM writes are
 *  change-gated so the observer never feeds itself (no busy loops).
 *
 *  NAMING: structures that exist in the site's component library are reused
 *  verbatim (data-sidebar="group"/"group-label"/"group-content"/"menu"/
 *  "menu-item"/"menu-button"/"footer"). The small "cv-" namespace is used
 *  ONLY for concepts the site doesn't have (panel root, drag state, our
 *  flyout/modal shells). Stock class strings live in the SITE_CLASSES block
 *  below — refresh them from DevTools if the site updates. NOTE: class names
 *  like `group/leaderboard` must stay literal: Tailwind only compiles class
 *  names that appear in the site's own source, so "renaming" them would
 *  silently lose their styling.
 *
 *  IF THE SITE CHANGES ITS MARKUP: selectors are centralized in SEL.
 * ============================================================================
 */

(() => {
  'use strict';

  // ============================== CONFIG ====================================
  const CONFIG = {
    STORAGE_KEY: 'arena-tweaks_sidebar-v1',

    // Mode used on fresh install (no saved state yet).
    DEFAULT_VIEW: 'time',

    // Rules applied when a chat is seen for the very first time.
    // pattern: plain substring (case-insensitive) or /regular expression/
    DEFAULT_RULES: [
      // { group: 'Work',  pattern: 'invoice' },
      // { group: 'Code',  pattern: '/\\b(bug|deploy|regex)\\b/i' },
    ],

    // ---- history API (see uploads/arena-history-unified.apib.txt) ----------
    API_PATH: '/api/history/unified',
    // The sidebar lists agentic sessions AND evaluations, so we request the
    // unfiltered feed (the survey's "Unfiltered" target) plus page size.
    API_PARAMS: {
      limit: '50',                 // only 20 is verified by the API survey
    },
    // Placeholder hrefs for chats known only from the API (observed):
    //   agentic sessions    -> /agent/<uuid>
    //   other conversations -> /c/<uuid>
    // Wrong guesses self-heal from the DOM (see syncState/re-key).
    API_HREF_AGENTIC: '/agent/',
    API_HREF_OTHER: '/c/',
    API_PAGE_DELAY: 150,           // polite delay between paginated requests (ms)
    API_MAX_PAGES: 30,             // safety cap (>1000 chats at limit=50)
    SYNC_THROTTLE: 5 * 60 * 1000,  // background sync at most every 5 min

    DEBUG: false,
  };

  // ============================ SITE CLASSES ================================
  // Class strings lifted from live markup (user-provided snippets). If the
  // site's build changes, re-copy them from DevTools — nothing else needs to
  // know. Named groups (group/leaderboard) must stay literal (see header).
  const SITE_CLASSES = {
    // Leaderboard-style nav row (<a data-sidebar="menu-button">):
    navRow: 'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left outline-none ring-sidebar-ring transition-[width,height,padding] focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>span]:group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-8 text-base group-data-[collapsible=icon]:transition-none data-[active=true]:font-normal text-text-primary group/leaderboard',
    // its hover-revealed right chevron (svg class):
    navRowChevron: 'ml-auto h-4 w-4 opacity-0 transition-opacity group-hover/leaderboard:opacity-100',
    // Wrapper structures for the bottom row (user-captured from the live DOM):
    separator: 'shrink-0 h-[1px] bg-sidebar-border -mx-2 w-auto',
    footerGroup: 'relative flex w-full min-w-0 flex-col p-2 pb-0',
    menuCol: 'flex w-full min-w-0 flex-col gap-1',
    menuItem: 'group/menu-item relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center',
    // conversation row (<a data-sidebar="menu-button">):
    menuButton: 'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left outline-none ring-sidebar-ring transition-[width,height,padding] focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>span]:group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent text-base group-data-[collapsible=icon]:transition-none data-[active=true]:font-normal text-text-secondary hover:text-text-primary data-[active=true]:text-text-primary h-auto py-1.5',
    chip: 'bg-surface-primary flex-shrink-0 rounded-full p-1',
    chipSvg: 'text-interactive-normal size-3',
    title: 'body-sm truncate',
    // group-label: never captured from the live site — paste classes here for
    // pixel-perfect section headers. .cv-group-label stays as the baseline.
    groupLabel: '',
    // Flyout popover (Leaderboard hover menu anatomy):
    flyout: 'text-text-primary z-50 shadow-md outline-none border-border-faint bg-surface-secondary w-[13rem] rounded-md border p-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=right]:slide-in-from-left-2',
    flyoutEntry: 'text-text-primary hover:bg-surface-tertiary flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm no-underline transition-colors cursor-pointer',
    flyoutIcon: 'flex h-4 w-4 items-center justify-center',
    flyoutSep: 'border-border-faint my-1 border-t',
    flyoutLabel: 'text-text-tertiary font-rebrand-mono px-2 py-1.5 text-[10px] uppercase tracking-wide',
    // Form controls (settings modal):
    input: 'rounded-md border border-border-faint bg-surface-primary px-2 py-1 text-sm text-text-primary',
    btn: 'rounded-md border border-border-faint px-2 py-1.5 text-sm transition-colors hover:bg-surface-tertiary text-text-primary cursor-pointer',
    btnDanger: 'text-interactive-negative',
    closeBtn: 'rounded px-2 py-1 text-sm transition-colors hover:bg-surface-tertiary text-text-primary cursor-pointer',
  };

  // ============================= SELECTORS ==================================
  // All knowledge about the site's markup lives here.
  const SEL = {
    sidebar:    'div[data-sidebar="sidebar"]',
    content:    'div[data-sidebar="content"]',      // scroll container of the chat list
    stockGroup: 'div[data-sidebar="group"]',        // one time-section ("Today", ...)
    groupLabel: '[data-sidebar="group-label"]',
    item:       'li[data-sidebar="menu-item"]',     // one conversation row
    itemLink:   'a[data-sidebar="menu-button"]',    // the clickable link inside a row
    navMenu:    'ul[data-sidebar="menu"]',          // nav list (New Chat / Leaderboard / Search)
    // Radix dropdown-menu portals (rendered near <body> while open):
    radixMenu:  'div[role="menu"][data-radix-menu-content]',
    radixItem:  '[role="menuitem"]',
    // The destructive Archive row (we insert our item before it):
    archiveIcon: '.lucide-archive',
  };

  const INBOX = '__unsorted'; // pseudo-group id for unassigned chats

  // ============================== UTILITIES =================================
  const log  = (...a) => CONFIG.DEBUG && console.debug('[grouped-sidebar]', ...a);
  const warn = (...a) => console.warn('[grouped-sidebar]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid  = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const escAttr = escHtml;
  const cssEsc = (s) =>
    (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

  // Parse timestamps like "2026-09-22 22:06:14.908175+00" (space instead of
  // T, +00-style offsets, variable fractional digits). Returns ms epoch or 0.
  function parseTs(s) {
    if (!s || typeof s !== 'string') return 0;
    const m = s.trim().match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/
    );
    if (!m) { const t = Date.parse(s); return isNaN(t) ? 0 : t; }
    const msFrac = +((m[7] || '0').slice(0, 3).padEnd(3, '0'));
    let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], msFrac);
    const tz = m[8];
    if (tz && tz !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const hh = +tz.slice(1, 3) || 0;
      const mm = tz.includes(':') ? (+tz.slice(4, 6) || 0) : (+tz.slice(3, 5) || 0);
      ms -= sign * (hh * 60 + mm) * 60000;
    }
    return ms;
  }

  // Local-day bucket names, matching the sidebar's Today/Yesterday/Older.
  function bucketFromDate(ms) {
    if (!ms) return '';
    const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((dayOf(new Date()) - dayOf(new Date(ms))) / 86400000);
    return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Older';
  }

  function monthLabelFrom(ms) {
    if (!ms) return 'Undated';
    try {
      return new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } catch (e) { return 'Undated'; }
  }

  // Infer the evaluation modality from a sidebar href's section route
  // (/text/ /search/ /code/ /image/ /video/). Returns e.g. 'webdev' or null.
  function inferModality(key) {
    const m = String(key).match(/^\/(text|search|code|image|video)\//);
    if (!m) return null;
    return { text: 'chat', search: 'search', code: 'webdev', image: 'image', video: 'video' }[m[1]];
  }

  // ================================ ICONS ===================================
  const svg = (inner, size = 14, cls = '') =>
    `<svg${cls ? ` class="${escAttr(cls)}"` : ''} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    // Group collapse chevron: DOWN when expanded, rotates to RIGHT (CSS -90°)
    // when collapsed.
    chevron: `<svg class="cv-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`,
    chevRight: svg('<path d="M9 6L15 12L9 18"/>', 24, ''),
    layers:  svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
    folder:  svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    gear:    svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    check:   svg('<polyline points="20 6 9 17 4 12"/>', 12),
    x:       svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 16),
  };

  // ============================ CHAT ICONS ==================================
  // Leading icon per conversation type, mirroring the stock rows (chip div +
  // svg). The panel lives inside the site's DOM, so the site's own utility
  // classes style our chips too (theme-correct for free).
  //
  // Only 'search' is the REAL icon (copied from a live sidebar entry).
  // ALL OTHERS ARE PLACEHOLDERS: inspect a chat of each type in the stock
  // sidebar, copy its <svg>…</svg> inner markup, and paste it over the
  // placeholder path(s) below.
  const CHAT_ICONS = {
    // Web Search arena — real icon (globe):
    search: '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 24 24" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M13 2.04932C13 2.04932 16 5.99994 16 11.9999" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M11 21.9506C11 21.9506 8 17.9999 8 11.9999C8 5.99994 11 2.04932 11 2.04932" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M2.62964 15.5H12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M2.62964 8.5H21.3704" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M21.8789 17.9174C22.3727 18.2211 22.3423 18.9604 21.8337 19.0181L19.2671 19.309L18.1159 21.6213C17.8878 22.0795 17.1827 21.8552 17.0661 21.2873L15.8108 15.1713C15.7123 14.6913 16.1437 14.3892 16.561 14.646L21.8789 17.9174Z" stroke="currentColor"></path></svg>',
    agent:  '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 24 24" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M7 2.05C7 2.02239 7.02239 2 7.05 2H7.95C7.97761 2 8 2.02239 8 2.05V2.95C8 2.97761 7.97761 3 7.95 3H7.05C7.02239 3 7 2.97761 7 2.95V2.05Z" fill="currentColor"></path><path d="M7.00391 2.96973C7.01152 2.9875 7.02926 2.99992 7.0498 3H7.9502L7.96973 2.99609C7.98152 2.99104 7.99104 2.98152 7.99609 2.96973L8 2.9502V2.0498C7.99992 2.02926 7.9875 2.01152 7.96973 2.00391L7.9502 2V1C8.52994 1.00011 8.99989 1.47006 9 2.0498V2.9502C8.99989 3.52994 8.52994 3.99989 7.9502 4H7.0498C6.47006 3.99989 6.00011 3.52994 6 2.9502V2.0498C6.00011 1.47006 6.47006 1.00011 7.0498 1V2C7.02235 2.00011 7.00011 2.02235 7 2.0498V2.9502L7.00391 2.96973ZM7.9502 1V2H7.0498V1H7.9502Z" fill="currentColor"></path><path d="M7 21.05C7 21.0224 7.02239 21 7.05 21H7.95C7.97761 21 8 21.0224 8 21.05V21.95C8 21.9776 7.97761 22 7.95 22H7.05C7.02239 22 7 21.9776 7 21.95V21.05Z" fill="currentColor"></path><path d="M7.00391 21.9697C7.01152 21.9875 7.02926 21.9999 7.0498 22H7.9502L7.96973 21.9961C7.98152 21.991 7.99104 21.9815 7.99609 21.9697L8 21.9502V21.0498C7.99992 21.0293 7.9875 21.0115 7.96973 21.0039L7.9502 21V20C8.52994 20.0001 8.99989 20.4701 9 21.0498V21.9502C8.99989 22.5299 8.52994 22.9999 7.9502 23H7.0498C6.47006 22.9999 6.00011 22.5299 6 21.9502V21.0498C6.00011 20.4701 6.47006 20.0001 7.0498 20V21C7.02235 21.0001 7.00011 21.0223 7 21.0498V21.9502L7.00391 21.9697ZM7.9502 20V21H7.0498V20H7.9502Z" fill="currentColor"></path><path d="M2 16.05C2 16.0224 2.02239 16 2.05 16H2.95C2.97761 16 3 16.0224 3 16.05V16.95C3 16.9776 2.97761 17 2.95 17H2.05C2.02239 17 2 16.9776 2 16.95V16.05Z" fill="currentColor"></path><path d="M2.00391 16.9697C2.01152 16.9875 2.02926 16.9999 2.0498 17H2.9502L2.96973 16.9961C2.98152 16.991 2.99104 16.9815 2.99609 16.9697L3 16.9502V16.0498C2.99992 16.0293 2.9875 16.0115 2.96973 16.0039L2.9502 16V15C3.52994 15.0001 3.99989 15.4701 4 16.0498V16.9502C3.99989 17.5299 3.52994 17.9999 2.9502 18H2.0498C1.47006 17.9999 1.00011 17.5299 1 16.9502V16.0498C1.00011 15.4701 1.47006 15.0001 2.0498 15V16C2.02235 16.0001 2.00011 16.0223 2 16.0498V16.9502L2.00391 16.9697ZM2.9502 15V16H2.0498V15H2.9502Z" fill="currentColor"></path><path d="M2 7.05C2 7.02239 2.02239 7 2.05 7H2.95C2.97761 7 3 7.02239 3 7.05V7.95C3 7.97761 2.97761 8 2.95 8H2.05C2.02239 8 2 7.97761 2 7.95V7.05Z" fill="currentColor"></path><path d="M2.00391 7.96973C2.01152 7.9875 2.02926 7.99992 2.0498 8H2.9502L2.96973 7.99609C2.98152 7.99104 2.99104 7.98152 2.99609 7.96973L3 7.9502V7.0498C2.99992 7.02926 2.9875 7.01152 2.96973 7.00391L2.9502 7V6C3.52994 6.00011 3.99989 6.47006 4 7.0498V7.9502C3.99989 8.52994 3.52994 8.99989 2.9502 9H2.0498C1.47006 8.99989 1.00011 8.52994 1 7.9502V7.0498C1.00011 6.47006 1.47006 6.00011 2.0498 6V7C2.02235 7.00011 2.00011 7.02235 2 7.0498V7.9502L2.00391 7.96973ZM2.9502 6V7H2.0498V6H2.9502Z" fill="currentColor"></path><path d="M16 2.05C16 2.02239 16.0224 2 16.05 2H16.95C16.9776 2 17 2.02239 17 2.05V2.95C17 2.97761 16.9776 3 16.95 3H16.05C16.0224 3 16 2.97761 16 2.95V2.05Z" fill="currentColor"></path><path d="M16.0039 2.96973C16.0115 2.9875 16.0293 2.99992 16.0498 3H16.9502L16.9697 2.99609C16.9815 2.99104 16.991 2.98152 16.9961 2.96973L17 2.9502V2.0498C16.9999 2.02926 16.9875 2.01152 16.9697 2.00391L16.9502 2V1C17.5299 1.00011 17.9999 1.47006 18 2.0498V2.9502C17.9999 3.52994 17.5299 3.99989 16.9502 4H16.0498C15.4701 3.99989 15.0001 3.52994 15 2.9502V2.0498C15.0001 1.47006 15.4701 1.00011 16.0498 1V2C16.0223 2.00011 16.0001 2.02235 16 2.0498V2.9502L16.0039 2.96973ZM16.9502 1V2H16.0498V1H16.9502Z" fill="currentColor"></path><path d="M16 21.05C16 21.0224 16.0224 21 16.05 21H16.95C16.9776 21 17 21.0224 17 21.05V21.95C17 21.9776 16.9776 22 16.95 22H16.05C16.0224 22 16 21.9776 16 21.95V21.05Z" fill="currentColor"></path><path d="M16.0039 21.9697C16.0115 21.9875 16.0293 21.9999 16.0498 22H16.9502L16.9697 21.9961C16.9815 21.991 16.991 21.9815 16.9961 21.9697L17 21.9502V21.0498C16.9999 21.0293 16.9875 21.0115 16.9697 21.0039L16.9502 21V20C17.5299 20.0001 17.9999 20.4701 18 21.0498V21.9502C17.9999 22.5299 17.5299 22.9999 16.9502 23H16.0498C15.4701 22.9999 15.0001 22.5299 15 21.9502V21.0498C15.0001 20.4701 15.4701 20.0001 16.0498 20V21C16.0223 21.0001 16.0001 21.0223 16 21.0498V21.9502L16.0039 21.9697ZM16.9502 20V21H16.0498V20H16.9502Z" fill="currentColor"></path><path d="M21 16.05C21 16.0224 21.0224 16 21.05 16H21.95C21.9776 16 22 16.0224 22 16.05V16.95C22 16.9776 21.9776 17 21.95 17H21.05C21.0224 17 21 16.9776 21 16.95V16.05Z" fill="currentColor"></path><path d="M21.0039 16.9697C21.0115 16.9875 21.0293 16.9999 21.0498 17H21.9502L21.9697 16.9961C21.9815 16.991 21.991 16.9815 21.9961 16.9697L22 16.9502V16.0498C21.9999 16.0293 21.9875 16.0115 21.9697 16.0039L21.9502 16V15C22.5299 15.0001 22.9999 15.4701 23 16.0498V16.9502C22.9999 17.5299 22.5299 17.9999 21.9502 18H21.0498C20.4701 17.9999 20.0001 17.5299 20 16.9502V16.0498C20.0001 15.4701 20.4701 15.0001 21.0498 15V16C21.0223 16.0001 21.0001 16.0223 21 16.0498V16.9502L21.0039 16.9697ZM21.9502 15V16H21.0498V15H21.9502Z" fill="currentColor"></path><path d="M21 7.05C21 7.02239 21.0224 7 21.05 7H21.95C21.9776 7 22 7.02239 22 7.05V7.95C22 7.97761 21.9776 8 21.95 8H21.05C21.0224 8 21 7.97761 21 7.95V7.05Z" fill="currentColor"></path><path d="M21.0039 7.96973C21.0115 7.9875 21.0293 7.99992 21.0498 8H21.9502L21.9697 7.99609C21.9815 7.99104 21.991 7.98152 21.9961 7.96973L22 7.9502V7.0498C21.9999 7.02926 21.9875 7.01152 21.9697 7.00391L21.9502 7V6C22.5299 6.00011 22.9999 6.47006 23 7.0498V7.9502C22.9999 8.52994 22.5299 8.99989 21.9502 9H21.0498C20.4701 8.99989 20.0001 8.52994 20 7.9502V7.0498C20.0001 6.47006 20.4701 6.00011 21.0498 6V7C21.0223 7.00011 21.0001 7.02235 21 7.0498V7.9502L21.0039 7.96973ZM21.9502 6V7H21.0498V6H21.9502Z" fill="currentColor"></path><path d="M16.75 11.134C17.1642 11.134 17.5 11.4698 17.5 11.884C17.5 12.2982 17.1642 12.634 16.75 12.634H7.5C7.08579 12.634 6.75 12.2982 6.75 11.884C6.75 11.4698 7.08579 11.134 7.5 11.134H16.75Z" fill="currentColor"></path><path d="M6.99412 11.3304C7.29978 11.0512 7.77423 11.0727 8.05369 11.3783C8.33294 11.6839 8.31137 12.1584 8.00584 12.4378L3.50584 16.5531C3.20019 16.8326 2.72583 16.8118 2.44627 16.5062C2.16689 16.2005 2.18854 15.7261 2.49412 15.4466L6.99412 11.3304Z" fill="currentColor"></path><path d="M2.43261 7.50976C2.7033 7.19647 3.17676 7.16205 3.49023 7.43261L7.99023 11.3164C8.30363 11.5871 8.33797 12.0605 8.06738 12.374C7.79673 12.6874 7.32327 12.7227 7.00976 12.4521L2.50976 8.56738C2.19647 8.29669 2.16205 7.82323 2.43261 7.50976Z" fill="currentColor"></path><path d="M16.3624 11.3436C16.6559 11.0514 17.1307 11.0522 17.423 11.3456L21.5314 15.4706C21.8236 15.764 21.8227 16.2388 21.5294 16.5311C21.236 16.8234 20.7612 16.8225 20.4689 16.5292L16.3605 12.4042C16.0682 12.1107 16.0691 11.6359 16.3624 11.3436Z" fill="currentColor"></path><path d="M20.4855 7.45404C20.7868 7.17014 21.2609 7.1843 21.5451 7.48529C21.8293 7.78661 21.8161 8.26162 21.5148 8.54584L17.4064 12.4208C17.1051 12.7049 16.63 12.6909 16.3459 12.3896C16.0618 12.0883 16.0758 11.6132 16.3771 11.329L20.4855 7.45404Z" fill="currentColor"></path><path d="M11.4697 16.1037C11.7626 15.8108 12.2374 15.8108 12.5303 16.1037L16.5303 20.1037C16.8232 20.3966 16.8232 20.8714 16.5303 21.1642C16.2374 21.4571 15.7626 21.4571 15.4697 21.1642L11.4697 17.1643C11.1768 16.8714 11.1768 16.3966 11.4697 16.1037Z" fill="currentColor"></path><path d="M11.4531 16.1213C11.7364 15.8191 12.2105 15.8038 12.5127 16.0871C12.8149 16.3704 12.8301 16.8445 12.5469 17.1467L8.79685 21.1467C8.51355 21.4489 8.03947 21.4642 7.73728 21.1809C7.4351 20.8976 7.4198 20.4235 7.7031 20.1213L11.4531 16.1213Z" fill="currentColor"></path><path d="M15.5907 2.59462C15.8836 2.30189 16.3584 2.3017 16.6512 2.59462C16.9438 2.88748 16.9438 3.36235 16.6512 3.65517L12.6658 7.63857C12.373 7.93132 11.8981 7.9313 11.6053 7.63857C11.3125 7.34569 11.3126 6.87087 11.6053 6.57802L15.5907 2.59462Z" fill="currentColor"></path><path d="M7.62207 2.59467C7.91497 2.30178 8.38973 2.30178 8.68262 2.59467L12.666 6.57807C12.9587 6.87098 12.9588 7.34579 12.666 7.63862C12.3732 7.93144 11.8984 7.93129 11.6055 7.63862L7.62207 3.65522C7.32918 3.36232 7.32918 2.88756 7.62207 2.59467Z" fill="currentColor"></path></svg>',
    chat:   '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 18 18" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 1.6875C4.64918 1.6875 4.79222 1.74681 4.89771 1.85229L13.5227 10.4773C13.7424 10.697 13.7424 11.053 13.5227 11.2727C13.303 11.4924 12.947 11.4924 12.7273 11.2727L4.26709 2.8125H2.8125V4.26709L11.2727 12.7273C11.4924 12.947 11.4924 13.303 11.2727 13.5227C11.053 13.7424 10.697 13.7424 10.4773 13.5227L1.85229 4.89771C1.74681 4.79222 1.6875 4.64918 1.6875 4.5V2.25C1.6875 1.93934 1.93934 1.6875 2.25 1.6875H4.5Z" fill="currentColor"></path><path d="M13.8523 9.35225C14.072 9.13258 14.428 9.13258 14.6477 9.35225C14.8674 9.57192 14.8674 9.92799 14.6477 10.1477L10.1477 14.6477C9.92802 14.8673 9.57195 14.8673 9.35228 14.6477C9.13261 14.428 9.13261 14.0719 9.35228 13.8523L13.8523 9.35225Z" fill="currentColor"></path><path d="M11.6023 11.6023C11.822 11.3826 12.178 11.3826 12.3977 11.6023L15.3977 14.6023C15.6174 14.8219 15.6174 15.178 15.3977 15.3977C15.178 15.6173 14.822 15.6173 14.6023 15.3977L11.6023 12.3977C11.3826 12.178 11.3826 11.8219 11.6023 11.6023Z" fill="currentColor"></path><path d="M15.3523 13.8523C15.572 13.6326 15.928 13.6326 16.1477 13.8523C16.3674 14.0719 16.3674 14.428 16.1477 14.6477L14.6477 16.1477C14.428 16.3673 14.072 16.3673 13.8523 16.1477C13.6326 15.928 13.6326 15.5719 13.8523 15.3523L15.3523 13.8523Z" fill="currentColor"></path><path d="M15.75 1.6875C16.0606 1.6875 16.3125 1.93934 16.3125 2.25V4.5C16.3125 4.64918 16.2532 4.79222 16.1477 4.89771L13.5227 7.52271C13.303 7.74237 12.947 7.74237 12.7273 7.52271C12.5076 7.30303 12.5076 6.94697 12.7273 6.72729L15.1875 4.26709V2.8125H13.7329L11.2727 5.27271C11.053 5.49237 10.697 5.49237 10.4773 5.27271C10.2576 5.05304 10.2576 4.69696 10.4773 4.47729L13.1023 1.85229L13.188 1.78198C13.2797 1.72083 13.3881 1.6875 13.5 1.6875H15.75Z" fill="currentColor"></path><path d="M4.10228 10.1023C4.32195 9.88258 4.67802 9.88258 4.89769 10.1023L7.89769 13.1023C8.11736 13.3219 8.11736 13.678 7.89769 13.8977C7.67802 14.1173 7.32195 14.1173 7.10228 13.8977L4.10228 10.8977C3.88261 10.678 3.88261 10.3219 4.10228 10.1023Z" fill="currentColor"></path><path d="M5.60228 11.6023C5.82195 11.3826 6.17802 11.3826 6.39769 11.6023C6.61736 11.8219 6.61736 12.178 6.39769 12.3977L3.39769 15.3977C3.17802 15.6173 2.82195 15.6173 2.60228 15.3977C2.38261 15.178 2.38261 14.8219 2.60228 14.6023L5.60228 11.6023Z" fill="currentColor"></path><path d="M1.85228 13.8523C2.07195 13.6326 2.42802 13.6326 2.64769 13.8523L4.14769 15.3523C4.36736 15.5719 4.36736 15.928 4.14769 16.1477C3.92802 16.3673 3.57195 16.3673 3.35228 16.1477L1.85228 14.6477C1.63261 14.428 1.63261 14.0719 1.85228 13.8523Z" fill="currentColor"></path></svg>',
    webdev: '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 24 24" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 6L10 18.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M6.5 8.5L3 12L6.5 15.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M17.5 8.5L21 12L17.5 15.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    image:  '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 24 24" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M3 16L10 13L21 18" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M16 10C14.8954 10 14 9.10457 14 8C14 6.89543 14.8954 6 16 6C17.1046 6 18 6.89543 18 8C18 9.10457 17.1046 10 16 10Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    video:  '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 24 24" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path><path d="M9.89768 8.51296C9.49769 8.28439 9 8.57321 9 9.03391V14.9661C9 15.4268 9.49769 15.7156 9.89768 15.487L15.0883 12.5209C15.4914 12.2906 15.4914 11.7094 15.0883 11.4791L9.89768 8.51296Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    _default: '<svg width="1.5em" height="1.5em" stroke-width="1.5" viewBox="0 0 24 24" fill="none" class="text-interactive-normal size-3.5" xmlns="http://www.w3.org/2000/svg"><path d="M21 12a8 8 0 1 1-3-6.2L21 5l-1 3.4A8 8 0 0 1 21 12z" stroke="currentColor" stroke-linejoin="round"></path></svg>',
  };

  function iconChipFor(rec) {
    const key = (rec.modality && CHAT_ICONS[rec.modality]) ? rec.modality
      : (rec.kind === 'agent') ? 'agent'
      : '_default';
    return `<div class="${SITE_CLASSES.chip}" data-cv-icon="${key}">${CHAT_ICONS[key]}</div>`;
  }

  // ================================ STATE ===================================
  const VIEWS = [
    { id: 'folders', label: 'Custom folders' },
    { id: 'time',    label: 'Last activity' },
    { id: 'month',   label: 'Month' },
    { id: 'type',    label: 'Arena type' },
    { id: 'native',  label: 'Native (original)' },
  ];

  // Label of the bottom row. "Configure sidebar" or "Sidebar config" — pick one.
  const FOOTER_LABEL = 'Configure sidebar';

  const state = {
    view: 'time',             // VIEWS[].id                     (persisted)
    lastCustomView: 'folders',// last non-native view           (persisted)
    groups: [],               // [{ id, name, collapsed }]      (persisted, ordered)
    assign: {},               // chatUrlKey -> groupId          (persisted)
    rules: [],                // [{ group, pattern }]           (persisted)
    seen: {},                 // chatUrlKey -> { title, bucket, ts,          (persisted)
                              //                  created?, updated?, id?,
                              //                  kind?, modality?, mode?, ph? }
    inboxCollapsed: false,    //                                (persisted)
    opts: { bgSync: true, rules: true }, // feature toggles      (persisted)
    lastApiSync: 0,           // ms epoch of last API sync      (persisted)
  };

  let lastActiveKey = null;   // chat currently open (from data-active)
  let lastSig = '';           // change-detection signature of the live list
  let syncing = false;        // true while a full sync (api or sweep) is running
  let bgSyncStarted = false;  // true while the background boot sync is running
  let dragKey = null;

  function save() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
        v: 2,
        view: state.view,
        lastCustomView: state.lastCustomView,
        groups: state.groups,
        assign: state.assign,
        rules: state.rules,
        seen: state.seen,
        inboxCollapsed: state.inboxCollapsed,
        opts: state.opts,
        lastApiSync: state.lastApiSync,
      }));
    } catch (e) { warn('could not save state', e); }
  }

  function loadState() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || 'null'); } catch (e) { /* ignore */ }
    const validViews = VIEWS.map((v) => v.id);
    if (d && validViews.includes(d.view)) state.view = d.view;
    else if (d && d.mode === 'grouped') state.view = 'folders'; // pre-0.6 migration
    else if (d) state.view = 'time';                            // pre-0.6 stock users
    else state.view = CONFIG.DEFAULT_VIEW;
    if (d && validViews.includes(d.lastCustomView) && d.lastCustomView !== 'native') {
      state.lastCustomView = d.lastCustomView;
    } else {
      state.lastCustomView = state.view !== 'native' ? state.view : 'folders';
    }
    state.groups  = d && Array.isArray(d.groups)  ? d.groups.filter(g => g && g.id && g.name) : [];
    state.assign  = d && d.assign && typeof d.assign === 'object' ? d.assign : {};
    state.rules   = d && Array.isArray(d.rules)   ? d.rules : CONFIG.DEFAULT_RULES.slice();
    state.seen    = d && d.seen && typeof d.seen === 'object' ? d.seen : {};
    state.inboxCollapsed = !!(d && d.inboxCollapsed);
    state.opts    = (d && d.opts && typeof d.opts === 'object')
      ? { bgSync: d.opts.bgSync !== false, rules: d.opts.rules !== false }
      : { bgSync: true, rules: true };
    state.lastApiSync = d && Number(d.lastApiSync) || 0;
  }

  // ============================ EXTRACTION ==================================
  // Read all conversation rows currently present in the stock sidebar.
  // IMPORTANT: only direct-children stock groups are scanned — the custom
  // panel renders the same li/a structure and lives in the same content div,
  // so an unscoped query would feed the panel's own rows back into the
  // registry (title/bucket feedback loop, re-key ghosting).
  function extractConversations() {
    const out = new Map();
    const content = document.querySelector(SEL.content);
    if (!content) return out;
    const stockGroups = [...content.children].filter((el) => el.matches(SEL.stockGroup));
    for (const grp of stockGroups) {
      const bucket = (grp.querySelector(SEL.groupLabel)?.textContent || '').trim();
      for (const li of grp.querySelectorAll(SEL.item)) {
        const a = li.querySelector(SEL.itemLink);
        if (!a) continue;
        const key = a.getAttribute('href');
        if (!key || key === '#') continue; // skip non-links
        const titleSpan = a.querySelector('span');
        const title = ((titleSpan ? titleSpan.textContent : a.textContent) || '').trim() || 'Untitled';
        const active = a.getAttribute('data-active') === 'true';
        out.set(key, { key, title, bucket, active });
      }
    }
    return out;
  }

  function findRecordByChatId(id) {
    if (!id) return null;
    for (const [k, r] of Object.entries(state.seen)) {
      if (r.id === id) return { key: k, rec: r };
    }
    return null;
  }

  function recordTs(rec) { return rec.updated || rec.ts || 0; }

  // Merge live extraction into the registry. Returns true if anything about
  // the visible list changed (used to avoid pointless re-renders).
  function syncState(convs) {
    const now = Date.now();
    for (const [key, c] of convs) {
      let rec = state.seen[key];
      if (!rec) {
        // Self-heal: if we registered this chat from the API under a guessed
        // href that turns out to be wrong, re-key the record (and any group
        // assignment) to the href the site actually uses.
        const guessId = key.slice(key.lastIndexOf('/') + 1);
        const hit = findRecordByChatId(guessId);
        if (hit && hit.key !== key) {
          rec = state.seen[key] = hit.rec;
          delete state.seen[hit.key];
          if (state.assign[hit.key]) {
            state.assign[key] = state.assign[hit.key];
            delete state.assign[hit.key];
          }
          log('re-keyed', hit.key, '->', key);
        }
      }
      if (rec) {
        rec.title = c.title;
        if (c.bucket) rec.bucket = c.bucket;
        rec.ts = now;
        rec.ph = false; // real sidebar link seen -> no longer a placeholder
      } else {
        // Brand new chat: try the auto-sort rules once, then leave it alone.
        const targetGroup = ruleTarget(c.title, key);
        const nr = { title: c.title, bucket: c.bucket || '', ts: now };
        const modality = inferModality(key);      // evaluation section route?
        if (modality) nr.modality = modality;
        else if (/^\/agent\//.test(key)) nr.kind = 'agent';
        // (under /c/<id> we can't tell agent vs evaluation until the API joins)
        state.seen[key] = nr;
        if (targetGroup) state.assign[key] = groupByName(targetGroup).id;
        log('new chat registered:', c.title);
      }
      if (c.active) lastActiveKey = key;
    }
    const sig = convs.size + '|' + (lastActiveKey || '') + '|' +
      [...convs.values()].map((c) => c.key + '\u0002' + c.title + (c.active ? '!' : '')).join('\u0001');
    const changed = sig !== lastSig;
    lastSig = sig;
    return changed;
  }

  // ================================ RULES ===================================
  function matchPattern(pattern, s) {
    if (!pattern) return false;
    if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
      try { return new RegExp(pattern.slice(1, -1), 'i').test(s); } catch (e) { /* fall through */ }
    }
    return s.toLowerCase().includes(pattern.toLowerCase());
  }

  function ruleTarget(title, href) {
    if (!state.opts.rules) return null; // global feature toggle
    for (const r of state.rules) {
      if (matchPattern(r.pattern, title) || matchPattern(r.pattern, href)) return r.group;
    }
    return null;
  }

  function groupByName(name) {
    let g = state.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (!g) { g = { id: uid(), name, collapsed: false }; state.groups.push(g); }
    return g;
  }

  function createGroup(name) {
    const g = groupByName(String(name || '').trim() || 'New group');
    save();
    return g;
  }

  function assignTo(key, groupId) {
    if (!state.seen[key]) return;
    if (groupId === INBOX) delete state.assign[key];
    else state.assign[key] = groupId;
  }

  // ============================ HISTORY API =================================
  // Uses the site's own /api/history/unified endpoint (the one its Search
  // page calls). Same-origin fetch => session cookies are sent automatically.

  function fetchApiPage(cursor) {
    // URL builder per the API survey: the cursor contains a literal '+' in
    // timestamps; searchParams encodes it correctly (a raw paste would break).
    const url = new URL(CONFIG.API_PATH, location.origin);
    for (const [k, v] of Object.entries(CONFIG.API_PARAMS)) url.searchParams.set(k, v);
    if (cursor) url.searchParams.set('cursor', cursor);
    log('GET', url.toString());
    return fetch(url.toString(), {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    }).then(async (res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!j || !Array.isArray(j.entries)) throw new Error('unexpected payload shape');
      return j;
    });
  }

  // Merge one API entry (agentic OR evaluation) into the registry.
  // Returns true if something changed.
  function ingestApiEntry(e) {
    if (!e || !e.id) return false;
    const id = String(e.id);
    const isEval = e.type === 'evaluation';
    const title = (e.title || '').trim() || 'Untitled';
    const updated = parseTs(e.updatedAt) || parseTs(e.createdAt);
    const created = parseTs(e.createdAt) || updated;
    const kind = isEval ? (e.mode || 'evaluation') : 'agent';

    // Join by stored chat id first, then by href suffix (covers records the
    // DOM registered under the real — possibly different — route prefix).
    let rec = null;
    for (const r of Object.values(state.seen)) {
      if (r.id === id) { rec = r; break; }
    }
    if (!rec) {
      for (const [k, r] of Object.entries(state.seen)) {
        if (k.endsWith('/' + id)) { rec = r; break; }
      }
    }
    const bucket = bucketFromDate(updated);
    if (rec) {
      let mut = false;
      if (title !== 'Untitled' && rec.title !== title) { rec.title = title; mut = true; }
      if (updated && rec.updated !== updated) { rec.updated = updated; mut = true; }
      if (created && !rec.created) { rec.created = created; mut = true; }
      if (!rec.id) { rec.id = id; mut = true; }
      if (bucket && !rec.bucket) { rec.bucket = bucket; mut = true; }
      if (rec.kind !== kind) { rec.kind = kind; mut = true; }
      if (isEval) {
        if (e.mode && rec.mode !== e.mode) { rec.mode = e.mode; mut = true; }
        if (e.modality && rec.modality !== e.modality) { rec.modality = e.modality; mut = true; }
      }
      rec.ts = Date.now();
      return mut;
    }
    // Chat known only from the API so far: register under the guessed href.
    const key = (isEval ? CONFIG.API_HREF_OTHER : CONFIG.API_HREF_AGENTIC) + id;
    if (state.seen[key]) return false;
    rec = { title, bucket, ts: Date.now(), created, updated, id, kind, ph: true };
    if (isEval) { rec.mode = e.mode || ''; rec.modality = e.modality || ''; }
    state.seen[key] = rec;
    const target = ruleTarget(title, key);
    if (target) state.assign[key] = groupByName(target).id;
    log('api: registered', title);
    return true;
  }

  // Walk all pages. Throws on any failure — caller decides on fallback.
  async function syncFromApi() {
    if (typeof fetch !== 'function') throw new Error('fetch unavailable');
    let cursor = null, pages = 0, entries = 0, changed = 0;
    for (;;) {
      const page = await fetchApiPage(cursor);
      for (const e of page.entries) { entries++; if (ingestApiEntry(e)) changed++; }
      pages++;
      const more = page.pagination && page.pagination.hasMore && page.pagination.cursor;
      if (!more || pages >= CONFIG.API_MAX_PAGES) break;
      cursor = page.pagination.cursor;
      await sleep(CONFIG.API_PAGE_DELAY);
    }
    state.lastApiSync = Date.now();
    save();
    log(`api sync done: ${pages} page(s), ${entries} entries, ${changed} new/changed`);
    return { pages, entries, changed };
  }

  // Manual sync (flyout entry): API first, scroll sweep as fallback.
  async function syncNow() {
    if (syncing) return;
    syncing = true;
    try {
      const { changed } = await syncFromApi();
      if (changed) renderPanel();
    } catch (err) {
      warn('API sync failed, falling back to scroll sweep:', err);
      syncing = false;
      await syncAllHistory();
      return;
    }
    syncing = false;
  }

  // Background sync at boot, throttled; silent (no UI chrome).
  async function maybeBackgroundSync() {
    if (!state.opts.bgSync) return;             // feature toggle
    if (bgSyncStarted || syncing) return;
    if (Date.now() - (state.lastApiSync || 0) < CONFIG.SYNC_THROTTLE) return;
    if (typeof fetch !== 'function') return;
    bgSyncStarted = true;
    try {
      const { changed } = await syncFromApi();
      if (changed && state.view !== 'native') renderPanel();
    } catch (err) {
      log('background api sync failed (will retry next boot):', err);
    } finally {
      bgSyncStarted = false;
    }
  }

  // =============================== STYLES ===================================
  // Only layout & concepts the site's library doesn't cover. Theming comes
  // from the site's own utility classes (see SITE_CLASSES).
  function injectStyles() {
    if (document.getElementById('cv-style')) return;
    const st = document.createElement('style');
    st.id = 'cv-style';
    st.textContent = `
/* ---------- view switching ---------- */
[data-cv-panel]{ display:none; }
div[data-sidebar="sidebar"]:not([data-cv-view="native"]) [data-cv-panel]{
  display:flex;
}
div[data-sidebar="sidebar"]:not([data-cv-view="native"])
  div[data-sidebar="content"] > div[data-sidebar="group"]{
  display:none !important;
}

/* ---------- panel (list) ---------- */
[data-cv-panel]{
  flex-direction:column; min-height:0; height:100%;
  padding:4px 0 0;
  font-size:13px; line-height:1.35; color:inherit;
}
/* No horizontal padding on the scroller (like the native list): the scrollbar
   sits flush against the sidebar edge. Spacing comes from the groups. */
.cv-list{ flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
[data-cv-frow]{ cursor:pointer; }

/* ---------- groups ---------- */
.cv-group{ margin:1px 8px 2px; border-radius:8px; }
.cv-group[data-cv-dragover]{
  outline:1.5px dashed color-mix(in srgb, currentColor 45%, transparent);
  outline-offset:-2px; background:color-mix(in srgb, currentColor 6%, transparent);
}
.cv-group-label{
  display:flex; align-items:center; gap:6px;
  padding:5px 8px; border-radius:8px;
  font-size:12px; font-weight:500; opacity:.75;
}
.cv-group-label[data-act]{ cursor:pointer; user-select:none; }
.cv-group-label[data-act]:hover{ background:color-mix(in srgb, currentColor 7%, transparent); opacity:1; }
.cv-chevron{ flex:none; transition:transform .15s ease; opacity:.7; }
.cv-group[data-collapsed="true"] .cv-chevron{ transform:rotate(-90deg); }
.cv-group[data-collapsed="true"] [data-sidebar="group-content"]{ display:none; }
.cv-count{ margin-left:auto; font-weight:400; opacity:.6; }
.cv-empty{ padding:4px 8px 6px; font-size:11.5px; opacity:.45; font-style:italic; }
.cv-item [data-cv-icon]{ display:inline-flex; align-items:center; justify-content:center; flex:none; }

/* ---------- cv shells (layout only; theming = site classes) ---------- */
[data-cv-flyout]{ position:fixed; z-index:2147483000; }
.cv-overlay{
  position:fixed; inset:0; z-index:2147483001;
  background:rgba(0,0,0,.45);
  display:grid; place-items:center; padding:20px;
}
.cv-modal{ width:min(540px, 94vw); max-height:85vh; overflow:auto; }
.cv-modal-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:12px 16px; border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent);
  position:sticky; top:0; background:inherit;
}
.cv-modal-body{ padding:12px 16px 16px; display:flex; flex-direction:column; gap:8px; }
.cv-field-label{ font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; opacity:.55; margin-top:6px; }
.cv-row{ display:flex; gap:4px; align-items:center; margin-bottom:4px; }
.cv-input{ flex:1; min-width:0; }
.cv-rules, .cv-io{ width:100%; box-sizing:border-box; resize:vertical; }
.cv-mini{
  width:26px; height:26px; padding:0; flex:none;
  display:inline-flex; align-items:center; justify-content:center;
}
.cv-hint{ font-size:11.5px; opacity:.55; }
.cv-hint code{ opacity:1; }
.cv-check{ display:flex; gap:8px; align-items:center; cursor:pointer; }
`;
    (document.head || document.documentElement).appendChild(st);
  }

  // ============================== GROUP BUILDING ============================
  function folderGroups() {
    const out = state.groups.map((g) => ({
      id: g.id, label: g.name, collapsible: true, drop: true,
      collapsed: !!g.collapsed,
      items: itemsAssignedTo(g.id),
    }));
    out.push({
      id: INBOX, label: 'Unsorted', collapsible: true, drop: true,
      collapsed: state.inboxCollapsed,
      items: itemsAssignedTo(INBOX),
    });
    return out;
  }

  function itemsAssignedTo(groupId) {
    return Object.entries(state.seen)
      .filter(([k]) => (state.assign[k] || INBOX) === groupId)
      .sort((a, b) => recordTs(b[1]) - recordTs(a[1]))
      .map(([k, v]) => itemOf(k, v));
  }

  function itemOf(key, v) {
    return { key, title: v.title, kind: v.kind || '', modality: v.modality || '' };
  }

  function timeGroups() {
    const order = ['Today', 'Yesterday', 'Older'];
    const buckets = new Map(order.map((b) => [b, []]));
    for (const [k, v] of Object.entries(state.seen)) {
      // The stock label (captured from the native list) is the truth when we
      // have it; compute from timestamps only for chats the DOM never showed.
      const b = v.bucket || bucketFromDate(recordTs(v)) || 'Older';
      (buckets.get(b) || buckets.get('Older')).push(itemOf(k, v));
    }
    return order
      .filter((b) => buckets.get(b).length)
      .map((b) => ({ id: 'time:' + b, label: b, collapsible: false, drop: false, items: buckets.get(b) }));
  }

  function monthGroups() {
    const buckets = new Map();
    for (const [k, v] of Object.entries(state.seen)) {
      const label = monthLabelFrom(recordTs(v));
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(itemOf(k, v));
    }
    return [...buckets.entries()]
      .sort((a, b) => (a[0] === 'Undated' ? 1 : b[0] === 'Undated' ? -1 : b[0] < a[0] ? -1 : 1))
      .map(([label, items]) => ({ id: 'month:' + label, label, collapsible: true, drop: false, items }));
  }

  const TYPE_ORDER = ['agent', 'battle', 'side-by-side', 'direct', 'direct-battle'];
  const TYPE_LABEL = {
    agent: 'Agent', battle: 'Battle', 'side-by-side': 'Side-by-Side',
    direct: 'Direct', 'direct-battle': 'Direct Battle', other: 'Other',
  };

  function typeGroups() {
    const buckets = new Map();
    for (const [k, v] of Object.entries(state.seen)) {
      const t = TYPE_ORDER.includes(v.kind) ? v.kind : 'other';
      if (!buckets.has(t)) buckets.set(t, []);
      buckets.get(t).push(itemOf(k, v));
    }
    return [...buckets.entries()]
      .sort((a, b) => {
        const ia = TYPE_ORDER.indexOf(a[0]), ib = TYPE_ORDER.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([t, items]) => ({ id: 'type:' + t, label: TYPE_LABEL[t] || t, collapsible: false, drop: false, items }));
  }

  function buildGroups(view) {
    if (view === 'folders') return folderGroups();
    if (view === 'time') return timeGroups();
    if (view === 'month') return monthGroups();
    if (view === 'type') return typeGroups();
    return [];
  }

  // ================================ PANEL ===================================
  // Structure mirrors the stock sidebar: groups with data-sidebar="group" /
  // "group-label" / "group-content", rows as li[data-sidebar="menu-item"] with
  // a[data-sidebar="menu-button"]. Footer row = data-sidebar="footer".
  let panelRoot = null, panelList = null;

  function buildPanel() {
    const p = document.createElement('div');
    p.setAttribute('data-cv-panel', '');
    p.innerHTML = `<div class="cv-list"></div>`;
    panelList = p.querySelector('.cv-list');
    wirePanelEvents(p);
    return p;
  }

  function ensurePanelMounted() {
    const content = document.querySelector(SEL.content);
    if (!content || !panelRoot) return;
    if (panelRoot.parentNode !== content) content.appendChild(panelRoot);
    applyViewAttr(); // change-gated; no-op when the attribute is intact
  }

  function applyViewAttr() {
    const sidebar = document.querySelector(SEL.sidebar);
    // Change-gated write: re-setting the same attribute would re-trigger our
    // own MutationObserver and cause a perpetual 200ms rescan loop.
    if (sidebar && sidebar.getAttribute('data-cv-view') !== state.view) {
      sidebar.setAttribute('data-cv-view', state.view);
    }
  }

  function setView(v) {
    if (!VIEWS.some((x) => x.id === v)) return;
    state.view = v;
    if (v !== 'native') state.lastCustomView = v;
    save();
    applyViewAttr();
    syncState(extractConversations());
    renderPanel(); // also clears the custom list when entering native view
  }

  function rowHtml(it, draggable) {
    // draggable lives on the <li>, NOT the <a>: dragging the row still works
    // (draggability covers the subtree), but the anchor stays a pristine
    // native link — draggable anchors are known to eat plain clicks in some
    // browsers.
    return `
      <li data-sidebar="menu-item" title="${escHtml(it.title)}" ${draggable ? ' draggable="true"' : ''}>
        <a data-cv-item class="${escAttr(SITE_CLASSES.menuButton)}"
           data-sidebar="menu-button" data-size="default"
           data-active="${it.key === lastActiveKey}"
           data-key="${escAttr(it.key)}" href="${escAttr(it.key)}">
          ${iconChipFor(it)}
          <span class="${escAttr(SITE_CLASSES.title)}">${escHtml(it.title)}</span>
        </a>
      </li>`;
  }

  function groupHtml(g) {
    const rows = g.items.map((it) => rowHtml(it, g.drop)).join('') ||
      (g.drop ? `<li><div class="cv-empty">${
        g.id === INBOX
          ? 'New chats land here — drag them into a folder.'
          : 'Empty — drop chats here, or use the “…” menu → “Move to…”.'
      }</div></li>` : '');
    return `
      <div data-sidebar="group" class="cv-group" data-cv-group="${escAttr(g.id)}"
        ${g.drop ? `data-cv-drop="${escAttr(g.id)}"` : ''}
        data-collapsed="${g.collapsed}">
        <div data-sidebar="group-label" class="cv-group-label"
          ${g.collapsible ? 'data-act="collapse" title="Click to collapse / expand — drag chats here to file them"' : ''}>
          ${g.collapsible ? ICON.chevron : ''}
          <span class="${escAttr(SITE_CLASSES.groupLabel)}">${escHtml(g.label)}</span>
          ${g.collapsible ? `<span class="cv-count">${g.items.length}</span>` : ''}
        </div>
        <div data-sidebar="group-content"><ul data-sidebar="menu">${rows}</ul></div>
      </div>`;
  }

  function renderPanel() {
    if (!panelList) return;
    if (state.view === 'native') { panelList.innerHTML = ''; return; }
    panelList.innerHTML = buildGroups(state.view).map(groupHtml).join('');
  }

  // ------------------------- panel event wiring ------------------------------
  function wirePanelEvents(p) {
    // Plain row clicks: capture phase, so site-delegated handlers (which may
    // preventDefault on ancestors) can't beat us to it. Modifier clicks are
    // passed through untouched (browser opens new tab/window — native wins).
    p.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const item = e.target.closest('[data-cv-item]');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(item.dataset.key);
    }, true);

    p.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (actEl) {
        const act = actEl.dataset.act;
        if (act === 'collapse') {
          const sec = actEl.closest('.cv-group');
          const gid = sec && sec.dataset.cvGroup;
          if (gid === INBOX) state.inboxCollapsed = !state.inboxCollapsed;
          else {
            const g = state.groups.find((g) => g.id === gid);
            if (g) g.collapsed = !g.collapsed;
          }
          save(); renderPanel();
        }
        return;
      }
    });

    p.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('[data-cv-item]');
      if (!item) return;
      e.preventDefault();
      openMoveMenu(e.clientX, e.clientY, item.dataset.key);
    });

    p.addEventListener('dragstart', (e) => {
      const item = itemAnchorFromTarget(e.target); // target may be the <li>
      if (!item) return;
      dragKey = item.dataset.key;
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', dragKey);
        e.dataTransfer.effectAllowed = 'move';
      }
    });

    p.addEventListener('dragover', (e) => {
      const g = e.target.closest('[data-cv-drop]');
      if (!g || !dragKey) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      g.setAttribute('data-cv-dragover', '');
    });

    p.addEventListener('dragleave', (e) => {
      const g = e.target.closest('[data-cv-drop]');
      if (g && !g.contains(e.relatedTarget)) g.removeAttribute('data-cv-dragover');
    });

    p.addEventListener('drop', (e) => {
      const g = e.target.closest('[data-cv-drop]');
      if (!g) return;
      e.preventDefault();
      g.removeAttribute('data-cv-dragover');
      const key = dragKey || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      if (key && state.seen[key]) {
        assignTo(key, g.dataset.cvDrop);
        save(); renderPanel();
      }
      dragKey = null;
    });

    p.addEventListener('dragend', () => {
      dragKey = null;
      p.querySelectorAll('[data-cv-dragover]').forEach((el) => el.removeAttribute('data-cv-dragover'));
    });
  }

  // Row navigation. Plain clicks are handled in the CAPTURE phase (see
  // wirePanelEvents) so the site's delegated handlers can't swallow them;
  // modifier clicks (new tab/window) are left to the browser.
  //
  // Strategy: dispatch a real bubbling click on the site's own (hidden)
  // sidebar link — its router handles it like a user click. Routers call
  // pushState SYNCHRONOUSLY in the handler, so we can verify the navigation
  // actually happened before returning. If the site's router didn't take it
  // (link not in the DOM, exotic handling), we do a hard location.assign —
  // navigation can no longer fail silently.
  function navigate(key) {
    let stock = null;
    try {
      const content = document.querySelector(SEL.content);
      stock = content && content.querySelector(`a[href="${cssEsc(key)}"]`);
    } catch (e) { /* fall through to hard nav */ }
    if (stock) {
      try {
        const before = location.pathname + location.search + location.hash;
        const ev = new MouseEvent('click', {
          bubbles: true, cancelable: true, view: window, button: 0, detail: 1,
        });
        stock.dispatchEvent(ev);
        const after = location.pathname + location.search + location.hash;
        if (after !== before || ev.defaultPrevented) return; // router took it
        log('navigate: router ignored the click, falling back to hard nav');
      } catch (e) {
        warn('navigate: SPA dispatch failed, falling back to hard nav', e);
      }
    }
    // Chat not in the native list (API-only placeholder / lazy-loaded away)
    // or the router didn't react: full page load.
    location.assign(key);
  }

  // The deepest row anchor for an event target. Handles both direct hits
  // (target = anchor/span/svg) and drags started on the draggable <li>.
  function itemAnchorFromTarget(t) {
    return t.closest('[data-cv-item]') ||
      (t.querySelector ? t.querySelector('[data-cv-item]') : null);
  }

  // =========================== FOOTER ROW + FLYOUT ==========================
  // A Leaderboard-style nav row at the sidebar's bottom (data-sidebar="footer").
  // Hover/click opens a popover cloned from the site's own flyout anatomy:
  // top-level entries, then border-t separated sections with mono labels.

  let footerEl = null, footerRow = null, footerSep = null;
  let flyoutEl = null;
  let flyoutCloseTimer = null;
  let onDocDown = null, onEsc = null;

  function ensureFooterMounted() {
    const sidebar = document.querySelector(SEL.sidebar);
    const content = document.querySelector(SEL.content);
    if (!sidebar || !content) return;
    if (!footerEl) {
      // Structure mirrors the stock sidebar exactly (user-captured):
      //   separator directly after the content div, then a group wrapping the
      //   menu row — landing before the site's own footer.
      footerSep = document.createElement('div');
      footerSep.setAttribute('data-orientation', 'horizontal');
      footerSep.setAttribute('role', 'none');
      footerSep.setAttribute('data-sidebar', 'separator');
      footerSep.className = SITE_CLASSES.separator;

      footerEl = document.createElement('div');
      footerEl.setAttribute('data-sidebar', 'group');
      footerEl.className = SITE_CLASSES.footerGroup;
      footerEl.innerHTML = `
        <ul data-sidebar="menu" class="${escAttr(SITE_CLASSES.menuCol)}">
          <li data-sidebar="menu-item" class="${escAttr(SITE_CLASSES.menuItem)}">
            <a data-cv-frow class="${escAttr(SITE_CLASSES.navRow)}"
               data-sidebar="menu-button" data-size="default" data-active="false">
              ${ICON.gear}<span>${escHtml(FOOTER_LABEL)}</span>${svg('<path d="M9 6L15 12L9 18"/>', 24, SITE_CLASSES.navRowChevron)}
            </a>
          </li>
        </ul>`;
      footerRow = footerEl.querySelector('[data-cv-frow]');
      wireFooterEvents();
    }
    // Change-gated placement: separator right after the content div, our
    // group right after the separator — i.e. before the site's native footer
    // no matter where React currently parked it. Re-seats itself after
    // collapse/reopen rebuilds.
    if (footerSep.parentNode !== sidebar || footerEl.parentNode !== sidebar ||
        footerSep.previousElementSibling !== content ||
        footerSep.nextElementSibling !== footerEl) {
      content.insertAdjacentElement('afterend', footerEl);
      content.insertAdjacentElement('afterend', footerSep);
    }
  }

  function wireFooterEvents() {
    footerRow.addEventListener('mouseenter', () => {
      clearTimeout(flyoutCloseTimer);
      if (!flyoutEl) openSidebarFlyout(footerRow);
    });
    footerRow.addEventListener('mouseleave', scheduleFlyoutClose);
    footerRow.addEventListener('click', (e) => {
      e.preventDefault();
      if (flyoutEl) closeFlyout();
      else openSidebarFlyout(footerRow);
    });
  }

  function scheduleFlyoutClose() {
    clearTimeout(flyoutCloseTimer);
    flyoutCloseTimer = setTimeout(() => {
      if (flyoutEl && !flyoutEl.matches(':hover')) closeFlyout();
    }, 300);
  }

  // Generic flyout builder. sections: [{ label?, entries: [{ icon?, label,
  // active?, attrs? }] }] — entries are <a class=flyoutEntry> carrying attrs.
  function openFlyout(x, y, sections, onEntry) {
    closeFlyout();
    flyoutEl = document.createElement('div');
    flyoutEl.setAttribute('data-cv-flyout', '');
    const content = document.createElement('div');
    content.setAttribute('data-side', 'right');
    content.setAttribute('data-align', 'start');
    content.setAttribute('data-state', 'open');
    content.setAttribute('role', 'dialog');
    content.className = SITE_CLASSES.flyout;
    const inner = document.createElement('div');
    inner.className = 'flex flex-col';
    let first = true;
    for (const sec of sections) {
      if (sec.label || !first) {
        const sep = document.createElement('div');
        sep.className = SITE_CLASSES.flyoutSep;
        inner.appendChild(sep);
      }
      if (sec.label) {
        const lab = document.createElement('span');
        lab.className = SITE_CLASSES.flyoutLabel;
        lab.textContent = sec.label;
        inner.appendChild(lab);
      }
      for (const en of sec.entries) {
        const a = document.createElement('a');
        a.className = SITE_CLASSES.flyoutEntry;
        for (const [k, v] of Object.entries(en.attrs || {})) a.setAttribute(k, v);
        const icon = document.createElement('span');
        icon.className = SITE_CLASSES.flyoutIcon;
        icon.innerHTML = en.active ? ICON.check : (en.icon || '');
        a.appendChild(icon);
        const t = document.createElement('span');
        t.textContent = en.label;
        a.appendChild(t);
        inner.appendChild(a);
      }
      first = false;
    }
    content.appendChild(inner);
    flyoutEl.appendChild(content);
    document.body.appendChild(flyoutEl);

    // position to the right of the anchor, clamped to the viewport
    const w = flyoutEl.offsetWidth || 208, h = flyoutEl.offsetHeight || 200;
    flyoutEl.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    flyoutEl.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';

    flyoutEl.addEventListener('mouseenter', () => clearTimeout(flyoutCloseTimer));
    flyoutEl.addEventListener('mouseleave', scheduleFlyoutClose);
    flyoutEl.addEventListener('click', (e) => {
      const en = e.target.closest('[data-cv-pick],[data-cv-move],[data-cv-new]');
      if (!en) return;
      e.preventDefault();
      onEntry(en);
    });

    onDocDown = (e) => { if (flyoutEl && !flyoutEl.contains(e.target)) closeFlyout(); };
    onEsc = (ev) => { if (ev.key === 'Escape') closeFlyout(); };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onEsc, true);
    window.addEventListener('resize', closeFlyout);
    window.addEventListener('scroll', closeFlyout, true);
  }

  function closeFlyout() {
    clearTimeout(flyoutCloseTimer);
    if (flyoutEl) { flyoutEl.remove(); flyoutEl = null; }
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onEsc, true);
    window.removeEventListener('resize', closeFlyout);
    window.removeEventListener('scroll', closeFlyout, true);
  }

  function openSidebarFlyout(anchor) {
    const r = anchor.getBoundingClientRect();
    //const viewEntries = VIEWS.filter((v) => v.id !== 'native').map((v) => ({ // used when the 'native' view isn't included in the list of views
    const viewEntries = VIEWS.map((v) => ({
      label: v.label, active: state.view === v.id,
      attrs: { 'data-cv-pick': 'view', 'data-cv-view': v.id },
    }));
    openFlyout(r.right + 6, r.top, [
      { entries: [{label: "Sidebar configuration"}] },
      { label: "Group by", entries: viewEntries },
      { label: 'More', entries: [
        //{ label: 'Native (original)', active: state.view === 'native',
        //  attrs: { 'data-cv-pick': 'view', 'data-cv-view': 'native' } }, // Places the 'native' view under "More"; when commented out: change the filter above. 
        { label: syncing ? 'Syncing…' : 'Re-sync history', icon: ICON.refresh,
          attrs: { 'data-cv-pick': 'sync' } },
        { label: 'Settings', icon: ICON.gear,
          attrs: { 'data-cv-pick': 'settings' } },
      ] },
    ], (en) => {
      const pick = en.dataset.cvPick;
      if (pick === 'view') { setView(en.dataset.cvView); closeFlyout(); }
      else if (pick === 'sync') { closeFlyout(); syncNow(); }
      else if (pick === 'settings') { closeFlyout(); openSettings(); }
    });
  }

  // ========================= NATIVE MENU INJECTION ==========================
  // The site's "..." menus are Radix DropdownMenus: the content lives in a
  // portal near <body> ONLY while open and is unmounted on close. So we watch
  // for [role="menu"][data-radix-menu-content] appearing, figure out which
  // conversation the menu belongs to (aria-labelledby -> trigger element ->
  // sidebar row href, or the current page path for the header menu), and
  // splice in a "Move to…" item styled by cloning an existing item.
  // React never manages our node, so it can't object; Radix's own items keep
  // working (our item just isn't in Radix's arrow-key collection).

  function chatKeyFromMenu(menu) {
    let trigger = null;
    const labelledBy = menu.getAttribute('aria-labelledby');
    if (labelledBy) trigger = document.getElementById(labelledBy);
    if (!trigger) trigger = document.querySelector('button[aria-haspopup="menu"][data-state="open"]');
    if (!trigger) return null;
    const li = trigger.closest && trigger.closest(SEL.item);
    if (li) {
      const a = li.querySelector(SEL.itemLink);
      const key = a && a.getAttribute('href');
      return (key && key !== '#') ? key : null;
    }
    // Header "..." menu (no sidebar row): use the current page path when it
    // looks like a conversation URL.
    const p = location.pathname;
    return /^\/(agent|c)\/[^/]+/.test(p) ? p : null;
  }

  function ensureRegistered(key, fallbackTitle) {
    if (state.seen[key]) return;
    const nr = { title: (fallbackTitle || '').trim() || 'Untitled', bucket: '', ts: Date.now() };
    const modality = inferModality(key);
    if (modality) nr.modality = modality;
    else if (/^\/agent\//.test(key)) nr.kind = 'agent';
    state.seen[key] = nr;
    const target = ruleTarget(nr.title, key);
    if (target) state.assign[key] = groupByName(target).id;
    save();
    log('menu: registered', key);
  }

  function closeRadixMenu(menu) {
    // Radix closes on Escape; let its own handler do it (React owns the node).
    try {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    } catch (e) { /* never fatal */ }
  }

  function injectMenuItems() {
    const menus = document.querySelectorAll(SEL.radixMenu);
    for (const menu of menus) {
      if (menu.querySelector('[data-cv-menu-item]')) continue; // already done
      const key = chatKeyFromMenu(menu);
      if (!key) continue;
      const model = menu.querySelector(SEL.radixItem);
      if (!model) continue;

      ensureRegistered(key, null);

      const item = model.cloneNode(true);
      item.setAttribute('data-cv-menu-item', '');
      item.removeAttribute('id');
      const labelSpan = [...item.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (labelSpan) labelSpan.textContent = 'Move to…';
      else item.appendChild(document.createTextNode('Move to…'));
      // Replace whatever icon the clone carried with our folder icon (keep
      // the site's size classes by copying them onto our svg).
      const oldIcon = item.querySelector('svg');
      if (oldIcon) {
        const cls = oldIcon.getAttribute('class') || 'h-4 w-4';
        oldIcon.outerHTML = ICON.folder.replace('<svg ', `<svg class="${escAttr(cls)}" `);
      }

      const archiveItem = [...menu.querySelectorAll(SEL.radixItem)]
        .find((el) => el.querySelector(SEL.archiveIcon));
      if (archiveItem) menu.insertBefore(item, archiveItem);
      else menu.appendChild(item);

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = item.getBoundingClientRect();
        closeRadixMenu(menu);
        openMoveMenu(
          (r && r.left) || e.clientX || 200,
          (r && r.bottom) || e.clientY || 200,
          key
        );
      });
      log('menu item injected for', key);
    }
  }

  // ============================== MOVE MENU =================================
  function openMoveMenu(x, y, key) {
    closeFlyout();
    if (!state.seen[key]) ensureRegistered(key, null);
    const current = state.assign[key] || INBOX;
    const groupEntries = [
      { label: 'Unsorted', active: current === INBOX,
        attrs: { 'data-cv-move': INBOX } },
      ...state.groups.map((g) => ({
        label: g.name, active: g.id === current,
        attrs: { 'data-cv-move': g.id },
      })),
    ];
    openFlyout(x, y, [
      { entries: groupEntries },
      { label: 'Group', entries: [
        { label: 'New group…', attrs: { 'data-cv-new': '1' } },
      ] },
    ], (en) => {
      if (en.dataset.cvMove) {
        assignTo(key, en.dataset.cvMove);
        save(); renderPanel(); closeFlyout();
      } else if (en.dataset.cvNew) {
        closeFlyout();
        const name = window.prompt('Name of the new group:');
        if (name && name.trim()) {
          const g = createGroup(name);
          assignTo(key, g.id);
          save(); renderPanel();
        }
      }
    });
  }

  // ============================ SETTINGS MODAL ==============================
  let modalEl = null;

  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }

  function openSettings() {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.className = 'cv-overlay';
    modalEl.setAttribute('data-cv-modal', '');
    modalEl.innerHTML = `
      <div class="cv-modal text-text-primary border-border-faint bg-surface-secondary rounded-md border shadow-md">
        <div class="cv-modal-head">
          <b>Sidebar settings</b>
          <button class="${escAttr(SITE_CLASSES.closeBtn)}" data-close="1" title="Close">${ICON.x}</button>
        </div>
        <div class="cv-modal-body">
          <div class="cv-field-label">Groups</div>
          <div class="cv-groups"></div>
          <div><button class="${escAttr(SITE_CLASSES.btn)}" data-add="1">＋ Add group</button></div>

          <div class="cv-field-label">Auto-sort rules</div>
          <textarea class="cv-rules ${escAttr(SITE_CLASSES.input)}" rows="5"
            placeholder="Work | invoice&#10;Code | /\\b(bug|deploy|regex)\\b/i"></textarea>
          <div class="cv-hint">One rule per line: <code>Group name | text</code> — matches when the chat title
          contains that text (case-insensitive). Wrap in <code>/…/</code> for a regular expression.
          First match wins. Rules only fire the first time the script learns about a chat.</div>

          <div class="cv-field-label">Features</div>
          <label class="cv-check"><input type="checkbox" class="cv-opt-rules" ${state.opts.rules ? 'checked' : ''}>
            Auto-sort rules enabled</label>
          <label class="cv-check"><input type="checkbox" class="cv-opt-bgsync" ${state.opts.bgSync ? 'checked' : ''}>
            Background history sync (throttled, at page load)</label>

          <div class="cv-field-label">Backup</div>
          <textarea class="cv-io ${escAttr(SITE_CLASSES.input)}" rows="4" placeholder="“Export” puts your data here as JSON — paste it elsewhere and press “Import” (on any machine) to restore."></textarea>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <button class="${escAttr(SITE_CLASSES.btn)}" data-export="1">Export</button>
            <button class="${escAttr(SITE_CLASSES.btn)}" data-import="1">Import</button>
            <span style="flex:1"></span>
            <button class="${escAttr(SITE_CLASSES.btn)} ${escAttr(SITE_CLASSES.btnDanger)}" data-reset="1">Reset all data</button>
          </div>
          <div class="cv-hint cv-statline">
            ${Object.keys(state.seen).length} chats tracked · ${state.groups.length} groups
            · data lives in this browser's localStorage for ${escHtml(location.host)}
          </div>
        </div>
      </div>`;
    document.body.appendChild(modalEl);

    const groupsBox = modalEl.querySelector('.cv-groups');
    const rulesBox = modalEl.querySelector('.cv-rules');
    const ioBox = modalEl.querySelector('.cv-io');

    const renderGroupsEditor = () => {
      groupsBox.innerHTML = state.groups.length
        ? state.groups.map((g) => `
          <div class="cv-row" data-id="${escAttr(g.id)}">
            <input class="cv-input cv-gname ${escAttr(SITE_CLASSES.input)}" value="${escAttr(g.name)}" title="Group name">
            <button class="cv-mini ${escAttr(SITE_CLASSES.btn)}" data-mv="-1" title="Move up">↑</button>
            <button class="cv-mini ${escAttr(SITE_CLASSES.btn)}" data-mv="1" title="Move down">↓</button>
            <button class="cv-mini ${escAttr(SITE_CLASSES.btn)} ${escAttr(SITE_CLASSES.btnDanger)}" data-del="1" title="Delete group (its chats go back to Unsorted)">✕</button>
          </div>`).join('')
        : '<div class="cv-hint">No groups yet.</div>';
    };
    renderGroupsEditor();
    rulesBox.value = state.rules.map((r) => `${r.group} | ${r.pattern}`).join('\n');

    groupsBox.addEventListener('input', (e) => {
      const row = e.target.closest('.cv-row');
      if (!row) return;
      const g = state.groups.find((g) => g.id === row.dataset.id);
      if (g && e.target.classList.contains('cv-gname')) {
        g.name = e.target.value.trim() || g.name;
        save(); renderPanel();
      }
    });
    groupsBox.addEventListener('click', (e) => {
      const row = e.target.closest('.cv-row');
      if (!row) return;
      const idx = state.groups.findIndex((g) => g.id === row.dataset.id);
      if (idx < 0) return;
      if (e.target.closest('[data-mv]')) {
        const dir = Number(e.target.closest('[data-mv]').dataset.mv);
        const ni = idx + dir;
        if (ni >= 0 && ni < state.groups.length) {
          [state.groups[idx], state.groups[ni]] = [state.groups[ni], state.groups[idx]];
          save(); renderGroupsEditor(); renderPanel();
        }
      } else if (e.target.closest('[data-del]')) {
        const g = state.groups[idx];
        const n = itemsAssignedTo(g.id).length;
        if (!n || window.confirm(`Delete group “${g.name}”? Its ${n} chat(s) will return to Unsorted.`)) {
          state.groups.splice(idx, 1);
          for (const [k, gid] of Object.entries(state.assign)) if (gid === g.id) delete state.assign[k];
          save(); renderGroupsEditor(); renderPanel();
        }
      }
    });
    modalEl.querySelector('[data-add]').addEventListener('click', () => {
      createGroup('New group');
      renderGroupsEditor(); renderPanel();
      const rows = groupsBox.querySelectorAll('.cv-row');
      const last = rows[rows.length - 1];
      if (last) { const inp = last.querySelector('input'); inp.focus(); inp.select(); }
    });

    rulesBox.addEventListener('change', () => {
      state.rules = rulesBox.value.split('\n')
        .map((line) => line.split('|'))
        .filter((parts) => parts.length >= 2 && parts[0].trim() && parts.slice(1).join('|').trim())
        .map((parts) => ({ group: parts[0].trim(), pattern: parts.slice(1).join('|').trim() }));
      save();
    });

    modalEl.querySelector('.cv-opt-rules').addEventListener('change', (e) => {
      state.opts.rules = e.target.checked; save();
    });
    modalEl.querySelector('.cv-opt-bgsync').addEventListener('change', (e) => {
      state.opts.bgSync = e.target.checked; save();
      if (state.opts.bgSync) maybeBackgroundSync();
    });

    modalEl.querySelector('[data-export]').addEventListener('click', () => {
      ioBox.value = JSON.stringify({ groups: state.groups, assign: state.assign, rules: state.rules, seen: state.seen });
      ioBox.select();
    });
    modalEl.querySelector('[data-import]').addEventListener('click', () => {
      try {
        const d = JSON.parse(ioBox.value);
        if (!d || typeof d !== 'object') throw new Error('not an object');
        if (Array.isArray(d.groups)) state.groups = d.groups.filter((g) => g && g.id && g.name);
        if (d.assign && typeof d.assign === 'object') state.assign = d.assign;
        if (Array.isArray(d.rules)) state.rules = d.rules;
        if (d.seen && typeof d.seen === 'object') state.seen = d.seen;
        save(); renderGroupsEditor(); rulesBox.value = state.rules.map((r) => `${r.group} | ${r.pattern}`).join('\n'); renderPanel();
        window.alert('Imported ✔');
      } catch (e) {
        window.alert('Could not parse that JSON — export first to see the expected format.');
      }
    });
    modalEl.querySelector('[data-reset]').addEventListener('click', () => {
      if (window.confirm('Delete ALL grouped-sidebar data (groups, rules, registry) for this site?')) {
        try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) {}
        window.location.reload();
      }
    });

    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl || e.target.closest('[data-close]')) closeModal();
    });
  }

  // ===================== SCROLL SWEEP (API FALLBACK) ========================
  function findScroller(fromEl) {
    let el = fromEl;
    for (let i = 0; i < 6 && el; i++) {
      if (el.scrollHeight > el.clientHeight + 8) return el;
      el = el.parentElement;
    }
    return fromEl;
  }

  async function syncAllHistory() {
    if (syncing) return;
    const content = document.querySelector(SEL.content);
    if (!content) return;
    syncing = true;
    try {
      // Temporarily reveal the native list so its lazy loader keeps working.
      const sidebar = document.querySelector(SEL.sidebar);
      const prevView = sidebar ? sidebar.getAttribute('data-cv-view') : null;
      if (sidebar) sidebar.setAttribute('data-cv-view', 'native');

      const scroller = findScroller(content);
      let last = -1, stable = 0;
      for (let i = 0; i < 80; i++) {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        await sleep(220);
        syncState(extractConversations());
        const n = Object.keys(state.seen).length;
        if (n === last) { if (++stable >= 3) break; } else { stable = 0; last = n; }
      }
      if (scroller) scroller.scrollTop = 0;
      if (sidebar) sidebar.setAttribute('data-cv-view', prevView || state.view);
      save();
    } finally {
      syncing = false;
      renderPanel();
    }
  }

  // ============================== SCAN LOOP =================================
  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

  function scan() {
    if (syncing) return; // a full sync manages the DOM itself
    injectStyles();
    ensurePanelMounted();
    ensureFooterMounted();
    applyViewAttr(); // change-gated; re-assert after React rebuilds the sidebar
    injectMenuItems();
    const changed = syncState(extractConversations());
    if (state.view !== 'native' && changed) renderPanel();
  }

  // ================================ BOOT ====================================
  function boot() {
    injectStyles();
    loadState();
    panelRoot = buildPanel();
    applyViewAttr();
    syncState(extractConversations());
    renderPanel();

    const mo = new MutationObserver(scheduleScan);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        setView(state.view === 'native' ? state.lastCustomView : 'native');
      }
    });

    scan();
    maybeBackgroundSync(); // throttled; silent; respects the feature toggle

    // Small debug/integration surface (also handy if you ever need to poke at it)
    window.__groupedSidebar = {
      version: '0.7.2',
      state, VIEWS,
      setView, scan, save, renderPanel,
      createGroup, assignTo,
      extract: extractConversations,
      syncNow, syncFromApi, maybeBackgroundSync, parseTs, bucketFromDate,
      injectMenuItems, chatKeyFromMenu,
      openSettings, closeFlyout,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
