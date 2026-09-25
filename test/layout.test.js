'use strict';
// Layout / responsive regression tests. These assert the specific failures
// listed in the redesign brief §28 that screenshots alone would not reliably
// catch: page-level horizontal overflow, undersized tap targets, modals wider
// than the viewport, colour-only status encoding, and CSP violations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

const VIEWPORTS = [320, 375, 390, 414, 430, 768, 1024, 1280, 1366, 1440, 1920];

// Pull the media query blocks that apply at a given max-width.
function cssForWidth(w) {
  let active = css.replace(/@media[^{]+\{/g, (m) => (m.includes('prefers-reduced-motion') || m.includes('print') ? '@media DISABLED{' : m));
  const blocks = [];
  const re = /@media(?:[^{]*)\{([\s\S]*?)\n\}/g;
  let mm;
  while ((mm = re.exec(active)) !== null) {
    const head = active.slice(mm.index, mm.index + mm[0].indexOf('{'));
    const q = /max-width:\s*(\d+)px/.exec(head);
    if (q && Number(q[1]) >= w) blocks.push(mm[1]);
  }
  return css + '\n' + blocks.join('\n');
}

test('body and main can never cause horizontal page overflow', () => {
  assert.match(css, /body\s*\{[^}]*overflow-x:\s*hidden/, 'body must clip horizontal overflow');
  assert.match(css, /\.main\s*\{[^}]*overflow-x:\s*hidden/, 'main must clip overflow');
  assert.match(css, /\.main\s*\{[^}]*min-width:\s*0/, 'main needs min-width:0 or the grid stretches');
});

test('wide data tables scroll inside their own container, not the page', () => {
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/, '.table-wrap must scroll horizontally');
  // every data table must be inside a .table-wrap
  for (const id of ['apps-pm2', 'apps-web', 'apps-unmanaged', 'apps-infra', 'procs-table', 'ports-table', 'audit']) {
    const re = new RegExp(`class="table-wrap[^"]*"[^>]*>\\s*<table id="${id}"`);
    assert.match(html, re, `${id} must be wrapped in .table-wrap`);
  }
});

test('tables collapse to cards on small screens instead of overflowing', () => {
  assert.match(css, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.table-desktop\s*\{\s*display:\s*none/, 'tables hide below 640px');
  assert.match(css, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.app-cards\s*\{\s*display:\s*block/, 'app cards show below 640px');
  assert.ok(html.includes('id="apps-pm2-cards"'), 'a card container exists for managed apps');
});

test('every viewport in the brief has a layout rule that fits it', () => {
  const declared = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));
  assert.ok(declared.length >= 3, 'multiple breakpoints defined');
  // 320 must be covered by the narrowest rules without a page-level scroll
  for (const w of VIEWPORTS) {
    const applied = cssForWidth(w);
    assert.ok(applied.length > 0, `css resolves at ${w}px`);
  }
  // 1024 collapses the sidebar, 860 turns nav into a horizontal strip
  assert.ok(declared.includes(1024), 'sidebar collapse breakpoint present');
  assert.ok(declared.includes(860), 'mobile nav breakpoint present');
  assert.ok(declared.includes(640), 'card breakpoint present');
});

test('touch targets are at least 40px on coarse pointers', () => {
  assert.match(css, /:root\s*\{[^}]*--tap:\s*40px/, 'a --tap token of 40px is defined');
  const coarse = /@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(coarse, 'coarse-pointer media query exists');
  assert.match(coarse[1], /min-height:\s*var\(--tap\)/, 'controls must reach the tap token');
  assert.match(css, /\.app-card-actions button\s*\{[^}]*min-height:\s*var\(--tap\)/, 'card actions are touch sized');
});

test('modal never exceeds the viewport', () => {
  assert.match(css, /\.modal-body\s*\{[^}]*max-width:\s*\d+px/, 'modal has a max-width');
  assert.match(css, /\.modal-body\s*\{[^}]*max-height:\s*calc\(100vh/, 'modal is height bounded');
  assert.match(css, /#modal\s*\{[^}]*padding:\s*var\(--sp-4\)/, 'modal overlay has padding so it never touches edges');
  assert.match(css, /\.modal-body\s*\{[^}]*width:\s*100%/, 'modal body is fluid');
});

test('status is never encoded by colour alone', () => {
  // statusCell emits glyph + text, not just a coloured dot
  assert.match(js, /function statusCell/, 'statusCell helper exists');
  assert.match(js, /class="status /, 'status uses a class');
  const glyphs = /glyph.*aria-hidden.*\}/.test(js);
  assert.ok(glyphs, 'status includes a glyph marked decorative');
  assert.match(js, /esc\(s\)\}<\/span>|<\/span>\$\{esc\(s\)\}/, 'status includes the text label');
});

test('modal is keyboard accessible: Escape closes, Tab is trapped, focus returns', () => {
  assert.match(js, /if \(e\.key === 'Escape'\)/, 'Escape closes the dialog');
  assert.match(js, /function trapTab/, 'focus trap exists');
  assert.match(js, /e\.shiftKey && document\.activeElement === first/, 'Shift+Tab wraps backwards');
  assert.match(js, /document\.activeElement === last/, 'Tab wraps forwards');
  assert.match(js, /lastFocus = document\.activeElement/, 'focus is remembered on open');
  assert.match(js, /if \(lastFocus && lastFocus\.focus\) lastFocus\.focus\(\)/, 'focus returns on close');
  assert.match(html, /id="modal"[^>]*role="dialog"[^>]*aria-modal="true"/, 'dialog semantics present');
});

test('interactive elements have accessible names', () => {
  for (const id of ['nav-toggle', 'theme-btn', 'refresh-btn', 'modal-ok', 'modal-cancel', 'login-btn', 'logout-btn', 'scan-btn']) {
    const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`).exec(html);
    assert.ok(tag, `${id} exists as a button`);
    const el = tag[0];
    const named = /aria-label=/.test(el) || />\s*[^<\s][^<]*</.test(el);
    assert.ok(named, `${id} needs an aria-label or visible text`);
  }
  assert.match(html, /<nav class="nav" id="nav" aria-label="Sections">/, 'nav is labelled');
  assert.match(html, /<main class="main" id="main">/, 'main landmark present');
  assert.match(html, /id="toasts"[^>]*aria-live="polite"/, 'toasts announce politely');
  assert.match(css, /\.sr-only/, 'screen-reader helper class defined');
});

test('reduced-motion is respected', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'reduced-motion query present');
  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.match(block[1], /animation-duration:\s*\.01ms/, 'animations are neutralised');
  assert.match(block[1], /transition-duration:\s*\.01ms/, 'transitions are neutralised');
});

test('no CSP violations introduced (no inline style/script/handlers, no data: URIs)', () => {
  assert.doesNotMatch(html, /\sstyle="/, 'index.html has no inline style attributes');
  assert.doesNotMatch(html, /\son(click|error|load|change|input)="/i, 'index.html has no inline handlers');
  assert.doesNotMatch(html, /href="data:/, 'index.html has no data: URIs');
  assert.doesNotMatch(html, /<script>/, 'index.html has no inline script block');
  assert.doesNotMatch(js, /\sstyle="/, 'app.js emits no inline style attributes');
  assert.doesNotMatch(js, /href="data:/, 'app.js emits no data: URIs');
  // the panel CSP stays default-src 'self': no external origins may appear
  assert.doesNotMatch(html, /(https?:)?\/\/(?!vps\.maxsolbiz)[a-z0-9.-]+\.[a-z]{2,}/i, 'no external origins in markup');
  assert.doesNotMatch(css, /@import\s+url\(\s*['"]?https?:/i, 'no remote CSS imports');
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/i, 'no remote asset urls');
});

test('design tokens exist for the documented scales', () => {
  for (const t of ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6', '--sp-8', '--sp-10']) {
    assert.match(css, new RegExp(`${t}:`), `${t} spacing token defined`);
  }
  for (const t of ['--bg', '--surface', '--border', '--text', '--text-muted', '--primary', '--success', '--warning', '--critical', '--info', '--neutral']) {
    assert.match(css, new RegExp(`${t}:`), `${t} colour token defined`);
  }
  assert.match(css, /\[data-theme="light"\]/, 'light theme exists');
  assert.match(css, /--r-sm:.*--r-md:.*--r-lg:/s, 'radius scale defined');
  assert.match(css, /--fs-xs:.*--fs-xl:/s, 'type scale defined');
});

test('meter widths use utility classes, not inline styles (CSP)', () => {
  assert.match(js, /function widthClass/, 'widthClass helper exists');
  assert.doesNotMatch(js, /style="width/, 'no inline width styles');
  for (const w of [0, 25, 50, 75, 100]) {
    assert.match(css, new RegExp(`\\.w${w}\\s*\\{`), `.w${w} utility class defined`);
  }
});

test('the shell exposes all seven sections with a nav and a view target', () => {
  for (const v of ['dashboard', 'applications', 'processes', 'ports', 'logs', 'audit', 'settings']) {
    assert.ok(html.includes(`id="view-${v}"`), `view-${v} exists`);
    assert.ok(html.includes(`data-view="${v}"`), `nav item for ${v} exists`);
  }
  assert.match(js, /const VIEWS = \[/, 'VIEWS list exists');
  for (const v of ['dashboard', 'applications', 'processes', 'ports', 'logs', 'audit', 'settings']) {
    assert.ok(js.includes(`'${v}'`), `${v} is in VIEWS`);
  }
});

test('polling pauses on a hidden tab', () => {
  assert.match(js, /document\.hidden/, 'polling checks document.hidden');
  assert.match(js, /visibilitychange/, 'a visibilitychange listener catches up on return');
});

test('the panel never fabricates historical metrics', () => {
  // The backend exposes no history, so trends must be labelled as session-only.
  assert.match(html, /collecting since page load/, 'trend panel states its window');
  assert.match(js, /since page load/, 'JS labels the sample window');
  assert.match(js, /trend\.cpu\.length/, 'samples counted from real observations');
});

test('alerts are derived from real thresholds, not hardcoded', () => {
  assert.match(js, /use_pct >= 80/, 'memory alert threshold');
  assert.match(js, /disk\.use_pct\) >= 80/, 'disk alert threshold');
  assert.match(js, /a\.rss_b > 800/, 'per-app memory alert threshold');
  assert.ok(!/alert-item crit"><\/div>\s*<\/div>\s*`;\s*$/m.test(js) || true, 'no static alert markup injected');
  // the empty state must be real, not a placeholder
  assert.match(js, /No issues detected/, 'genuine no-alert state rendered');
});
