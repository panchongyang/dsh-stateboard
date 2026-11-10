/**
 * 测试职责：冻结客户端 CSS 字节、主题、尺寸和动效契约。
 * 典型流程：读取真实 bundle → 构造独立离线替身 → 逐段断言契约。
 * 覆盖边界：覆盖 出货产物的离线契约；不覆盖真实 DOM、浏览器视觉、网络或宿主会话。
 * 外部前置：需要仓库现有客户端构建产物；不启动浏览器。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadClientBundle } from '../helpers/client-bundle-fixture.mjs';

// 责任：校验样式标识命名空间与幂等注入属性。（原 L143-144）
test("namespaced idempotent stylesheet injection", () => {
  const { source } = loadClientBundle();

  assert.ok(source.includes('dsh-project-board/ui.css'), 'stylesheet tag id is namespaced');
  assert.ok(source.includes('data-plugin-css'), 'stylesheet injection is idempotent by attribute');
});

// 责任：比较 CSS 源码和 bundle 字节，冻结七级字号、控件尺寸及基础对比度 token。（原 L146-179）
test("stylesheet bytes and metrics", () => {
  const { here, exportsValue } = loadClientBundle();

  // 分段职责：比较 CSS 源码和 bundle 字节，冻结七级字号、控件尺寸及基础对比度 token。
  // ------------------------------------------------- stylesheet metrics (P1)

  const cssText = exportsValue.__ui.css;
  assert.equal(typeof cssText, 'string', 'stylesheet is exported at runtime');
  assert.equal(
    fs.readFileSync(path.join(here, '../..', 'src', 'client', 'styles.css'), 'utf8'),
    cssText,
    'bundled stylesheet equals src/client/styles.css byte for byte',
  );

  const FONT_TOKENS = { '--pb-fs-xs': 11, '--pb-fs-sm': 12, '--pb-fs-md': 13, '--pb-fs-base': 14, '--pb-fs-lg': 16, '--pb-fs-xl': 20, '--pb-fs-num': 28 };
  const fontDecls = [...cssText.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(fontDecls.length > 40, 'font-size declarations found (' + fontDecls.length + ')');
  const fontSizes = fontDecls.map((value) => {
    const token = /var\((--pb-fs-[a-z]+)\)/.exec(value);
    return token ? FONT_TOKENS[token[1]] : parseFloat(value);
  });
  assert.ok(fontSizes.every((size) => Number.isFinite(size)), 'every font-size resolves to a token or px');
  assert.deepEqual([...new Set(fontSizes)].sort((a, b) => a - b), [11, 12, 13, 14, 16, 20, 28], 'type scale is exactly 7 steps');
  const smallShare = fontSizes.filter((size) => size <= 12.5).length / fontSizes.length;
  assert.ok(smallShare <= 0.25, 'share of text <= 12.5px is <= 25% (got ' + (smallShare * 100).toFixed(1) + '%)');

  for (const [name, px] of [['sm', 32], ['md', 36], ['lg', 40]]) {
    assert.ok(cssText.includes('--pb-control-' + name + ': ' + px + 'px;'), 'control token ' + name + ' = ' + px);
  }
  assert.ok(/\.pb-btn \{[^}]*min-height: var\(--pb-control-md\)/.test(cssText), 'button height uses the shared control token');
  assert.ok(/\.pb-input \{[^}]*height: var\(--pb-control-md\)/.test(cssText), 'input height matches button height');
  assert.ok(/\.pb-btn--sm \{[^}]*min-height: var\(--pb-control-sm\)/.test(cssText), 'small button uses the sm token');

  assert.ok(cssText.includes('--pb-text-3: #6b7280;'), 'text-3 meets AA on the canvas');
  assert.ok(cssText.includes('--pb-text-3: #9ca3af;'), 'text-3 has a dark-theme value');
  assert.ok(!/text-transform: uppercase/.test(cssText), 'no uppercase transform on CJK labels');
  assert.ok(cssText.includes('--pb-accent-soft:'), 'accent-soft token is defined (dark-mode chip fix)');
});

// 责任：检查动效 token 和退场类齐备，reduced-motion 必须关闭动画、过渡和平滑滚动。（原 L181-198）
test("motion and reduced motion", () => {
  const { exportsValue } = loadClientBundle();
  const cssText = exportsValue.__ui.css;
  // 分段职责：检查动效 token 和退场类齐备，reduced-motion 必须关闭动画、过渡和平滑滚动。
  // --------------------------------------------------------------- motion (P4)

  const reducedStart = cssText.indexOf('@media (prefers-reduced-motion: reduce) {');
  const reducedEnd = cssText.indexOf('\n}\n', reducedStart);
  assert.ok(reducedStart >= 0 && reducedEnd > reducedStart, 'reduced-motion block exists');
  const reducedBlockText = cssText.slice(reducedStart, reducedEnd);
  assert.ok(reducedBlockText.includes('animation: none !important'), 'reduced motion kills every animation');
  assert.ok(reducedBlockText.includes('transition: none !important'), 'reduced motion kills every transition');
  assert.ok(reducedBlockText.includes('scroll-behavior: auto !important'), 'reduced motion kills smooth scrolling');
  for (const needle of [
    '--pb-fast: 120ms;', '--pb-base: 180ms;', '--pb-slow: 240ms;', '--pb-flash: 300ms;',
    '--pb-ease-out:', '--pb-ease-in:',
    '.pb-drawer-layer--closing', '.pb-toast--leaving', '.pb-stat--flash', '.pb-tabpanel',
    '@keyframes pb-slide-out', '@keyframes pb-fade-out', '@keyframes pb-toast-out', '@keyframes pb-fade-slide', '@keyframes pb-flash',
  ]) {
    assert.ok(cssText.includes(needle), 'motion css is missing ' + needle);
  }
});

// 责任：检查超宽容器断点及满宽画布，不得残留居中补丁或已移除密度开关。（原 L200-206）
test("wide screens", () => {
  const { exportsValue } = loadClientBundle();
  const cssText = exportsValue.__ui.css;
  // 分段职责：检查超宽容器断点及满宽画布，不得残留居中补丁或已移除密度开关。
  // ------------------------------------------------------ wide screens (P2)

  assert.ok(/@container \(min-width: 1680px\)/.test(cssText), 'there is a wide-screen breakpoint (min-width)');
  assert.ok(/\.pb-main \{ padding: 16px; \}/.test(cssText), 'board content is full-bleed (no centred cap)');
  assert.ok(!cssText.includes('calc((100% - 1680px)'), 'no centred-gutter hack left in the stylesheet');
  assert.ok(!cssText.includes('pb-density'), 'the removed density switch leaves no styling behind');
});

// 责任：设计系统样式必须内嵌并含主题、组件、焦点、容器查询及低动效规则。（原 L718-732）
test("embedded design system", () => {
  const { exportsValue } = loadClientBundle();

  // 分段职责：设计系统样式必须内嵌并含主题、组件、焦点、容器查询及低动效规则。
  // ------------------------------------------------------------- stylesheet

  const ui = exportsValue.__ui;
  assert.ok(ui && typeof ui.css === 'string' && ui.css.length > 5000, 'design system stylesheet embedded');
  for (const needle of [
    '--pb-canvas', '--pb-surface', '--pb-accent',
    '[data-ds-dark-theme]',
    '.pb-btn--primary', '.pb-badge--violet', '.pb-drawer', '.pb-toast',
    '.pb-empty', '.pb-skeleton', '.pb-error', '.pb-progress', '.pb-stat',
    '.pb-card:focus-visible', ':focus-visible',
    '@container', 'prefers-reduced-motion',
  ]) {
    assert.ok(ui.css.includes(needle), 'stylesheet is missing ' + needle);
  }
});

// 责任：卡片元信息须默认单行，窄屏标题两行，极窄屏允许计划换行。（原 L733-738）
test("card stylesheet layout", () => {
  const { exportsValue } = loadClientBundle();
  const ui = exportsValue.__ui;
  // 分段职责：卡片元信息须默认单行，窄屏标题两行，极窄屏允许计划换行。
  // P6 card: one meta line that never wraps, and a <=360px two-line title clamp.
  assert.ok(/\.pb-card__meta\s*\{[^}]*flex-wrap:\s*nowrap[^}]*\}/.test(ui.css), 'card meta stays on one line');
  assert.ok(/@container\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.pb-card__title\s*\{[^}]*line-clamp:\s*2/.test(ui.css), 'narrow cards clamp the title at two lines');
  assert.ok(/\.pb-card__plan-name\s*\{[^}]*text-overflow:\s*ellipsis/.test(ui.css), 'only the plan name ellipsizes; the step stays visible');
  assert.ok(/@container\s*\(max-width:\s*240px\)[\s\S]*?\.pb-card__meta\s*\{[^}]*flex-wrap:\s*wrap/.test(ui.css), 'very narrow cards wrap the plan onto its own line');
});
