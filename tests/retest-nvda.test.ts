/**
 * NVDA-Retest-Tests (Phase E).
 *
 * 1. Unit-Tests: evaluateSpeechTokens, buildRetestReport, ACTION_TO_NVDA_COMMAND
 * 2. Virtual-SR-Integration: runVirtualSrOnSnippet mit JSDOM
 *
 * DOM-Elemente werden via createElement/setAttribute aufgebaut.
 * Ausfuehren: node --import tsx/esm --test tests/retest-nvda.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { virtual } from '@guidepup/virtual-screen-reader';

import {
  evaluateSpeechTokens,
  createRetestResult,
  createErrorRetestResult,
  buildRetestReport,
  ACTION_TO_NVDA_COMMAND,
  runVirtualSrOnSnippet,
} from '../src/nvda/retest-runner.js';
import type { AutomationCandidate, RetestResult } from '../src/reporting/types.js';

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<AutomationCandidate> = {}): AutomationCandidate {
  return {
    finding_id:             'find-test-001',
    instance_id:            'inst-test-001',
    scenario_id:            'scn-test-001',
    nvda_candidate:         true,
    sr_relevance:           'sr_direct',
    page_url:               'https://example.com/',
    page_type:              'homepage',
    component_type:         'link',
    rule_id:                'link-name',
    wcag_sc:                ['2.4.4'],
    severity:               'serious',
    scan_source:            'axe-core',
    locator_primary:        { type: 'css', value: 'a' },
    locator_fallbacks:      [],
    dom_snapshot:           null,
    preconditions:          ['page_loaded'],
    action_sequence:        [
      { step: 1, action: 'open_page' },
      { step: 2, action: 'press_k', target: 'link' },
      { step: 3, action: 'nvda_listen' },
    ],
    expected_role_state:    ['link'],
    expected_speech_tokens: ['Beispiel-Link'],
    confidence:             'high',
    retest_strategy:        'nvda_voice_assert',
    ...overrides,
  };
}

/** Leert einen DOM-Container. */
function clearContainer(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------------------------------------------------------------------------
// Testgruppe 1: evaluateSpeechTokens
// ---------------------------------------------------------------------------

describe('evaluateSpeechTokens', () => {
  it('skipped wenn tokens leer', () => {
    const r = evaluateSpeechTokens('link, X', []);
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /expected_speech_tokens/);
  });

  it('passed bei Token-Match', () => {
    const r = evaluateSpeechTokens('link, Beispiel-Link', ['Beispiel-Link']);
    assert.equal(r.status, 'passed');
    assert.match(r.reason, /Beispiel-Link/);
  });

  it('passed bei case-insensitivem Match', () => {
    const r = evaluateSpeechTokens('link, BEISPIEL-LINK', ['beispiel-link']);
    assert.equal(r.status, 'passed');
  });

  it('passed wenn mindestens ein Token passt', () => {
    const r = evaluateSpeechTokens('link, Startseite', ['Startseite', 'Home']);
    assert.equal(r.status, 'passed');
    assert.match(r.reason, /Startseite/);
  });

  it('failed wenn spoken leer', () => {
    const r = evaluateSpeechTokens('', ['Beispiel-Link']);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /nichts gesprochen/);
  });

  it('failed wenn kein Token passt', () => {
    const r = evaluateSpeechTokens('button, Schliessen', ['Oeffnen', 'Starten']);
    assert.equal(r.status, 'failed');
  });

  it('failed mit Bug-Meldung wenn NVDA nur Strukturwoerter spricht (link-name ohne Name)', () => {
    const r = evaluateSpeechTokens('Link, fokussiert, verlinkt', ['greenonion.at/en', 'Asset-11-8']);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /kein zugaenglicher Name/);
    assert.match(r.reason, /Bug verifiziert/);
  });

  it('failed mit Bug-Meldung bei "Link, fokussiert, verlinkt, unsichtbar"', () => {
    const r = evaluateSpeechTokens('Link, fokussiert, verlinkt, unsichtbar', ['greenonion.at/it']);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /Bug verifiziert/);
  });

  it('normaler failed wenn spoken Inhalt enthaelt aber Token nicht passt', () => {
    // Phrase hat Inhalt "Startseite" aber Token "Homepage" passt nicht
    const r = evaluateSpeechTokens('Link, Startseite, fokussiert', ['Homepage']);
    assert.equal(r.status, 'failed');
    // Soll NICHT als "nur Strukturwoerter" behandelt werden
    assert.doesNotMatch(r.reason, /Bug verifiziert/);
  });
});

// ---------------------------------------------------------------------------
// Testgruppe 2: createRetestResult + createErrorRetestResult
// ---------------------------------------------------------------------------

describe('createRetestResult', () => {
  it('passed bei Token-Match', () => {
    const c = makeCandidate();
    const r = createRetestResult(c, 'link, Beispiel-Link', ['link, Beispiel-Link'], 123);
    assert.equal(r.status,      'passed');
    assert.equal(r.instance_id, 'inst-test-001');
    assert.equal(r.duration_ms, 123);
    assert.ok(r.tested_at.startsWith('20'));
  });

  it('skipped wenn tokens leer', () => {
    const c = makeCandidate({ expected_speech_tokens: [] });
    assert.equal(createRetestResult(c, 'irrelevant', [], 50).status, 'skipped');
  });

  it('failed wenn kein Match', () => {
    const c = makeCandidate({ expected_speech_tokens: ['Logo'] });
    assert.equal(createRetestResult(c, '', [], 50).status, 'failed');
  });

  it('error via createErrorRetestResult', () => {
    const r = createErrorRetestResult(makeCandidate(), 'Timeout', 999);
    assert.equal(r.status,         'error');
    assert.match(r.reason,         /Timeout/);
    assert.equal(r.spoken_phrase,  '');
    assert.deepEqual(r.spoken_log, []);
  });
});

