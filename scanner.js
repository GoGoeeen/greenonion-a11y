import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { parseStringPromise } from 'xml2js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// --- Configuration ---
const DEFAULT_MAX_PAGES = 50;
const SEVERITY_WEIGHTS = { critical: 10, serious: 5, moderate: 2, minor: 1 };
const HTMLCS_CDN = 'https://squizlabs.github.io/HTML_CodeSniffer/build/HTMLCS.js';

// --- Cookie-Banner Dismissal ---
async function dismissCookieBanner(page) {
  const selectors = [
    '[id*="cookie"] button',
    '[class*="cookie"] button',
    '[class*="consent"] button',
    '.cc-dismiss',
    '.cc-btn.cc-allow',
    'button[data-cookiefirst-action="accept"]',
    '#accept-cookies',
    '.cookie-accept',
  ];

  // Text-basierte Selektoren separat (Playwright :has-text)
  const textSelectors = [
    'button:has-text("Akzeptieren")',
    'button:has-text("Accept")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Accept all")',
  ];

  for (const selector of [...selectors, ...textSelectors]) {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* ignore */ }
  }
}

// --- Sitemap Parser ---
async function fetchSitemap(baseUrl) {
  const extractUrlsFromSitemapXml = async (xml) => {
    const parsed = await parseStringPromise(xml);
    if (parsed.sitemapindex) {
      const sitemapUrls = parsed.sitemapindex.sitemap.map(s => s.loc[0]);
      const allUrls = [];
      for (const url of sitemapUrls) {
        try {
          const subRes = await fetch(url);
          if (!subRes.ok) continue;
          const subXml = await subRes.text();
          const subParsed = await parseStringPromise(subXml);
          if (subParsed.urlset?.url) {
            allUrls.push(...subParsed.urlset.url.map(u => u.loc[0]));
          }
        } catch { /* skip broken sub-sitemaps */ }
      }
      return allUrls;
    }

    if (parsed.urlset?.url) {
      return parsed.urlset.url.map(u => u.loc[0]);
    }
    return [];
  };

  const getSitemapUrlsFromRobots = async () => {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).href;
      const res = await fetch(robotsUrl);
      if (!res.ok) return [];
      const robots = await res.text();
      // Capture "Sitemap: URL" even if the file has odd formatting on one line.
      const matches = [...robots.matchAll(/sitemap:\s*(\S+)/gi)];
      return matches.map(m => m[1]).filter(Boolean);
    } catch {
      return [];
    }
  };

  const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
  const candidateSitemaps = [sitemapUrl, ...(await getSitemapUrlsFromRobots())];

  try {
    for (const smUrl of candidateSitemaps) {
      const res = await fetch(smUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      const urls = await extractUrlsFromSitemapXml(xml);
      if (urls.length > 0) return urls;
    }

    return [];
  } catch {
    return [];
  }
}

// --- Link Crawler (fallback) ---
async function crawlLinks(page, baseUrl, maxPages) {
  const visited = new Set();
  const queue = [baseUrl];
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./i, '');

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift();
    const normalized = url.split('#')[0].split('?')[0];
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await dismissCookieBanner(page);
      const links = await page.$$eval('a[href]', anchors =>
        anchors.map(a => a.href).filter(h => h.startsWith('http'))
      );
      for (const link of links) {
        const clean = link.split('#')[0].split('?')[0];
        let isSameSite = false;
        try {
          const linkUrl = new URL(clean);
          const linkHost = linkUrl.hostname.replace(/^www\./i, '');
          isSameSite = linkHost === baseHost;
        } catch { /* invalid URL */ }
        if (isSameSite && !visited.has(clean)) queue.push(clean);
      }
    } catch { /* skip unreachable pages */ }
  }

  return [...visited];
}

// --- Authentication ---
async function performLogin(page, loginUrl, auth) {
  console.log(`  Logging in at ${loginUrl}...`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  if (auth.userSelector && auth.passSelector) {
    await page.fill(auth.userSelector, auth.username);
    await page.fill(auth.passSelector, auth.password);
    if (auth.submitSelector) {
      await page.click(auth.submitSelector);
    } else {
      await page.press(auth.passSelector, 'Enter');
    }
  } else {
    const userField = await page.$('input[type="email"], input[name="email"], input[name="user"], input[name="username"], input[name="login"], input[id="user_login"], input[id="email"]');
    const passField = await page.$('input[type="password"]');

    if (userField && passField) {
      await userField.fill(auth.username);
      await passField.fill(auth.password);

      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Anmelden"), button:has-text("Sign in")');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await passField.press('Enter');
      }
    } else {
      console.log('  Could not find login form fields.');
      return false;
    }
  }

  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch {
    await page.waitForTimeout(2000);
  }

  const url = page.url();
  const hasLoginInUrl = url.includes('login') || url.includes('signin');
  const hasErrorMsg = await page.$('.error, .alert-danger, .login-error, [class*="error"]');

  if (hasLoginInUrl && hasErrorMsg) {
    console.log('  Login may have failed (still on login page with error)');
    return false;
  }

  console.log(`  Logged in. Current page: ${url}`);
  return true;
}

// --- Load URL list from file ---
function loadUrlList(filePath, baseUrl) {
  const content = readFileSync(filePath, 'utf-8');
  const origin = new URL(baseUrl).origin;
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      if (line.startsWith('http')) return line;
      return origin + (line.startsWith('/') ? line : '/' + line);
    });
}

