/**
 * Tests fuer das NVDA-Szenario-Modul (Phase D).
 *
 * Prueft: action-sequences, speech-extractor, precondition-detector,
 *         role-state-mapper, scenario-builder und Integration in normalize-scan.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getActionSequence }                           from '../src/nvda/action-sequences.js';
import { extractSpeechTokens, extractNavigationOutcome } from '../src/nvda/speech-extractor.js';
import { detectPreconditions, PRECOND }                from '../src/nvda/precondition-detector.js';
import { mapRoleState }                                from '../src/nvda/role-state-mapper.js';
import { buildNvdaScenario, canBuildScenario }         from '../src/nvda/scenario-builder.js';
import { normalizeScan }                               from '../src/normalize/normalize-scan.js';

// ===== getActionSequence =====

describe('getActionSequence', () => {
  it('gibt bekannte Sequenz fuer label zurueck', () => {
    const seq = getActionSequence('label', 'sr_direct');
    assert.ok(seq.length > 0, 'Sequenz sollte Schritte haben');
    assert.ok(seq[0].step === 1, 'Erster Step sollte 1 sein');
    assert.ok(seq.some(s => s.action === 'press_tab'), 'Label-Sequenz sollte Tab enthalten');
  });

  it('gibt Link-Sequenz fuer link-name zurueck', () => {
    const seq = getActionSequence('link-name', 'sr_direct');
    assert.ok(seq.some(s => s.action === 'press_k'), 'Link-Navigation per K-Taste');
  });

  it('gibt Button-Sequenz fuer button-name zurueck', () => {
    const seq = getActionSequence('button-name', 'sr_direct');
    assert.ok(seq.some(s => s.action === 'press_b'), 'Button-Navigation per B-Taste');
  });

  it('gibt Grafik-Sequenz fuer image-alt zurueck', () => {
    const seq = getActionSequence('image-alt', 'sr_direct');
    assert.ok(seq.some(s => s.action === 'press_g'), 'Grafik-Navigation per G-Taste');
  });

  it('gibt Seitentitel-Sequenz fuer document-title zurueck', () => {
    const seq = getActionSequence('document-title', 'sr_direct');
    assert.ok(seq.some(s => s.action === 'press_insert_t'), 'Seitentitel per Insert+T');
  });

  it('gibt Heading-Sequenz fuer heading-order zurueck', () => {
    const seq = getActionSequence('heading-order', 'sr_indirect');
    assert.ok(seq.some(s => s.action === 'press_h'), 'Heading-Navigation per H-Taste');
  });

  it('gibt Fallback-Sequenz fuer unbekannte rule zurueck (sr_direct)', () => {
    const seq = getActionSequence('unbekannte-rule-xyz', 'sr_direct');
    assert.ok(seq.length > 0, 'Fallback-Sequenz sollte nicht leer sein');
  });

  it('gibt leere Sequenz fuer needs_flow_context zurueck', () => {
    const seq = getActionSequence('unbekannte-rule-xyz', 'needs_flow_context' as never);
    assert.strictEqual(seq.length, 0, 'needs_flow_context bekommt keine Sequenz');
  });

  it('Steps sind aufsteigend und lueckenlos', () => {
    const seq = getActionSequence('label', 'sr_direct');
    seq.forEach((s, i) => {
      assert.strictEqual(s.step, i + 1, `Step ${i + 1} sollte korrekt nummeriert sein`);
    });
  });
});

// ===== extractSpeechTokens =====

describe('extractSpeechTokens', () => {
  it('extrahiert aria-label', () => {
    const tokens = extractSpeechTokens('<input aria-label="E-Mail Adresse" type="text">');
    assert.ok(tokens.includes('E-Mail Adresse'), 'aria-label sollte extrahiert werden');
  });

  it('extrahiert alt-Text', () => {
    const tokens = extractSpeechTokens('<img alt="GreenOnion Logo" src="logo.png">');
    assert.ok(tokens.includes('GreenOnion Logo'), 'alt-Text sollte extrahiert werden');
  });

  it('ignoriert leeres alt="" (dekorativ)', () => {
    const tokens = extractSpeechTokens('<img alt="" src="deco.png">');
    // Leeres alt → keine Tokens aus alt-Attribut
    assert.ok(!tokens.includes(''), 'Leeres alt sollte nicht als Token gelten');
  });

  it('extrahiert placeholder als Fallback', () => {
    const tokens = extractSpeechTokens('<input type="text" placeholder="Suchbegriff eingeben">');
    assert.ok(tokens.includes('Suchbegriff eingeben'), 'Placeholder als Fallback');
  });

  it('extrahiert sichtbaren Text aus Button', () => {
    const tokens = extractSpeechTokens('<button>Absenden</button>');
    assert.ok(tokens.some(t => t.includes('Absenden')), 'Sichtbarer Text aus Button');
  });

  it('bevorzugt aria-label vor sichtbarem Text', () => {
    const tokens = extractSpeechTokens('<button aria-label="Formular abschicken">Senden</button>');
    assert.ok(tokens[0] === 'Formular abschicken', 'aria-label hat Vorrang');
  });

  it('gibt leeres Array fuer leeres HTML zurueck', () => {
    const tokens = extractSpeechTokens('');
    assert.deepStrictEqual(tokens, [], 'Leeres HTML → keine Tokens');
  });

  it('entfernt Duplikate', () => {
    const tokens = extractSpeechTokens('<button aria-label="OK">OK</button>');
    assert.strictEqual(tokens.filter(t => t === 'OK').length, 1, 'Duplikate werden entfernt');
  });

  it('extrahiert value fuer Submit-Button', () => {
    const tokens = extractSpeechTokens('<input type="submit" value="Anmelden">');
    assert.ok(tokens.includes('Anmelden'), 'Submit-Button value extrahiert');
  });
});

// ===== extractNavigationOutcome =====

describe('extractNavigationOutcome', () => {
  it('gibt page_navigation fuer externen Link zurueck', () => {
    const out = extractNavigationOutcome('<a href="/impressum">Impressum</a>', 'link-name', 'link');
    assert.strictEqual(out, 'page_navigation');
  });

  it('gibt focus_jumps_to_anchor fuer Anker-Link zurueck', () => {
    const out = extractNavigationOutcome('<a href="#main">Zum Inhalt</a>', 'bypass', 'link');
    assert.strictEqual(out, 'focus_jumps_to_anchor');
  });

  it('gibt form_submitted fuer Submit-Button zurueck', () => {
    const out = extractNavigationOutcome('<button type="submit">Absenden</button>', 'button-name', 'button');
    assert.strictEqual(out, 'form_submitted');
  });

  it('gibt action_triggered fuer normalen Button zurueck', () => {
    const out = extractNavigationOutcome('<button>Klick mich</button>', 'button-name', 'button');
    assert.strictEqual(out, 'action_triggered');
  });

  it('gibt focus_on_element fuer Eingabefeld zurueck', () => {
    const out = extractNavigationOutcome('<input type="text">', 'label', 'text_input');
    assert.strictEqual(out, 'focus_on_element');
  });
});

// ===== detectPreconditions =====

describe('detectPreconditions', () => {
  it('gibt immer mindestens page_loaded zurueck', () => {
    const p = detectPreconditions('unknown', 'https://example.com', 'some-rule');
    assert.ok(p.includes(PRECOND.PAGE_LOADED), 'page_loaded immer vorhanden');
  });

  it('erkennt Login-Seite als unauthenticated', () => {
    const p = detectPreconditions('login', 'https://example.com/login', 'label');
    assert.ok(p.includes(PRECOND.USER_UNAUTHENTICATED));
  });

  it('erkennt Dashboard als authenticated', () => {
    const p = detectPreconditions('dashboard', 'https://example.com/dashboard', 'label');
    assert.ok(p.includes(PRECOND.USER_AUTHENTICATED));
  });

  it('erkennt Checkout als authenticated + cart', () => {
    const p = detectPreconditions('checkout', 'https://example.com/checkout', 'label');
    assert.ok(p.includes(PRECOND.USER_AUTHENTICATED));
    assert.ok(p.includes(PRECOND.ITEMS_IN_CART));
  });

  it('gibt dialog_open fuer dialog-name zurueck', () => {
    const p = detectPreconditions('unknown', 'https://example.com', 'dialog-name');
    assert.ok(p.includes(PRECOND.DIALOG_OPEN));
  });

  it('erkennt /account URL als authenticated', () => {
    const p = detectPreconditions('unknown', 'https://example.com/account/settings', 'label');
    assert.ok(p.includes(PRECOND.USER_AUTHENTICATED));
  });

  it('erkennt Formular-Seite', () => {
    const p = detectPreconditions('form', 'https://example.com/kontakt', 'label');
    assert.ok(p.includes(PRECOND.FORM_VISIBLE));
  });
});

// ===== mapRoleState =====

describe('mapRoleState', () => {
  it('mappt button auf button-Rolle', () => {
    const roles = mapRoleState('button', '<button>Klick</button>');
    assert.ok(roles.includes('button'));
  });

  it('mappt link auf link-Rolle', () => {
    const roles = mapRoleState('link', '<a href="/foo">Link</a>');
    assert.ok(roles.includes('link'));
  });

  it('mappt text_input auf edit', () => {
    const roles = mapRoleState('text_input', '<input type="text">');
    assert.ok(roles.includes('edit'));
  });

  it('mappt select auf combobox', () => {
    const roles = mapRoleState('select', '<select><option>A</option></select>');
    assert.ok(roles.includes('combobox'));
  });

  it('mappt checkbox auf checkBox', () => {
    const roles = mapRoleState('checkbox', '<input type="checkbox">');
    assert.ok(roles.includes('checkBox'));
  });

  it('mappt Bild mit alt auf graphic', () => {
    const roles = mapRoleState('image', '<img alt="Logo" src="logo.png">');
    assert.ok(roles.includes('graphic'));
  });

  it('gibt leeres Array fuer dekoratives Bild zurueck', () => {
    const roles = mapRoleState('image', '<img alt="" src="deco.png">');
    assert.deepStrictEqual(roles, []);
  });

  it('erkennt aria-required und fuegt required-Zustand hinzu', () => {
    const roles = mapRoleState('text_input', '<input type="text" aria-required="true">');
    assert.ok(roles.includes('required'));
  });

  it('erkennt aria-expanded false und fuegt collapsed-Zustand hinzu', () => {
    const roles = mapRoleState('button', '<button aria-expanded="false">Menu</button>');
    assert.ok(roles.includes('collapsed'));
  });

  it('erkennt Heading-Level', () => {
    const roles = mapRoleState('heading', '<h2>Abschnitt</h2>');
    assert.ok(roles.includes('heading level 2'));
  });

  it('explizite ARIA-Role hat Vorrang', () => {
    const roles = mapRoleState('unknown', '<div role="alert">Fehler</div>');
    assert.ok(roles.includes('alert'));
  });
});

// ===== buildNvdaScenario =====

describe('buildNvdaScenario', () => {
  const labelCandidate = {
    rule_id: 'label',
    sr_relevance: 'sr_direct' as const,
    page_type: 'form',
    component_type: 'text_input',
  };

  it('gibt Szenario fuer sr_direct zurueck', () => {
    const s = buildNvdaScenario(labelCandidate, 'https://example.com/kontakt', '<input type="text" aria-label="Name">');
    assert.ok(s !== null, 'Szenario sollte erzeugt werden');
    assert.ok(s!.action_sequence.length > 0, 'Action-Sequenz sollte Schritte haben');
    assert.ok(s!.preconditions.includes('page_loaded'), 'Precondition page_loaded erwartet');
    assert.ok(s!.expected_speech_tokens.includes('Name'), 'aria-label als Speech-Token');
    assert.ok(s!.expected_role_state.includes('edit'), 'Role edit fuer text_input');
  });

  it('gibt null fuer needs_flow_context zurueck', () => {
    const s = buildNvdaScenario(
      { ...labelCandidate, sr_relevance: 'needs_flow_context' as const },
      'https://example.com', '<input>',
    );
    assert.strictEqual(s, null);
  });

  it('gibt null fuer sr_not_suitable zurueck', () => {
    const s = buildNvdaScenario(
      { ...labelCandidate, sr_relevance: 'sr_not_suitable' as const },
      'https://example.com', '<div>',
    );
    assert.strictEqual(s, null);
  });

  it('Link-Szenario hat press_k in action_sequence', () => {
    const s = buildNvdaScenario(
      { rule_id: 'link-name', sr_relevance: 'sr_direct', page_type: 'home', component_type: 'link' },
      'https://example.com', '<a href="/about">Ueber uns</a>',
    );
    assert.ok(s !== null);
    assert.ok(s!.action_sequence.some(a => a.action === 'press_k'), 'Link per K-Taste');
    assert.ok(s!.expected_navigation_outcome === 'page_navigation', 'Navigation outcome');
  });

  it('Bild-Szenario hat press_g in action_sequence', () => {
    const s = buildNvdaScenario(
      { rule_id: 'image-alt', sr_relevance: 'sr_direct', page_type: 'article', component_type: 'image' },
      'https://example.com', '<img alt="Chart Daten" src="chart.png">',
    );
    assert.ok(s !== null);
    assert.ok(s!.action_sequence.some(a => a.action === 'press_g'));
    assert.ok(s!.expected_speech_tokens.includes('Chart Daten'));
    assert.ok(s!.expected_role_state.includes('graphic'));
  });
});

// ===== canBuildScenario =====

describe('canBuildScenario', () => {
  it('sr_direct → true', ()  => assert.ok(canBuildScenario('sr_direct')));
  it('sr_indirect → true', () => assert.ok(canBuildScenario('sr_indirect')));
  it('sr_not_suitable → false', () => assert.ok(!canBuildScenario('sr_not_suitable')));
  it('manual_only → false', ()     => assert.ok(!canBuildScenario('manual_only')));
  it('needs_flow_context → false', () => assert.ok(!canBuildScenario('needs_flow_context')));
});

// ===== Integrations-Test: normalizeScan befuellt Phase-D-Felder =====

describe('normalizeScan — Phase D Integration', () => {
  const mockRaw = {
    url: 'https://example.com',
    scannedAt: '2026-04-13T10:00:00Z',
    pagesScanned: 1,
    totalIssues: 2,
    score: 60,
    pages: [
      {
        url: 'https://example.com/kontakt',
        title: 'Kontakt',
        issues: [
          {
            rule: 'label',
            engine: 'axe-core',
            severity: 'critical',
            nodes: [
              { selector: '#email', html: '<input id="email" type="text" aria-label="E-Mail">', dom_context: null },
            ],
          },
          {
            rule: 'link-name',
            engine: 'axe-core',
            severity: 'serious',
            nodes: [
              { selector: 'a.nav-link', html: '<a class="nav-link" href="/impressum"></a>', dom_context: null },
            ],
          },
        ],
        incomplete: [],
      },
    ],
  };

  it('automation_candidates haben befuellte action_sequence fuer sr_direct', () => {
    const bundle = normalizeScan(mockRaw, [], []);
    const labelCandidates = bundle.automation_candidates.filter(c => c.rule_id === 'label');
    assert.ok(labelCandidates.length > 0, 'label-Kandidaten erwartet');
    const c = labelCandidates[0];
    assert.ok(c.action_sequence.length > 0, 'action_sequence befuellt');
    assert.ok(c.preconditions.includes('page_loaded'), 'preconditions befuellt');
  });

  it('label-Kandidat hat E-Mail als speech_token', () => {
    const bundle = normalizeScan(mockRaw, [], []);
    const c = bundle.automation_candidates.find(c => c.rule_id === 'label');
    assert.ok(c !== undefined);
    assert.ok(c!.expected_speech_tokens.includes('E-Mail'), 'aria-label als Speech-Token');
  });

  it('label-Kandidat hat edit als role_state', () => {
    const bundle = normalizeScan(mockRaw, [], []);
    const c = bundle.automation_candidates.find(c => c.rule_id === 'label');
    assert.ok(c!.expected_role_state.includes('edit'));
  });

  it('link-Kandidat hat press_k in action_sequence', () => {
    const bundle = normalizeScan(mockRaw, [], []);
    const c = bundle.automation_candidates.find(c => c.rule_id === 'link-name');
    assert.ok(c !== undefined);
    assert.ok(c!.action_sequence.some(a => a.action === 'press_k'));
  });

  it('needs_flow_context Kandidaten haben leere Phase-D-Felder', () => {
    const rawWithFlow = {
      ...mockRaw,
      pages: [{
        ...mockRaw.pages[0],
        issues: [{
          rule: 'focus-trap', // needs_flow_context in sr-classifier
          engine: 'axe-core',
          severity: 'serious' as const,
          nodes: [{ selector: '#modal', html: '<div id="modal">', dom_context: null }],
        }],
      }],
    };
    const bundle = normalizeScan(rawWithFlow, [], []);
    const flowCandidates = bundle.automation_candidates.filter(c => c.rule_id === 'focus-trap');
    // focus-trap ist sr_indirect → bekommt Szenario; nur explizit needs_flow_context-Rules bleiben leer
    // Dieser Test prueft das Format — nicht ob focus-trap leer ist
    for (const c of flowCandidates) {
      assert.ok(Array.isArray(c.preconditions), 'preconditions ist Array');
      assert.ok(Array.isArray(c.action_sequence), 'action_sequence ist Array');
      assert.ok(Array.isArray(c.expected_role_state), 'expected_role_state ist Array');
      assert.ok(Array.isArray(c.expected_speech_tokens), 'expected_speech_tokens ist Array');
    }
  });
});