// ---------------------------------------------------------------------------
// Testgruppe 3: buildRetestReport
// ---------------------------------------------------------------------------

describe('buildRetestReport', () => {
  it('aggregiert 4 Ergebnisse korrekt', () => {
    const c = makeCandidate();
    const results: RetestResult[] = [
      createRetestResult(c, 'link, Beispiel-Link', [], 100),
      createRetestResult({ ...c, instance_id: 'i2', expected_speech_tokens: [] }, '', [], 50),
      createRetestResult({ ...c, instance_id: 'i3', expected_speech_tokens: ['X'] }, '', [], 80),
      createErrorRetestResult({ ...c, instance_id: 'i4' }, 'Fehler', 10),
    ];
    const rpt = buildRetestReport(results, 'out.json', 'example.com', 'virtual-screen-reader');
    assert.equal(rpt.total_candidates, 4);
    assert.equal(rpt.passed,  1);
    assert.equal(rpt.skipped, 1);
    assert.equal(rpt.failed,  1);
    assert.equal(rpt.errors,  1);
    assert.equal(rpt.runner,  'virtual-screen-reader');
  });

  it('leerer Report', () => {
    const rpt = buildRetestReport([], 'x.json', 'example.com', 'nvda');
    assert.equal(rpt.total_candidates, 0);
    assert.equal(rpt.passed, 0);
  });
});

// ---------------------------------------------------------------------------
// Testgruppe 4: ACTION_TO_NVDA_COMMAND Vollstaendigkeit
// ---------------------------------------------------------------------------

describe('ACTION_TO_NVDA_COMMAND', () => {
  const required = [
    'press_k', 'press_tab', 'press_b', 'press_g', 'press_h',
    'press_d', 'press_insert_t', 'press_enter', 'press_t',
    'press_m', 'press_f', 'navigate_cells', 'nvda_listen', 'open_page',
  ];
  for (const a of required) {
    it(`hat Mapping fuer: ${a}`, () => assert.ok(a in ACTION_TO_NVDA_COMMAND, a));
  }
  it('press_k -> moveToNextLink',     () => assert.equal(ACTION_TO_NVDA_COMMAND['press_k'],        'moveToNextLink'));
  it('press_h -> moveToNextHeading',  () => assert.equal(ACTION_TO_NVDA_COMMAND['press_h'],        'moveToNextHeading'));
  it('press_insert_t -> reportTitle', () => assert.equal(ACTION_TO_NVDA_COMMAND['press_insert_t'], 'reportTitle'));
});

// ---------------------------------------------------------------------------
// Testgruppe 5: Virtual-SR-Integration mit JSDOM + DOM-API
// ---------------------------------------------------------------------------

describe('runVirtualSrOnSnippet', () => {
  let dom: JSDOM;
  let doc: Document;

  before(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
    doc = dom.window.document;
  });

  after(async () => {
    try { await virtual.stop(); } catch { /* ok */ }
  });

  it('liest Link-Name', async () => {
    const body = doc.body;
    clearContainer(body);
    const a = doc.createElement('a');
    a.href = 'https://greenonion.at';
    a.textContent = 'GreenOnion Startseite';
    body.appendChild(a);

    const { log } = await runVirtualSrOnSnippet(body, virtual, dom.window);
    assert.ok(log.some(p => p.toLowerCase().includes('greenonion startseite')),
      `Log: ${log.join(' | ')}`);
  });

  it('liest Bild-Alt-Text', async () => {
    const body = doc.body;
    clearContainer(body);
    const img = doc.createElement('img');
    img.src = 'logo.png';
    img.alt = 'GreenOnion Logo';
    body.appendChild(img);

    const { log } = await runVirtualSrOnSnippet(body, virtual, dom.window);
    assert.ok(log.some(p => p.toLowerCase().includes('greenonion logo')),
      `Log: ${log.join(' | ')}`);
  });

  it('liest Formularfeld-Label', async () => {
    const body = doc.body;
    clearContainer(body);

    const label = doc.createElement('label');
    label.setAttribute('for', 'em');
    label.textContent = 'E-Mail-Adresse';

    const input = doc.createElement('input');
    input.id = 'em';
    input.type = 'email';

    body.appendChild(label);
    body.appendChild(input);

    const { log } = await runVirtualSrOnSnippet(body, virtual, dom.window);
    assert.ok(log.some(p => p.toLowerCase().includes('e-mail-adresse')),
      `Log: ${log.join(' | ')}`);
  });

  it('leerer Link hat keinen nutzbaren Text', async () => {
    const body = doc.body;
    clearContainer(body);
    const a = doc.createElement('a');
    a.href = 'https://greenonion.at';
    // Kein textContent — entspricht echtem Fehler-Szenario (fehlender Link-Name)
    body.appendChild(a);

    const { log } = await runVirtualSrOnSnippet(body, virtual, dom.window);
    assert.equal(log.some(p => p.toLowerCase().includes('greenonion')), false,
      `Unerwarteter Text fuer leeren Link: ${log.join(' | ')}`);
  });

  it('Virtual-SR + evaluateSpeechTokens fuer Button', async () => {
    const body = doc.body;
    clearContainer(body);
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Jetzt starten';
    body.appendChild(btn);

    const { log } = await runVirtualSrOnSnippet(body, virtual, dom.window);
    const { status } = evaluateSpeechTokens(log.join(' '), ['Jetzt starten']);
    assert.equal(status, 'passed', `Log: ${log.join(' | ')}`);
  });
});