// ============================================================
// HEBEL 1: axe-core erweitert (incomplete + iframes + shadowDom)
// ============================================================
async function scanPageAxe(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await dismissCookieBanner(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .options({ iframes: true, shadowDom: true })
      .analyze();

    const mapNodes = (v) => ({
      rule: v.id,
      engine: 'axe-core',
      severity: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      wcagTags: v.tags.filter(t => t.startsWith('wcag')),
      nodes: v.nodes.map(n => ({
        selector: n.target.join(' > '),
        html: n.html?.substring(0, 500),
        failureSummary: n.failureSummary,
      })),
    });

    const violations = results.violations.map(mapNodes);

    // Incomplete = semi-automatische Checks, die wahrscheinlich fehlschlagen
    const incomplete = results.incomplete
      .filter(v => v.nodes.length > 0)
      .map(v => ({
        ...mapNodes(v),
        needsReview: true,
      }));

    return { violations, incomplete };
  } catch (err) {
    return {
      violations: [{ rule: '_error', engine: 'axe-core', severity: 'critical', description: `Scan failed: ${err.message}`, nodes: [] }],
      incomplete: [],
    };
  }
}

// ============================================================
// HEBEL 2: HTML_CodeSniffer als zweite Engine
// ============================================================

// CSS-Selektor-Generator fuer Browser-Kontext
const SELECTOR_HELPER_FN = `
function _getSelector(el) {
  if (!el || el === document.documentElement) return 'html';
  if (el.id) return '#' + CSS.escape(el.id);
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const siblings = [...parent.children].filter(c => c.tagName === el.tagName);
  if (siblings.length === 1) return _getSelector(parent) + ' > ' + tag;
  const idx = siblings.indexOf(el) + 1;
  return _getSelector(parent) + ' > ' + tag + ':nth-of-type(' + idx + ')';
}
`;

// HTMLCS severity mapping: 1=error, 2=warning, 3=notice
const HTMLCS_SEVERITY_MAP = { 1: 'serious', 2: 'moderate', 3: 'minor' };

// Map HTMLCS codes to WCAG SC numbers
function htmlcsCodeToWcag(code) {
  const match = code.match(/WCAG2AA\.Principle(\d)\.Guideline(\d+_\d+)\.(\d+_\d+_\d+)/);
  if (!match) return [];
  const sc = match[3].replace(/_/g, '.');
  return ['wcag' + sc.replace(/\./g, '')];
}

async function scanPageHTMLCS(page) {
  try {
    // Inject HTML_CodeSniffer
    await page.addScriptTag({ url: HTMLCS_CDN });
    await page.waitForTimeout(500);

    const issues = await page.evaluate(`
      (function() {
        ${SELECTOR_HELPER_FN}
        return new Promise(function(resolve) {
          if (typeof HTMLCS === 'undefined') { resolve([]); return; }
          HTMLCS.process('WCAG2AA', document, function() {
            var msgs = HTMLCS.getMessages();
            resolve(msgs.filter(function(m) { return m.type <= 2; }).slice(0, 500).map(function(m) {
              return {
                type: m.type,
                code: m.code,
                message: m.msg,
                selector: m.element ? _getSelector(m.element) : '',
                html: m.element ? m.element.outerHTML.substring(0, 300) : '',
              };
            }));
          });
        });
      })()
    `);

    return issues.map(i => ({
      rule: i.code.split('.').pop() || i.code,
      engine: 'htmlcs',
      severity: HTMLCS_SEVERITY_MAP[i.type] || 'moderate',
      description: i.message,
      htmlcsCode: i.code,
      wcagTags: htmlcsCodeToWcag(i.code),
      nodes: [{
        selector: i.selector,
        html: i.html,
        failureSummary: i.message,
      }],
    }));
  } catch (err) {
    console.log(`    HTMLCS scan error: ${err.message}`);
    return [];
  }
}

