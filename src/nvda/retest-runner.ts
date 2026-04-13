/**
 * NVDA-Retest-Runner (Phase E).
 *
 * Kernlogik fuer die Ausfuehrung von NVDA-Szenarien aus AutomationCandidates.
 * Unabhaengig vom konkreten Screen-Reader-Backend (echter NVDA oder Virtual-SR).
 *
 * Zwei Modi:
 *   1. Echter NVDA  — via @guidepup/playwright (scripts/retest-nvda.ts)
 *   2. Virtual SR   — via @guidepup/virtual-screen-reader (tests/retest-nvda.test.ts)
 */

import type {
  AutomationCandidate,
  RetestResult,
  RetestReport,
  RetestStatus,
} from '../reporting/types.js';

// ---------------------------------------------------------------------------
// Action → NVDA-Command-Mapping
// ---------------------------------------------------------------------------

/**
 * Mappt unsere heuristischen Action-Namen auf NVDAKeyCodeCommands-Keys.
 *
 * Wird im CLI-Script (echter NVDA) auf nvda.perform(NVDAKeyCodeCommands[key]) gemappt.
 * In Virtual-SR-Tests auf virtual.next() / virtual.perform() uebersetzt.
 */
export const ACTION_TO_NVDA_COMMAND: Record<string, string> = {
  press_k:         'moveToNextLink',
  press_tab:       'moveToNext',
  press_b:         'moveToNextButton',
  press_g:         'moveToNextGraphic',
  press_h:         'moveToNextHeading',
  press_d:         'moveToNextLandmark',
  press_insert_t:  'reportTitle',
  press_enter:     'activate',
  press_t:         'moveToNextTable',
  press_m:         'moveToNextFrame',
  press_f:         'moveToNextFormField',
  navigate_cells:  'moveToNextRow',
  nvda_listen:     '__listen__',   // Pseudo-Action: hier wird spoken_phrase gelesen
  open_page:       '__navigate__', // Pseudo-Action: hier wird zur URL navigiert
};

// ---------------------------------------------------------------------------
// Ergebnis-Auswertung
// ---------------------------------------------------------------------------

/**
 * NVDA-Strukturwoerter die reine Rollen-/Zustandsmeldungen ohne Inhalt repraesentieren.
 *
 * Wenn spoken_phrase ausschliesslich diese Woerter enthaelt, hat das Element
 * keinen zugaenglichen Namen — NVDA kann nur Rolle und Zustand vorlesen.
 * Das ist fuer link-name / button-name / image-alt ein verifizierter Bug.
 */
const NVDA_STRUCTURAL_WORDS = new Set([
  // Rollen (Deutsch)
  'link', 'button', 'schaltfläche', 'bild', 'grafik', 'eingabe', 'kontrollkästchen',
  'auswahlfeld', 'kombinationsfeld', 'listenfeld', 'option', 'element',
  // Zustände (Deutsch)
  'fokussiert', 'verlinkt', 'unsichtbar', 'schreibgeschützt', 'schreibgeschuetzt',
  'besucht', 'ausgeklappt', 'eingeklappt', 'deaktiviert', 'aktiviert', 'markiert',
  // Rollen (Englisch — NVDA kann auch englisch sein)
  'focused', 'visited', 'expanded', 'collapsed', 'disabled', 'checked',
  'graphic', 'image', 'edit', 'checkbox', 'radio', 'button',
]);

/**
 * Prueft ob die gesprochene Phrase ausschliesslich aus NVDA-Strukturwoertern besteht
 * (Rolle + Zustand, kein zugaenglicher Name vorhanden).
 */
function isOnlyStructuralWords(phrase: string): boolean {
  const words = phrase.toLowerCase().split(/[\s,./;:!?]+/).filter(w => w.length > 0);
  return words.length > 0 && words.every(w => NVDA_STRUCTURAL_WORDS.has(w));
}

/**
 * Prueft ob die gesprochene Phrase die erwarteten Tokens enthaelt.
 *
 * Strategie:
 *   - expected_speech_tokens leer → skipped (kein Baseline vorhanden)
 *   - Mindestens ein Token als Substring in spoken_phrase (case-insensitive) → passed
 *   - Nur Strukturwoerter (Rolle/Zustand) → failed mit "Bug verifiziert"-Meldung
 *   - Kein Token gefunden → failed
 *
 * @param spokenPhrase   Tatsaechlich gesprochene Phrase
 * @param expectedTokens Erwartete Tokens aus Phase D
 * @returns              Status + Begruendung
 */
