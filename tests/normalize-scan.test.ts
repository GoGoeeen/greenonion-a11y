/**
 * Tests fuer die Normalizer-Logik der Scan-Pipeline (Phase A).
 *
 * Abgedeckt:
 * - ID-Generatoren (Deterministik, Kollisionsfreiheit)
 * - WCAG-Normalisierer (alle drei Eingabeformate)
 * - Locator-Builder (CSS, XPath, ARIA, testid, text)
 * - Page-Classifier (URL-Patterns, Title-Fallback)
 * - Component-Classifier (Regel-Map, HTML-Tag-Analyse)
 * - SR-Classifier (bekannte / unbekannte Rules, LLM-Agent)
 * - normalizeScan Smoke-Test (Bundle-Struktur, keine Exceptions)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateFindingId, generateInstanceId, generateScenarioId } from '../src/normalize/id-generators.js';
import { normalizeWcagSc } from '../src/normalize/wcag-normalizer.js';
import { buildLocators } from '../src/normalize/locator-builder.js';
import { classifyPageType } from '../src/normalize/page-classifier.js';
import { classifyComponentType } from '../src/normalize/component-classifier.js';
import { classifySrRelevance } from '../src/normalize/sr-classifier.js';
import { normalizeScan } from '../src/normalize/normalize-scan.js';

// ---------------------------------------------------------------------------
// ID-Generatoren
// ---------------------------------------------------------------------------

describe('generateFindingId', () => {
  test('gibt deterministisches Ergebnis bei gleichen Eingaben', () => {
    const id1 = generateFindingId('label', 'example.com', 'critical');
    const id2 = generateFindingId('label', 'example.com', 'critical');
    assert.equal(id1, id2);
  });

  test('unterschiedliche rule_id erzeugt unterschiedliche IDs', () => {
    const id1 = generateFindingId('label', 'example.com', 'critical');
    const id2 = generateFindingId('button-name', 'example.com', 'critical');
    assert.notEqual(id1, id2);
  });

  test('unterschiedliche domains erzeugen unterschiedliche IDs', () => {
    const id1 = generateFindingId('label', 'example.com', 'critical');
    const id2 = generateFindingId('label', 'other.com', 'critical');
    assert.notEqual(id1, id2);
  });

  test('www. Prefix wird normiert', () => {
    const id1 = generateFindingId('label', 'example.com', 'critical');
    const id2 = generateFindingId('label', 'www.example.com', 'critical');
    assert.equal(id1, id2);
  });

  test('Prefix ist find-', () => {
    const id = generateFindingId('label', 'example.com', 'critical');
    assert.match(id, /^find-[0-9a-f]{12}$/);
  });
});

describe('generateInstanceId', () => {
  test('deterministisch bei gleichen Eingaben', () => {
    const id1 = generateInstanceId('label', 'https://example.com/page', '#email');
    const id2 = generateInstanceId('label', 'https://example.com/page', '#email');
    assert.equal(id1, id2);
  });

  test('unterschiedliche Selektoren erzeugen unterschiedliche IDs', () => {
    const id1 = generateInstanceId('label', 'https://example.com/page', '#email');
    const id2 = generateInstanceId('label', 'https://example.com/page', '#name');
    assert.notEqual(id1, id2);
  });

  test('unterschiedliche Pages erzeugen unterschiedliche IDs', () => {
    const id1 = generateInstanceId('label', 'https://example.com/page1', '#email');
    const id2 = generateInstanceId('label', 'https://example.com/page2', '#email');
    assert.notEqual(id1, id2);
  });

  test('Query-Parameter und Fragment werden fuer Stabilitaet ignoriert', () => {
    const id1 = generateInstanceId('label', 'https://example.com/page', '#email');
    const id2 = generateInstanceId('label', 'https://example.com/page?foo=bar#section', '#email');
    assert.equal(id1, id2);
  });

  test('Prefix ist inst-', () => {
    const id = generateInstanceId('label', 'https://example.com', '#email');
    assert.match(id, /^inst-[0-9a-f]{12}$/);
  });
});

describe('generateScenarioId', () => {
  test('inst- wird zu scn-', () => {
    const instanceId = 'inst-abc123def456';
    const scenarioId = generateScenarioId(instanceId);
    assert.equal(scenarioId, 'scn-abc123def456');
  });
});

// ---------------------------------------------------------------------------
// WCAG-Normalisierer
// ---------------------------------------------------------------------------

describe('normalizeWcagSc', () => {
  test('verarbeitet wcag_criteria Array korrekt', () => {
    const result = normalizeWcagSc({ wcag_criteria: ['1.1.1', '2.4.2'] });
    assert.deepEqual(result, ['1.1.1', '2.4.2']);
  });

  test('verarbeitet axe wcagTags korrekt', () => {
    const result = normalizeWcagSc({ wcagTags: ['wcag111', 'wcag242'] });
    assert.deepEqual(result, ['1.1.1', '2.4.2']);
  });

  test('verarbeitet slash-separierte wcag Strings', () => {
    const result = normalizeWcagSc({ wcag: '1.3.1 / 3.3.2' });
    assert.deepEqual(result, ['1.3.1', '3.3.2']);
  });

  test('verarbeitet HTMLCS-Code korrekt', () => {
    const result = normalizeWcagSc({
      htmlcsCode: 'WCAG2AA.Principle1.Guideline1_1.1_1_1.H37',
    });
    assert.deepEqual(result, ['1.1.1']);
  });

  test('dedupliziert gleiche SCs aus verschiedenen Quellen', () => {
    const result = normalizeWcagSc({
      wcag_criteria: ['1.1.1'],
      wcagTags: ['wcag111'],
      wcag: '1.1.1',
    });
    assert.deepEqual(result, ['1.1.1']);
  });

  test('ignoriert Non-SC axe-Tags wie wcag2a, wcag21', () => {
    const result = normalizeWcagSc({ wcagTags: ['wcag2a', 'wcag21', 'wcag111'] });
    assert.deepEqual(result, ['1.1.1']);
  });

  test('gibt leeres Array bei leerem Input zurueck', () => {
    const result = normalizeWcagSc({});
    assert.deepEqual(result, []);
  });

  test('sortiert Ergebnis', () => {
    const result = normalizeWcagSc({ wcag: '2.4.2 / 1.1.1 / 1.3.1' });
    assert.deepEqual(result, ['1.1.1', '1.3.1', '2.4.2']);
  });
});

// ---------------------------------------------------------------------------
// Locator-Builder
// ---------------------------------------------------------------------------

describe('buildLocators', () => {
  test('setzt CSS-Selektor als primaeren Locator', () => {
    const { primary } = buildLocators('#email', '<input id="email">');
    assert.equal(primary.type, 'css');
    assert.equal(primary.value, '#email');
  });

  test('erzeugt XPath-Fallback fuer ID-Selektor', () => {
    const { fallbacks } = buildLocators('#email', '<input id="email">');
    const xpath = fallbacks.find(f => f.type === 'xpath');
    assert.ok(xpath, 'XPath-Fallback fehlt');
    assert.equal(xpath.value, '//*[@id="email"]');
  });

  test('erzeugt XPath fuer Tag+ID Selektor', () => {
    const { fallbacks } = buildLocators('input#email', '');
    const xpath = fallbacks.find(f => f.type === 'xpath');
    assert.ok(xpath, 'XPath-Fallback fehlt');
    assert.equal(xpath.value, '//input[@id="email"]');
  });

  test('extrahiert aria-label als Fallback', () => {
    const { fallbacks } = buildLocators('button', '<button aria-label="Senden">OK</button>');
    const aria = fallbacks.find(f => f.type === 'aria');
    assert.ok(aria, 'ARIA-Fallback fehlt');
    assert.match(aria.value, /Senden/);
  });

  test('extrahiert data-testid als Fallback', () => {
    const { fallbacks } = buildLocators('button', '<button data-testid="submit-btn">OK</button>');
    const testid = fallbacks.find(f => f.type === 'testid');
    assert.ok(testid, 'testid-Fallback fehlt');
    assert.equal(testid.value, 'submit-btn');
  });

  test('kein XPath-Fallback fuer komplexe CSS-Selektoren', () => {
    const { fallbacks } = buildLocators('nav > ul > li:nth-child(2) > a', '');
    const xpath = fallbacks.find(f => f.type === 'xpath');
    assert.equal(xpath, undefined, 'Kein XPath fuer komplexe Selektoren erwartet');
  });

  test('leerer Selektor und leeres HTML → nur leerer CSS Primary', () => {
    const { primary, fallbacks } = buildLocators('', '');
    assert.equal(primary.type, 'css');
    assert.equal(primary.value, '');
    assert.equal(fallbacks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Page-Classifier
// ---------------------------------------------------------------------------

describe('classifyPageType', () => {
  const cases: Array<[string, string]> = [
    ['https://example.com/', 'home'],
    ['https://example.com/login', 'login'],
    ['https://example.com/anmelden', 'login'],
    ['https://example.com/register', 'register'],
    ['https://example.com/checkout', 'checkout'],
    ['https://example.com/warenkorb', 'checkout'],
    ['https://example.com/dashboard', 'dashboard'],
    ['https://example.com/kontakt', 'contact'],
    ['https://example.com/impressum', 'legal'],
    ['https://example.com/datenschutz', 'legal'],
    ['https://example.com/blog/artikel-title', 'article'],
    ['https://example.com/produkte', 'listing'],
    ['https://example.com/search?q=test', 'search'],
    ['https://example.com/profil', 'profile'],
    ['https://example.com/unbekannte-seite', 'unknown'],
  ];

  for (const [url, expectedType] of cases) {
    test(`${url} → ${expectedType}`, () => {
      const result = classifyPageType(url);
      assert.equal(result.page_type, expectedType);
      assert.equal(result.heuristic, true);
    });
  }

  test('Title-Fallback fuer unbekannte URL', () => {
    const result = classifyPageType('https://example.com/xyz', 'Anmelden – Mein Konto');
    assert.equal(result.page_type, 'login');
  });
});

// ---------------------------------------------------------------------------
// Component-Classifier
// ---------------------------------------------------------------------------

describe('classifyComponentType', () => {
  test('label → text_input', () => {
    const result = classifyComponentType('label', '');
    assert.equal(result.component_type, 'text_input');
    assert.equal(result.heuristic, true);
  });

  test('button-name → button', () => {
    const result = classifyComponentType('button-name', '');
    assert.equal(result.component_type, 'button');
  });

  test('link-name → link', () => {
    const result = classifyComponentType('link-name', '');
    assert.equal(result.component_type, 'link');
  });

  test('image-alt → image', () => {
    const result = classifyComponentType('image-alt', '');
    assert.equal(result.component_type, 'image');
  });

  test('heading-order → heading', () => {
    const result = classifyComponentType('heading-order', '');
    assert.equal(result.component_type, 'heading');
  });

  test('HTML-Tag-Fallback: <input type="email">', () => {
    const result = classifyComponentType('color-contrast', '<input type="email" value="test">');
    assert.equal(result.component_type, 'text_input');
  });

  test('HTML-Tag-Fallback: <button>', () => {
    const result = classifyComponentType('color-contrast', '<button type="submit">Senden</button>');
    assert.equal(result.component_type, 'button');
  });

  test('unbekannte Regel + kein HTML → unknown', () => {
    const result = classifyComponentType('some-unknown-rule', '');
    assert.equal(result.component_type, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// SR-Classifier
// ---------------------------------------------------------------------------

describe('classifySrRelevance', () => {
  test('label → sr_direct, nvda_candidate=true', () => {
    const result = classifySrRelevance('label');
    assert.equal(result.sr_relevance, 'sr_direct');
    assert.equal(result.nvda_candidate, true);
    assert.equal(result.retest_strategy, 'nvda_voice_assert');
    assert.equal(result.confidence, 'high');
  });

  test('color-contrast → sr_not_suitable, nvda_candidate=false', () => {
    const result = classifySrRelevance('color-contrast');
    assert.equal(result.sr_relevance, 'sr_not_suitable');
    assert.equal(result.nvda_candidate, false);
    assert.ok(result.manual_review_reason, 'Kein manual_review_reason fuer color-contrast');
  });

  test('heading-order → sr_indirect, nvda_candidate=false', () => {
    const result = classifySrRelevance('heading-order');
    assert.equal(result.sr_relevance, 'sr_indirect');
    assert.equal(result.nvda_candidate, false);
  });

  test('suspicious-alt-text → manual_only', () => {
    const result = classifySrRelevance('suspicious-alt-text');
    assert.equal(result.sr_relevance, 'manual_only');
    assert.equal(result.nvda_candidate, false);
    assert.equal(result.retest_strategy, 'manual');
  });

  test('LLM-Agent-Issues immer manual_only', () => {
    const result = classifySrRelevance('label', 'llm-agent');
    assert.equal(result.sr_relevance, 'manual_only');
    assert.equal(result.nvda_candidate, false);
  });

  test('unbekannte Regel → needs_flow_context, low confidence', () => {
    const result = classifySrRelevance('some-unknown-rule-xyz');
    assert.equal(result.sr_relevance, 'needs_flow_context');
    assert.equal(result.confidence, 'low');
    assert.ok(result.manual_review_reason);
  });
});

// ---------------------------------------------------------------------------
// normalizeScan — Smoke-Test
// ---------------------------------------------------------------------------

describe('normalizeScan', () => {
  const minimalScanResult = {
    url: 'https://example.com',
    scannedAt: '2026-04-12T10:00:00.000Z',
    scannerVersion: '2.0',
    mode: 'public',
    pagesScanned: 2,
    totalIssues: 3,
    score: 72,
    pages: [
      {
        url: 'https://example.com/',
        title: 'Startseite',
        issues: [
          {
            rule: 'label',
            engine: 'axe-core',
            severity: 'critical',
            description: 'Form elements must have labels',
            wcagTags: ['wcag131', 'wcag332'],
            nodes: [
              { selector: '#email', html: '<input id="email" type="email">', failureSummary: 'Fix: add label' },
              { selector: '#name', html: '<input id="name" type="text">', failureSummary: 'Fix: add label' },
            ],
          },
          {
            rule: 'color-contrast',
            engine: 'axe-core',
            severity: 'serious',
            wcagTags: ['wcag143'],
            nodes: [{ selector: 'p.teaser', html: '<p class="teaser">Text</p>' }],
          },
        ],
        incomplete: [
          {
            rule: 'image-alt',
            engine: 'axe-core',
            severity: 'critical',
            needsReview: true,
            nodes: [{ selector: 'img.logo', html: '<img class="logo" src="logo.png">' }],
          },
        ],
      },
      {
        url: 'https://example.com/kontakt',
        title: 'Kontakt',
        issues: [
          {
            rule: 'button-name',
            engine: 'htmlcs',
            severity: 'serious',
            htmlcsCode: 'WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.Button.Name',
            nodes: [{ selector: 'button.submit', html: '<button class="submit"></button>' }],
          },
        ],
      },
    ],
  };

  const findings = [
    { rule_id: 'label', severity: 'critical', element_count: 2 },
    { rule_id: 'color-contrast', severity: 'serious', element_count: 1 },
    { rule_id: 'button-name', severity: 'serious', element_count: 1 },
  ];

  const manualChecks = [
    {
      id: 'mc-suspicious-alt-111',
      rule: 'suspicious-alt-text',
      status: 'Needs Human Review',
      wcag: '1.1.1',
      wcag_criteria: ['1.1.1'],
      nodes: [{ url: 'https://example.com/', selector: 'img.hero', html: '<img class="hero" alt="bild">' }],
    },
  ];

  test('gibt NormalizedScanBundle ohne Exception zurueck', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    assert.ok(bundle, 'Bundle ist null oder undefined');
  });

  test('meta-Felder sind gesetzt', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    assert.equal(bundle.meta.domain, 'example.com');
    assert.equal(bundle.meta.scanner_version, '2.0');
    assert.equal(bundle.meta.bundle_version, '1.0-alpha');
    assert.match(bundle.meta.report_id, /^rpt-[0-9a-f]{16}$/);
  });

  test('finding_instances ist ein Array', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    assert.ok(Array.isArray(bundle.finding_instances));
    // 2 label-Nodes + 1 color-contrast + 1 image-alt incomplete + 1 button-name + 1 manual-check
    assert.ok(bundle.finding_instances.length > 0, 'finding_instances ist leer');
  });

  test('finding_instance hat alle Pflichtfelder', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    const inst = bundle.finding_instances[0];
    assert.ok(inst.instance_id.startsWith('inst-'), 'Ungueltige instance_id');
    assert.ok(inst.finding_id.startsWith('find-'), 'Ungueltige finding_id');
    assert.ok(inst.page_url, 'page_url fehlt');
    assert.ok(inst.rule_id, 'rule_id fehlt');
    assert.ok(inst.locator_primary, 'locator_primary fehlt');
    assert.equal(inst.locator_primary.type, 'css');
    assert.ok(Array.isArray(inst.wcag_sc), 'wcag_sc kein Array');
    assert.ok(['critical', 'serious', 'moderate', 'minor'].includes(inst.severity), 'Ungueltige Severity');
    assert.ok(inst._heuristics?.page_type, 'heuristics.page_type fehlt');
    assert.ok(inst._heuristics?.component_type, 'heuristics.component_type fehlt');
  });

  test('finding_id ist deterministisch (gleich bei zweitem Aufruf)', () => {
    const bundle1 = normalizeScan(minimalScanResult, findings, manualChecks);
    const bundle2 = normalizeScan(minimalScanResult, findings, manualChecks);
    const ids1 = bundle1.finding_instances.map(i => i.finding_id).sort();
    const ids2 = bundle2.finding_instances.map(i => i.finding_id).sort();
    assert.deepEqual(ids1, ids2);
  });

  test('automation_candidates enthaelt nur sr_direct und sr_indirect', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    for (const candidate of bundle.automation_candidates) {
      assert.notEqual(candidate.sr_relevance, 'sr_not_suitable', `Unerwarteter sr_not_suitable Kandidat: ${candidate.rule_id}`);
      assert.notEqual(candidate.sr_relevance, 'manual_only', `Unerwarteter manual_only Kandidat: ${candidate.rule_id}`);
    }
  });

  test('color-contrast ist kein automation_candidate', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    const hasContrast = bundle.automation_candidates.some(c => c.rule_id === 'color-contrast');
    assert.equal(hasContrast, false, 'color-contrast sollte kein Automation-Kandidat sein');
  });

  test('label-Finding hat nvda_candidate=true', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    const labelCandidate = bundle.automation_candidates.find(c => c.rule_id === 'label');
    assert.ok(labelCandidate, 'label-Kandidat fehlt in automation_candidates');
    assert.equal(labelCandidate.nvda_candidate, true);
    // Phase D: preconditions, action_sequence, expected_speech_tokens werden heuristisch befuellt
    assert.ok(Array.isArray(labelCandidate.preconditions), 'preconditions ist Array');
    assert.ok(Array.isArray(labelCandidate.action_sequence), 'action_sequence ist Array');
    assert.ok(Array.isArray(labelCandidate.expected_speech_tokens), 'expected_speech_tokens ist Array');
    assert.ok(labelCandidate.preconditions.includes('page_loaded'), 'Phase D: page_loaded in preconditions');
  });

  test('executive_summary ist plausibel', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    const es = bundle.executive_summary;
    assert.equal(es.score, 72);
    assert.ok(['critical', 'high', 'medium', 'low'].includes(es.risk_level));
    assert.ok(es.pages_scanned > 0);
    assert.ok(Array.isArray(es.top_wcag_areas));
  });

  test('page_type wird korrekt klassifiziert', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    const homepageInst = bundle.finding_instances.find(i => i.page_url === 'https://example.com/');
    const contactInst = bundle.finding_instances.find(i => i.page_url === 'https://example.com/kontakt');
    assert.equal(homepageInst?.page_type, 'home');
    assert.equal(contactInst?.page_type, 'contact');
  });

  test('wcag_sc wird aus wcagTags korrekt normiert', () => {
    const bundle = normalizeScan(minimalScanResult, findings, manualChecks);
    const labelInst = bundle.finding_instances.find(i => i.rule_id === 'label');
    assert.ok(labelInst, 'label instance fehlt');
    assert.ok(labelInst.wcag_sc.includes('1.3.1'), '1.3.1 fehlt in wcag_sc');
    assert.ok(labelInst.wcag_sc.includes('3.3.2'), '3.3.2 fehlt in wcag_sc');
  });
});