// Deduplicate: Wenn axe und HTMLCS dasselbe Element + gleiche Regel finden, behalte nur axe
function normalizeSelector(selector) {
  return String(selector || '')
    .toLowerCase()
    .replace(/\\:/g, ':')
    .replace(/["']/g, '')
    .replace(/\s*>\s*/g, ' > ')
    .replace(/:nth-child\(\d+\)/g, '')
    .replace(/:nth-of-type\(\d+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapHtmlcsIssueToAxeRule(issue) {
  const code = String(issue.htmlcsCode || '');
  const shortRule = String(issue.rule || '');

  // Kontrast: HTMLCS G18.Fail <-> axe color-contrast
  if (code === 'WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail') return 'color-contrast';

  // Form labels / accessible name: HTMLCS F68, H91.Input*.Name <-> axe label
  if (shortRule === 'F68' || /H91\.Input[^.]*\.Name$/.test(code)) return 'label';

  // Heading hierarchy: HTMLCS G141 <-> axe heading-order
  if (shortRule === 'G141' || /\.G141$/.test(code)) return 'heading-order';

  // Duplicate ID in ARIA context: HTMLCS F77 <-> axe duplicate-id-aria
  if (shortRule === 'F77' || /\.F77$/.test(code)) return 'duplicate-id-aria';

  // Existing baseline mappings
  const ruleMap = {
    H57: 'html-has-lang',
    H58: 'html-lang-valid',
    H44: 'label',
    H65: 'label',
    H71: 'label',
    H37: 'image-alt',
    H67: 'image-alt',
    G18: 'color-contrast',
    G145: 'color-contrast',
    H25: 'document-title',
    H64: 'frame-title',
  };

  return ruleMap[shortRule] || shortRule;
}

function deduplicateIssues(axeIssues, htmlcsIssues) {
  const axeSelectors = new Set();
  const axeContrastSelectors = new Set();

  for (const issue of axeIssues) {
    for (const node of issue.nodes || []) {
      const normalized = normalizeSelector(node.selector);
      axeSelectors.add(issue.rule + '::' + normalized);

      // Kontrast-Issues aus axe als Source of Truth
      if (issue.rule === 'color-contrast') {
        axeContrastSelectors.add(normalized);
      }
    }
  }

  const unique = htmlcsIssues.filter(issue => {
    // Schritt 2a: HTMLCS-Kontrastregel erkennen
    const isHtmlcsContrastIssue =
      issue.htmlcsCode === 'WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail';

    // Schritt 2b: Kontrast-Duplikate gegen axe verwerfen
    if (isHtmlcsContrastIssue) {
      for (const node of issue.nodes || []) {
        const normalized = normalizeSelector(node.selector);
        if (axeContrastSelectors.has(normalized)) return false;
      }
    }

    const mappedRule = mapHtmlcsIssueToAxeRule(issue);

    for (const node of issue.nodes || []) {
      const normalized = normalizeSelector(node.selector);
      if (axeSelectors.has(mappedRule + '::' + normalized)) return false;
    }
    return true;
  });

  return unique;
}

// ============================================================
// HEBEL 3: Viewport-Reflow, Focus Visible, Keyboard Trap
// ============================================================

// 1.4.10 Reflow — Test bei 320px CSS-Breite
async function testReflow(page, url) {
  const originalViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(500);

    const result = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const hasHScroll = document.documentElement.scrollWidth > vw + 5;

      const overflowing = [];
      const els = document.querySelectorAll('*');
      for (let i = 0; i < els.length && overflowing.length < 30; i++) {
        const rect = els[i].getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + 5) {
          overflowing.push({
            tag: els[i].tagName.toLowerCase(),
            className: (els[i].className || '').toString().substring(0, 80),
            computedWidth: Math.round(rect.width),
            overflow: Math.round(rect.right - vw),
          });
        }
      }

      return { hasHorizontalScroll: hasHScroll, overflowingElements: overflowing };
    });

    // Restore viewport
    if (originalViewport) await page.setViewportSize(originalViewport);

    if (!result.hasHorizontalScroll && result.overflowingElements.length === 0) return null;

    return {
      rule: 'reflow-320px',
      engine: 'custom',
      severity: 'serious',
      wcag: '1.4.10',
      wcagTags: ['wcag1410'],
      description: `Seite erzeugt horizontales Scrollen bei 320px Breite (${result.overflowingElements.length} Elemente ueberlaufen)`,
      nodes: result.overflowingElements.map(el => ({
        selector: `${el.tag}.${el.className.split(' ')[0] || ''}`,
        html: `<${el.tag} class="${el.className}"> (Breite: ${el.computedWidth}px, Ueberlauf: ${el.overflow}px)`,
        failureSummary: `Element ragt ${el.overflow}px ueber den 320px Viewport hinaus`,
      })),
    };
  } catch (err) {
    if (originalViewport) await page.setViewportSize(originalViewport);
    console.log(`    Reflow test error: ${err.message}`);
    return null;
  }
}

// 2.4.7 Focus Visible — Prueft ob :focus sichtbare Aenderung erzeugt
async function testFocusIndicators(page) {
  try {
    const results = await page.evaluate(() => {
      const focusable = document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      const missing = [];
      const limit = Math.min(focusable.length, 60);

      for (let i = 0; i < limit; i++) {
        const el = focusable[i];
        // Skip invisible elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const before = getComputedStyle(el);
        const snap = {
          outline: before.outline,
          outlineColor: before.outlineColor,
          outlineStyle: before.outlineStyle,
          outlineWidth: before.outlineWidth,
          boxShadow: before.boxShadow,
          border: before.border,
          backgroundColor: before.backgroundColor,
          textDecoration: before.textDecoration,
        };

        el.focus();

        const after = getComputedStyle(el);
        const changed =
          snap.outline !== after.outline ||
          snap.outlineColor !== after.outlineColor ||
          snap.outlineStyle !== after.outlineStyle ||
          snap.outlineWidth !== after.outlineWidth ||
          snap.boxShadow !== after.boxShadow ||
          snap.border !== after.border ||
          snap.backgroundColor !== after.backgroundColor ||
          snap.textDecoration !== after.textDecoration;

        // Also check for outline: none / outline-style: none explicitly set
        const outlineHidden =
          after.outlineStyle === 'none' && after.boxShadow === 'none';

        if (!changed || outlineHidden) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + el.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : '';
          missing.push({
            selector: tag + id + cls,
            html: el.outerHTML.substring(0, 300),
            text: (el.textContent || '').trim().substring(0, 80),
          });
        }

        el.blur();
      }

      return missing;
    });

    if (results.length === 0) return null;

    return {
      rule: 'focus-visible',
      engine: 'custom',
      severity: 'serious',
      wcag: '2.4.7',
      wcagTags: ['wcag247'],
      description: `${results.length} interaktive Elemente ohne sichtbaren Fokus-Indikator`,
      nodes: results.map(r => ({
        selector: r.selector,
        html: r.html,
        failureSummary: `Kein sichtbarer Fokus-Indikator beim Fokussieren${r.text ? ': "' + r.text + '"' : ''}`,
      })),
    };
  } catch (err) {
    console.log(`    Focus test error: ${err.message}`);
    return null;
  }
}