export function evaluateSpeechTokens(
  spokenPhrase: string,
  expectedTokens: string[],
): { status: RetestStatus; reason: string } {
  if (expectedTokens.length === 0) {
    return {
      status: 'skipped',
      reason: 'Keine expected_speech_tokens vorhanden — Phase-D-Heuristik hat keinen Baseline generiert',
    };
  }

  const spoken = spokenPhrase.toLowerCase().trim();
  if (!spoken) {
    return {
      status: 'failed',
      reason: `NVDA hat nichts gesprochen. Erwartet: ${expectedTokens.join(', ')}`,
    };
  }

  const matchedTokens = expectedTokens.filter(
    token => spoken.includes(token.toLowerCase().trim()),
  );

  if (matchedTokens.length > 0) {
    return {
      status: 'passed',
      reason: `Gefundene Tokens: ${matchedTokens.join(', ')}`,
    };
  }

  // Strukturwoerter-Erkennung: NVDA spricht nur Rolle/Zustand, kein Name vorhanden.
  // Das ist ein verifizierter Accessibility-Bug — keine "falschen" Tokens erwartet.
  if (isOnlyStructuralWords(spoken)) {
    return {
      status: 'failed',
      reason: `NVDA bestaetigt: kein zugaenglicher Name — nur Rolle/Zustand gesprochen: "${spokenPhrase}". Bug verifiziert.`,
    };
  }

  return {
    status: 'failed',
    reason: `Kein erwarteter Token gefunden. Gesprochen: "${spoken}". Erwartet: ${expectedTokens.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Retest-Result-Builder
// ---------------------------------------------------------------------------

/**
 * Erstellt ein leeres RetestResult fuer einen Kandidaten (wird dann befuellt).
 */
export function createRetestResult(
  candidate: AutomationCandidate,
  spokenPhrase: string,
  spokenLog: string[],
  durationMs: number,
): RetestResult {
  const { status, reason } = evaluateSpeechTokens(
    spokenPhrase,
    candidate.expected_speech_tokens,
  );

  return {
    instance_id:             candidate.instance_id,
    scenario_id:             candidate.scenario_id,
    rule_id:                 candidate.rule_id,
    page_url:                candidate.page_url,
    sr_relevance:            candidate.sr_relevance,
    retest_strategy:         candidate.retest_strategy,
    expected_speech_tokens:  candidate.expected_speech_tokens,
    spoken_phrase:           spokenPhrase,
    spoken_log:              spokenLog,
    status,
    reason,
    tested_at:               new Date().toISOString(),
    duration_ms:             durationMs,
  };
}

/**
 * Erstellt ein Fehler-RetestResult wenn das Szenario nicht ausgefuehrt werden konnte.
 */
export function createErrorRetestResult(
  candidate: AutomationCandidate,
  errorMessage: string,
  durationMs: number,
): RetestResult {
  return {
    instance_id:             candidate.instance_id,
    scenario_id:             candidate.scenario_id,
    rule_id:                 candidate.rule_id,
    page_url:                candidate.page_url,
    sr_relevance:            candidate.sr_relevance,
    retest_strategy:         candidate.retest_strategy,
    expected_speech_tokens:  candidate.expected_speech_tokens,
    spoken_phrase:           '',
    spoken_log:              [],
    status:                  'error',
    reason:                  `Fehler bei Szenario-Ausfuehrung: ${errorMessage}`,
    tested_at:               new Date().toISOString(),
    duration_ms:             durationMs,
  };
}

// ---------------------------------------------------------------------------
// Report-Builder
// ---------------------------------------------------------------------------

/**
 * Aggregiert Einzel-Ergebnisse zu einem RetestReport.
 */
export function buildRetestReport(
  results: RetestResult[],
  sourceFile: string,
  domain: string,
  runner: 'nvda' | 'virtual-screen-reader',
): RetestReport {
  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<RetestStatus, number>,
  );

  return {
    generated_at:     new Date().toISOString(),
    source_file:      sourceFile,
    domain,
    runner,
    total_candidates: results.length,
    passed:           counts.passed  ?? 0,
    failed:           counts.failed  ?? 0,
    skipped:          counts.skipped ?? 0,
    errors:           counts.error   ?? 0,
    results,
  };
}

// ---------------------------------------------------------------------------
// Virtual-SR-Adapter (fuer CI ohne echtes NVDA)
// ---------------------------------------------------------------------------

/**
 * Fuehrt einen Virtual-Screen-Reader-Retest auf einem HTML-DOM-Snippet aus.
 *
 * Verwendet @guidepup/virtual-screen-reader (JSDOM-kompatibel).
 * Ersetzt echtes NVDA fuer CI-Tests.
 *
 * @param htmlSnippet  DOM-Snapshot aus AutomationCandidate.dom_snapshot
 * @param container    DOM-Container (z.B. document.body in JSDOM-Kontext)
 * @returns            Letzte gesprochene Phrase + komplettes Log
 */
export async function runVirtualSrOnSnippet(
  container: Element,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  virtualSr: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win?: any,
): Promise<{ lastPhrase: string; log: string[] }> {
  // API: virtual.start({ container, window?, displayCursor? })
  await virtualSr.start({ container, window: win, displayCursor: false });

  const log: string[] = [];
  let lastPhrase = '';

  try {
    // Alle Elemente im Snippet durchnavigieren (max. 20 Schritte)
    for (let i = 0; i < 20; i++) {
      await virtualSr.next();
      const phrase: string = await virtualSr.lastSpokenPhrase();
      if (phrase && phrase !== log[log.length - 1]) {
        log.push(phrase);
        lastPhrase = phrase;
      }
    }
  } catch {
    // Ende des Dokuments — normal
  }

  await virtualSr.stop();
  return { lastPhrase, log };
}