// 2.1.2 No Keyboard Trap — Tab-Zyklus-Pruefung
async function testKeyboardTraps(page) {
  try {
    // Focus the body first to start clean
    await page.evaluate(() => document.body.focus());

    const result = await page.evaluate(() => {
      const visited = [];
      const body = document.body;
      body.focus();

      // Simulate tabbing through focusable elements
      const focusable = document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      const traps = [];
      for (let i = 0; i < Math.min(focusable.length, 80); i++) {
        const el = focusable[i];
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        el.focus();
        if (document.activeElement !== el) continue;

        // Check if element has key event listeners that might trap
        const tag = el.tagName.toLowerCase();
        const hasKeyHandlers = el.getAttribute('onkeydown') || el.getAttribute('onkeypress');
        const role = el.getAttribute('role');

        // Suspicious patterns: modal-like containers, custom widgets without proper key handling
        if (hasKeyHandlers && role !== 'dialog') {
          traps.push({
            selector: tag + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.toString().trim().split(/\s+/)[0] : ''),
            html: el.outerHTML.substring(0, 300),
            reason: 'Element hat Key-Event-Handler die Tab-Navigation blockieren koennten',
          });
        }

        // Check for tabindex loops (multiple elements with same high tabindex)
        const tabIdx = parseInt(el.getAttribute('tabindex'));
        if (tabIdx > 0) {
          traps.push({
            selector: tag + (el.id ? '#' + el.id : ''),
            html: el.outerHTML.substring(0, 300),
            reason: `Positiver tabindex="${tabIdx}" stoert natuerliche Tab-Reihenfolge`,
          });
        }
      }

      return traps;
    });

    if (result.length === 0) return null;

    return {
      rule: 'keyboard-trap',
      engine: 'custom',
      severity: 'critical',
      wcag: '2.1.2',
      wcagTags: ['wcag212'],
      description: `${result.length} potenzielle Keyboard-Trap(s) oder Tab-Reihenfolge-Probleme erkannt`,
      nodes: result.map(r => ({
        selector: r.selector,
        html: r.html,
        failureSummary: r.reason,
      })),
    };
  } catch (err) {
    console.log(`    Keyboard trap test error: ${err.message}`);
    return null;
  }
}

// ============================================================
// HEBEL 4: CSS-basierte Checks
// ============================================================

// 1.4.12 Text Spacing — Override-Test
async function testTextSpacing(page) {
  try {
    const clipped = await page.evaluate(() => {
      // Inject WCAG text spacing overrides
      const style = document.createElement('style');
      style.id = '_go_text_spacing_test';
      style.textContent = `
        * {
          line-height: 1.5em !important;
          letter-spacing: 0.12em !important;
          word-spacing: 0.16em !important;
        }
        p, li, dd, dt, blockquote, td, th, label, span, div {
          margin-bottom: 2em !important;
        }
      `;
      document.head.appendChild(style);

      // Wait for reflow
      document.body.offsetHeight;

      const results = [];
      const els = document.querySelectorAll('*');
      for (let i = 0; i < els.length && results.length < 30; i++) {
        const el = els[i];
        const s = getComputedStyle(el);
        // Check for text clipping due to fixed height + overflow hidden
        if (
          (s.overflow === 'hidden' || s.overflowY === 'hidden') &&
          el.scrollHeight > el.clientHeight + 2 &&
          el.textContent.trim().length > 0 &&
          el.clientHeight > 0
        ) {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + el.className.toString().trim().split(/\s+/)[0] : '';
          results.push({
            selector: tag + id + cls,
            html: el.outerHTML.substring(0, 300),
            text: el.textContent.trim().substring(0, 80),
            height: el.clientHeight,
            scrollHeight: el.scrollHeight,
          });
        }
      }

      // Cleanup
      document.getElementById('_go_text_spacing_test')?.remove();

      return results;
    });

    if (clipped.length === 0) return null;

    return {
      rule: 'text-spacing-override',
      engine: 'custom',
      severity: 'serious',
      wcag: '1.4.12',
      wcagTags: ['wcag1412'],
      description: `${clipped.length} Elemente schneiden Text ab wenn WCAG Text-Spacing angewendet wird`,
      nodes: clipped.map(c => ({
        selector: c.selector,
        html: c.html,
        failureSummary: `Text wird abgeschnitten: Container-Hoehe ${c.height}px, Inhalt benoetigt ${c.scrollHeight}px (overflow:hidden). Text: "${c.text}"`,
      })),
    };
  } catch (err) {
    console.log(`    Text spacing test error: ${err.message}`);
    return null;
  }
}

// 2.3.1 / 2.2.2 Animation — prefers-reduced-motion Pruefung
async function testAnimations(page) {
  try {
    const result = await page.evaluate(() => {
      let animationCount = 0;
      let transitionCount = 0;
      let hasReducedMotionQuery = false;
      const animatedSelectors = [];

      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule) {
              if (rule.conditionText?.includes('prefers-reduced-motion')) {
                hasReducedMotionQuery = true;
              }
            }
            if (rule.style) {
              if (rule.style.animation && rule.style.animation !== 'none') {
                animationCount++;
                if (animatedSelectors.length < 15) {
                  animatedSelectors.push({ selector: rule.selectorText, type: 'animation', value: rule.style.animation });
                }
              }
              if (rule.style.animationName && rule.style.animationName !== 'none') {
                animationCount++;
              }
              // Only flag transitions that are not just color/opacity (those are typically OK)
              const t = rule.style.transition || rule.style.transitionProperty;
              if (t && t !== 'none' && !t.match(/^(color|opacity|background-color)$/)) {
                transitionCount++;
              }
            }
          }
        } catch { /* cross-origin stylesheet */ }
      }

      return {
        animationCount,
        transitionCount,
        hasReducedMotionQuery,
        animatedSelectors,
      };
    });

    if (result.animationCount === 0) return null;
    if (result.hasReducedMotionQuery) return null; // Already handled

    return {
      rule: 'reduced-motion',
      engine: 'custom',
      severity: 'moderate',
      wcag: '2.3.1',
      wcagTags: ['wcag231'],
      description: `${result.animationCount} CSS-Animationen gefunden, aber kein @media (prefers-reduced-motion) vorhanden`,
      nodes: result.animatedSelectors.map(a => ({
        selector: a.selector,
        html: `${a.type}: ${a.value}`,
        failureSummary: 'Animation ohne prefers-reduced-motion Alternative. Nutzer mit vestibularen Stoerungen koennen Animationen nicht deaktivieren.',
      })),
    };
  } catch (err) {
    console.log(`    Animation test error: ${err.message}`);
    return null;
  }
}

// 3.1.1 Language of Page + 3.1.2 Language of Parts
async function testLanguage(page) {
  try {
    const result = await page.evaluate(() => {
      const htmlLang = document.documentElement.lang;
      const issues = [];

      // 3.1.1 — html element must have valid lang
      if (!htmlLang || htmlLang.trim() === '') {
        issues.push({
          type: 'missing-lang',
          message: 'Kein lang-Attribut auf <html>-Element',
          selector: 'html',
          html: '<html> (lang fehlt)',
        });
      } else if (!/^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(htmlLang.trim())) {
        issues.push({
          type: 'invalid-lang',
          message: `Ungueltiger lang-Wert: "${htmlLang}"`,
          selector: 'html',
          html: `<html lang="${htmlLang}">`,
        });
      }

      // 3.1.2 — Check for common foreign-language patterns without lang attribute
      // (Heuristic: elements containing English text on a German page, or vice versa)
      const pageLang = (htmlLang || '').substring(0, 2);
      if (pageLang === 'de') {
        // Look for obvious English blocks without lang="en"
        const blocks = document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote');
        const englishPatterns = /\b(privacy policy|terms of service|cookie policy|disclaimer|copyright|all rights reserved|powered by|sign up|log in|subscribe|newsletter)\b/i;
        for (let i = 0; i < blocks.length && issues.length < 10; i++) {
          const text = blocks[i].textContent?.trim();
          if (text && englishPatterns.test(text) && !blocks[i].closest('[lang="en"]') && !blocks[i].lang) {
            issues.push({
              type: 'missing-lang-part',
              message: `Fremdsprachiger Text ohne lang-Attribut: "${text.substring(0, 100)}"`,
              selector: blocks[i].tagName.toLowerCase() + (blocks[i].className ? '.' + blocks[i].className.toString().trim().split(/\s+/)[0] : ''),
              html: blocks[i].outerHTML.substring(0, 300),
            });
          }
        }
      }

      return issues;
    });

    if (result.length === 0) return null;

    return {
      rule: 'html-lang',
      engine: 'custom',
      severity: result.some(r => r.type === 'missing-lang') ? 'critical' : 'moderate',
      wcag: '3.1.1 / 3.1.2',
      wcagTags: ['wcag311', 'wcag312'],
      description: `${result.length} Sprach-Problem(e): ${result.map(r => r.type).join(', ')}`,
      nodes: result.map(r => ({
        selector: r.selector,
        html: r.html,
        failureSummary: r.message,
      })),
    };
  } catch (err) {
    console.log(`    Language test error: ${err.message}`);
    return null;
  }
}

// 2.4.2 Page Title — unique and descriptive
async function testPageTitle(page, allTitles) {
  try {
    const title = await page.title();
    const issues = [];

    if (!title || title.trim() === '') {
      issues.push({
        selector: 'head > title',
        html: '<title></title>',
        failureSummary: 'Seite hat keinen Titel',
      });
    } else if (allTitles && allTitles.filter(t => t === title).length > 1) {
      issues.push({
        selector: 'head > title',
        html: `<title>${title}</title>`,
        failureSummary: `Identischer Seitentitel auf mehreren Seiten: "${title}"`,
      });
    }

    if (issues.length === 0) return { title, issue: null };

    return {
      title,
      issue: {
        rule: 'page-title-unique',
        engine: 'custom',
        severity: 'moderate',
        wcag: '2.4.2',
        wcagTags: ['wcag242'],
        description: 'Seitentitel fehlt oder ist nicht eindeutig',
        nodes: issues,
      },
    };
  } catch {
    return { title: '', issue: null };
  }
}

// 1.3.1 Heading Hierarchy — Pruefe auf Spruenge (h1 -> h3 etc.)
async function testHeadingHierarchy(page) {
  try {
    const result = await page.evaluate(() => {
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const issues = [];
      let lastLevel = 0;

      for (const h of headings) {
        const level = parseInt(h.tagName[1]);
        // Skip if heading is hidden
        const rect = h.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        if (lastLevel > 0 && level > lastLevel + 1) {
          issues.push({
            selector: h.tagName.toLowerCase() + (h.id ? '#' + h.id : ''),
            html: h.outerHTML.substring(0, 300),
            failureSummary: `Ueberschriften-Hierarchie springt von h${lastLevel} zu h${level} (h${lastLevel + 1} uebersprungen)`,
            from: lastLevel,
            to: level,
          });
        }
        lastLevel = level;
      }

      // Check for missing h1
      const h1Count = document.querySelectorAll('h1').length;
      if (h1Count === 0) {
        issues.unshift({
          selector: 'body',
          html: '<body> (kein h1 gefunden)',
          failureSummary: 'Seite hat keine h1-Ueberschrift',
          from: 0,
          to: 0,
        });
      } else if (h1Count > 1) {
        issues.unshift({
          selector: 'h1',
          html: `${h1Count}x <h1> auf der Seite`,
          failureSummary: `Mehrere h1-Ueberschriften (${h1Count}x) — es sollte nur eine geben`,
          from: 0,
          to: 0,
        });
      }

      return issues;
    });

    if (result.length === 0) return null;

    return {
      rule: 'heading-hierarchy',
      engine: 'custom',
      severity: 'moderate',
      wcag: '1.3.1',
      wcagTags: ['wcag131'],
      description: `${result.length} Problem(e) in der Ueberschriften-Hierarchie`,
      nodes: result,
    };
  } catch (err) {
    console.log(`    Heading hierarchy test error: ${err.message}`);
    return null;
  }
}

// 1.1.1 (heuristic) Suspicious alt text - likely filename/placeholders
async function testSuspiciousAltText(page) {
  try {
    const suspicious = await page.evaluate(() => {
      const placeholderWords = new Set([
        'bild', 'image', 'photo', 'grafik', 'picture', 'img',
      ]);
      const extensionPattern = /\.(jpg|jpeg|png|gif|webp|svg)(\?|#|$)/i;
      const results = [];

      const images = document.querySelectorAll('img[alt]');
      for (let i = 0; i < images.length && results.length < 40; i++) {
        const img = images[i];
        const altRaw = img.getAttribute('alt') || '';
        const alt = altRaw.trim();
        if (!alt) continue; // empty alt can be intentional for decorative images

        const srcRaw = (img.getAttribute('src') || '').trim();
        const altLower = alt.toLowerCase();

        const looksLikeFilename = extensionPattern.test(altLower);
        const matchesSrc = srcRaw !== '' && altLower === srcRaw.toLowerCase();
        const isPlaceholder = placeholderWords.has(altLower);

        if (looksLikeFilename || matchesSrc || isPlaceholder) {
          const id = img.id ? '#' + img.id : '';
          const cls = img.className ? '.' + img.className.toString().trim().split(/\s+/)[0] : '';
          results.push({
            selector: `img${id}${cls}`,
            html: img.outerHTML.substring(0, 300),
            alt,
          });
        }
      }

      return results;
    });

    if (suspicious.length === 0) return null;

    return {
      rule: 'suspicious-alt-text',
      engine: 'custom',
      severity: 'moderate',
      wcag: '1.1.1',
      wcagTags: ['wcag111'],
      description: `${suspicious.length} Bild(er) mit potenziell nichtssagendem Alternativtext`,
      nodes: suspicious.map(s => ({
        selector: s.selector,
        html: s.html,
        failureSummary: `Das Alternativattribut wirkt nicht aussagekraeftig ("${s.alt}"). Es koennte ein Dateiname oder Platzhalter sein.`,
      })),
    };
  } catch (err) {
    console.log(`    Suspicious alt test error: ${err.message}`);
    return null;
  }
}

// 1.3.1 / 3.3.2 (heuristic) Labels with "for" that points to no existing input id
async function testOrphanedLabels(page) {
  try {
    const orphaned = await page.evaluate(() => {
      const results = [];
      const labels = document.querySelectorAll('label[for]');

      for (let i = 0; i < labels.length && results.length < 50; i++) {
        const label = labels[i];
        const forValue = (label.getAttribute('for') || '').trim();
        if (!forValue || document.getElementById(forValue) === null) {
          const id = label.id ? '#' + label.id : '';
          const cls = label.className ? '.' + label.className.toString().trim().split(/\s+/)[0] : '';
          results.push({
            selector: `label${id}${cls}`,
            html: label.outerHTML.substring(0, 300),
            forValue,
          });
        }
      }

      return results;
    });

    if (orphaned.length === 0) return null;

    return {
      rule: 'orphaned-label',
      engine: 'custom',
      severity: 'serious',
      wcag: '1.3.1 / 3.3.2',
      wcagTags: ['wcag131', 'wcag332'],
      description: `${orphaned.length} Label(s) ohne gueltige Zuordnung zu einem Formularelement`,
      nodes: orphaned.map(o => ({
        selector: o.selector,
        html: o.html,
        failureSummary: `Das Label verweist mit for="${o.forValue || '(leer)'}" auf kein existierendes Formularelement.`,
      })),
    };
  } catch (err) {
    console.log(`    Orphaned label test error: ${err.message}`);
    return null;
  }
}

// Best practice: avoid justified paragraph text due to readability concerns
async function testJustifiedText(page) {
  try {
    const justified = await page.evaluate(() => {
      const results = [];
      const candidates = document.querySelectorAll('p, div, article, section');

      for (let i = 0; i < candidates.length && results.length < 40; i++) {
        const el = candidates[i];
        const text = (el.textContent || '').trim();
        if (text.length < 40) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const style = window.getComputedStyle(el);
        if (style.textAlign === 'justify') {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + el.className.toString().trim().split(/\s+/)[0] : '';
          results.push({
            selector: `${tag}${id}${cls}`,
            html: el.outerHTML.substring(0, 300),
          });
        }
      }

      return results;
    });

    if (justified.length === 0) return null;

    return {
      rule: 'justified-text',
      engine: 'custom',
      severity: 'minor',
      description: `${justified.length} Textelement(e) mit Blocksatz (text-align: justify)`,
      nodes: justified.map(j => ({
        selector: j.selector,
        html: j.html,
        failureSummary: 'Die Verwendung von Blocksatz (text-align: justify) kann die Lesbarkeit beeintraechtigen und sollte vermieden werden.',
      })),
    };
  } catch (err) {
    console.log(`    Justified text test error: ${err.message}`);
    return null;
  }
}

// Heuristic: adjacent sibling links with same href and same visible text
async function testRedundantLinks(page) {
  try {
    const redundant = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href]');

      for (let i = 0; i < links.length && results.length < 50; i++) {
        const link = links[i];
        const next = link.nextElementSibling;
        if (!next || next.tagName.toLowerCase() !== 'a') continue;

        const nextLink = next;
        const hrefA = (link.href || '').trim();
        const hrefB = (nextLink.href || '').trim();
        if (!hrefA || hrefA !== hrefB) continue;

        const textA = (link.textContent || '').replace(/\s+/g, ' ').trim();
        const textB = (nextLink.textContent || '').replace(/\s+/g, ' ').trim();
        if (!textA || textA !== textB) continue;

        const id = nextLink.id ? '#' + nextLink.id : '';
        const cls = nextLink.className ? '.' + nextLink.className.toString().trim().split(/\s+/)[0] : '';
        results.push({
          selector: `a${id}${cls}`,
          html: nextLink.outerHTML.substring(0, 300),
          text: textB,
          href: hrefB,
        });
      }

      return results;
    });

    if (redundant.length === 0) return null;

    return {
      rule: 'redundant-link',
      engine: 'custom',
      severity: 'moderate',
      description: `${redundant.length} redundante, direkt aufeinanderfolgende Links erkannt`,
      nodes: redundant.map(r => ({
        selector: r.selector,
        html: r.html,
        failureSummary: `Redundanter Link: Ziel "${r.href}" und Linktext "${r.text}" wiederholen den unmittelbar vorherigen Link.`,
      })),
    };
  } catch (err) {
    console.log(`    Redundant link test error: ${err.message}`);
    return null;
  }
}

// ============================================================
// COMBINED PAGE SCANNER
// ============================================================
async function scanPage(page, url, allTitles) {
  console.log(`    [axe-core] Scanning...`);
  const { violations: axeViolations, incomplete: axeIncomplete } = await scanPageAxe(page, url);

  console.log(`    [HTMLCS] Scanning...`);
  // Page is already loaded from axe scan, no need to navigate again
  const htmlcsIssues = await scanPageHTMLCS(page);
  const uniqueHtmlcs = deduplicateIssues(axeViolations, htmlcsIssues);

  console.log(`    [Custom] Focus, Headings, Language, Animations...`);
  const customIssues = [];

  const focusResult = await testFocusIndicators(page);
  if (focusResult) customIssues.push(focusResult);

  const keyboardTrapResult = await testKeyboardTraps(page);
  if (keyboardTrapResult) customIssues.push(keyboardTrapResult);

  const headingResult = await testHeadingHierarchy(page);
  if (headingResult) customIssues.push(headingResult);

  const langResult = await testLanguage(page);
  if (langResult) customIssues.push(langResult);

  const animResult = await testAnimations(page);
  if (animResult) customIssues.push(animResult);

  const textSpacingResult = await testTextSpacing(page);
  if (textSpacingResult) customIssues.push(textSpacingResult);

  const { title, issue: titleIssue } = await testPageTitle(page, allTitles);
  if (titleIssue) customIssues.push(titleIssue);

  const suspiciousAltResult = await testSuspiciousAltText(page);
  if (suspiciousAltResult) customIssues.push(suspiciousAltResult);

  const orphanedLabelsResult = await testOrphanedLabels(page);
  if (orphanedLabelsResult) customIssues.push(orphanedLabelsResult);

  const justifiedTextResult = await testJustifiedText(page);
  if (justifiedTextResult) customIssues.push(justifiedTextResult);

  const redundantLinksResult = await testRedundantLinks(page);
  if (redundantLinksResult) customIssues.push(redundantLinksResult);

  // Merge all issues
  const allIssues = [
    ...axeViolations,
    ...uniqueHtmlcs,
    ...customIssues,
  ];

  return {
    issues: allIssues,
    incomplete: axeIncomplete,
    title,
    engineStats: {
      axe: axeViolations.length,
      htmlcs: uniqueHtmlcs.length,
      custom: customIssues.length,
    },
  };
}

// --- Compliance Score ---
function calculateScore(pages) {
  let totalWeighted = 0;
  for (const p of pages) {
    for (const issue of p.issues) {
      const nodeCount = issue.nodes?.length || 1;
      const weight = SEVERITY_WEIGHTS[issue.severity] || 1;
      totalWeighted += weight * nodeCount;
    }
  }
  return Math.max(0, 100 - totalWeighted);
}

// --- Main ---
export async function scan({ url, maxPages = DEFAULT_MAX_PAGES, auth = null, loginUrl = null, urlListFile = null }) {
  const mode = auth ? 'authenticated' : 'public';
  console.log(`\n  Scanning: ${url} (max ${maxPages} pages, mode: ${mode})\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'GreenOnion-A11y-Scanner/2.0',
  });
  const page = await context.newPage();

  // Step 0: Login if credentials provided
  if (auth) {
    const effectiveLoginUrl = loginUrl || new URL('/login', url).href;
    const loggedIn = await performLogin(page, effectiveLoginUrl, auth);
    if (!loggedIn) {
      console.log('  Continuing anyway — some pages may require auth\n');
    }
  }

  // Step 1: Discover URLs
  let urls;
  if (urlListFile) {
    console.log(`  Loading URLs from: ${urlListFile}`);
    urls = loadUrlList(urlListFile, url);
    console.log(`  Loaded ${urls.length} URLs`);
  } else {
    console.log('  Fetching sitemap...');
    urls = await fetchSitemap(url);
    if (urls.length > 0) {
      console.log(`  Found ${urls.length} URLs in sitemap`);
    } else {
      console.log('  No sitemap found, crawling links...');
      urls = await crawlLinks(page, url, maxPages);
      console.log(`  Crawled ${urls.length} URLs`);
    }
  }

  urls = urls.slice(0, maxPages);

  // Step 2: First pass — collect all page titles for duplicate detection
  console.log('\n  Phase 1: Collecting page titles...');
  const allTitles = [];
  for (const pageUrl of urls) {
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      allTitles.push(await page.title());
    } catch {
      allTitles.push('');
    }
  }

  // Step 3: Full scan per page (axe + HTMLCS + custom)
  console.log('\n  Phase 2: Full accessibility scan...\n');
  const pages = [];
  let totalIssues = 0;
  let totalIncomplete = 0;
  const engineTotals = { axe: 0, htmlcs: 0, custom: 0 };

  for (let i = 0; i < urls.length; i++) {
    const pageUrl = urls[i];
    console.log(`  [${i + 1}/${urls.length}] ${pageUrl}`);

    const result = await scanPage(page, pageUrl, allTitles);
    const issueCount = result.issues.reduce((sum, iss) => sum + (iss.nodes?.length || 1), 0);
    const incompleteCount = result.incomplete.reduce((sum, iss) => sum + (iss.nodes?.length || 1), 0);

    totalIssues += issueCount;
    totalIncomplete += incompleteCount;
    engineTotals.axe += result.engineStats.axe;
    engineTotals.htmlcs += result.engineStats.htmlcs;
    engineTotals.custom += result.engineStats.custom;

    pages.push({
      url: pageUrl,
      title: result.title,
      issues: result.issues,
      incomplete: result.incomplete,
      issueCount,
      incompleteCount,
      engineStats: result.engineStats,
    });

    console.log(`    => ${issueCount} violations, ${incompleteCount} needs-review (axe:${result.engineStats.axe} htmlcs:${result.engineStats.htmlcs} custom:${result.engineStats.custom})`);
  }

  // Step 4: Reflow test (separate pass, changes viewport)
  console.log('\n  Phase 3: Reflow-Test (320px)...\n');
  for (let i = 0; i < urls.length; i++) {
    const reflowResult = await testReflow(page, urls[i]);
    if (reflowResult) {
      pages[i].issues.push(reflowResult);
      const nodeCount = reflowResult.nodes?.length || 1;
      pages[i].issueCount += nodeCount;
      totalIssues += nodeCount;
      engineTotals.custom++;
      console.log(`  [${i + 1}/${urls.length}] ${urls[i]} => ${nodeCount} Reflow-Probleme`);
    }
  }

  await browser.close();

  // Step 5: Calculate score
  const score = calculateScore(pages);

  const result = {
    url,
    scannedAt: new Date().toISOString(),
    scannerVersion: '2.0',
    mode,
    engines: ['axe-core (iframes+shadowDom)', 'HTML_CodeSniffer (WCAG2AA)', 'GreenOnion Custom Checks'],
    pagesScanned: pages.length,
    totalIssues,
    totalNeedsReview: totalIncomplete,
    engineBreakdown: engineTotals,
    score,
    pages,
  };

  console.log(`\n  Scan complete: ${pages.length} pages`);
  console.log(`  Violations: ${totalIssues} (axe:${engineTotals.axe} rules, htmlcs:${engineTotals.htmlcs} unique, custom:${engineTotals.custom})`);
  console.log(`  Needs Review: ${totalIncomplete}`);
  console.log(`  Score: ${score}/100\n`);

  return result;
}

// --- CLI Argument Parser ---
function parseArgs(argv) {
  const opts = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      opts._positional.push(arg);
    }
  }
  return opts;
}

// --- CLI ---
const __isCLI = process.argv[1] &&
  (process.argv[1].endsWith('scanner.js') || process.argv[1].endsWith('scanner'));
if (__isCLI) {
  const args = parseArgs(process.argv.slice(2));

  if (args._positional.length === 0 && !args.url) {
    console.log(`Usage: node scanner.js <url> [maxPages]

GreenOnion A11y Scanner v2.0
Engines: axe-core + HTML_CodeSniffer + Custom Checks

Public scan:
  node scanner.js https://example.com 30

Authenticated scan:
  node scanner.js https://example.com --user email@test.com --pass secret123
  node scanner.js https://example.com --user email@test.com --pass secret123 --login-url https://example.com/login.php

With custom URL list:
  node scanner.js https://example.com --urls urls.txt
  node scanner.js https://example.com --urls urls.txt --user email@test.com --pass secret123

Auth with custom selectors:
  node scanner.js https://example.com --user test --pass test \\
    --user-selector "#email" --pass-selector "#password" --submit-selector ".login-btn"

URL list file format (one per line, # for comments):
  /
  /login
  /dashboard
  /profil
  https://example.com/custom-page`);
    process.exit(1);
  }

  const targetUrl = args.url || args._positional[0];
  const maxPages = parseInt(args['max-pages'] || args._positional[1]) || DEFAULT_MAX_PAGES;

  let auth = null;
  if (args.user && args.pass) {
    auth = {
      username: args.user,
      password: args.pass,
      userSelector: args['user-selector'] || null,
      passSelector: args['pass-selector'] || null,
      submitSelector: args['submit-selector'] || null,
    };
  }

  const loginUrl = args['login-url'] || null;
  const urlListFile = args.urls || null;

  if (urlListFile && !existsSync(urlListFile)) {
    console.error(`URL list file not found: ${urlListFile}`);
    process.exit(1);
  }

  const result = await scan({ url: targetUrl, maxPages, auth, loginUrl, urlListFile });

  // Write JSON output
  const outputFile = `scan_${new URL(targetUrl).hostname}_${Date.now()}.json`;
  writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(`  Results saved to: ${outputFile}`);
}
