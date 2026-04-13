/**
 * NVDA-Retest-CLI (Phase E).
 *
 * Liest einen normalisierten Scan-Bundle (*_normalized.json),
 * filtert automation_candidates mit nvda_candidate: true,
 * fuehrt die action_sequence via @guidepup/playwright + echtes NVDA aus
 * und schreibt das Ergebnis als *_retest_results.json.
 *
 * Voraussetzungen:
 *   - Windows 10/11 mit installiertem NVDA (guidepup erwartet NVDA im Pfad)
 *   - guidepup-Setup einmalig ausgefuehrt: npx @guidepup/setup
 *   - Playwright-Browser installiert: npx playwright install chromium
 *
 * Aufruf:
 *   npm run retest:nvda [-- --file output/scan_example_normalized.json]
 *   npm run retest:nvda [-- --domain example.com]
 *   npm run retest:nvda [-- --dry-run]  (ohne echtes NVDA, Ergebnisse werden gemockt)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { chromium }                from 'playwright';
import { NVDAKeyCodeCommands }     from '@guidepup/guidepup';
import {
  ACTION_TO_NVDA_COMMAND,
  createRetestResult,
  createErrorRetestResult,
  buildRetestReport,
} from '../src/nvda/retest-runner.js';
import { extractSpeechTokens }     from '../src/nvda/speech-extractor.js';
import type {
  NormalizedScanBundle,
  AutomationCandidate,
  RetestResult,
} from '../src/reporting/types.js';

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

/** Wartezeit nach NVDA-Tastendruck bevor gesprochen wird (ms). */
const NVDA_LISTEN_WAIT_MS = 1200;

/**
 * NVDA-Phrasen die auf eine Zugriffssperre / Auth-Redirect hinweisen.
 * In diesem Fall wird das Szenario als skipped markiert statt failed.
 */
const AUTH_ERROR_PHRASES = [
  'nicht berechtigt',
  'zugriff verweigert',
  'access denied',
  'forbidden',
  'anmelden',
  'einloggen',
  'login',
  'you are not authorized',
  'wp-login',
];

// ---------------------------------------------------------------------------
// CLI-Argumente parsen
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const fileArgIdx    = args.indexOf('--file');
const domainArgIdx  = args.indexOf('--domain');
const isDryRun      = args.includes('--dry-run');
const isVerbose     = args.includes('--verbose');

const explicitFile  = fileArgIdx  >= 0 ? args[fileArgIdx  + 1] : undefined;
const explicitDomain = domainArgIdx >= 0 ? args[domainArgIdx + 1] : undefined;

// ---------------------------------------------------------------------------
// Eingabedatei ermitteln
// ---------------------------------------------------------------------------

function findNormalizedFile(domain?: string, explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Datei nicht gefunden: ${explicit}`);
    return explicit;
  }

  const outputDir = path.resolve('output');
  const files = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('_normalized.json'))
    .filter(f => !domain || f.includes(domain))
    .map(f => ({ file: f, mtime: fs.statSync(path.join(outputDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    throw new Error(
      domain
        ? `Kein *_normalized.json fuer Domain "${domain}" in output/ gefunden.`
        : 'Kein *_normalized.json in output/ gefunden. Erst "npm run scan" ausfuehren.',
    );
  }

  return path.join(outputDir, files[0].file);
}

// ---------------------------------------------------------------------------
// Token-Anreicherung aus dom_snapshot
// ---------------------------------------------------------------------------

/**
 * Reichert einen Kandidaten mit on-the-fly berechneten expected_speech_tokens an,
 * wenn das Array im gespeicherten Bundle leer ist.
 *
 * Notwendig fuer normalized.json-Dateien die vor dem speech-extractor-Fix
 * generiert wurden — ohne Re-Scan.
 */
function enrichCandidate(candidate: AutomationCandidate): AutomationCandidate {
  if (candidate.expected_speech_tokens.length > 0) return candidate;
  if (!candidate.dom_snapshot) return candidate;

  const freshTokens = extractSpeechTokens(candidate.dom_snapshot, candidate.rule_id);
  if (freshTokens.length === 0) return candidate;

  return { ...candidate, expected_speech_tokens: freshTokens };
}

/**
 * Prueft ob die gesprochene Phrase auf eine Auth-Sperre / Redirect hinweist.
 */
function isAuthError(phrase: string): boolean {
  const lower = phrase.toLowerCase();
  return AUTH_ERROR_PHRASES.some(p => lower.includes(p));
}

/**
 * Prueft ob NVDA den Fokus auf das Gesamtdokument meldet statt auf ein konkretes Element.
 *
 * Erkennungsmuster: "dokument" + "fokussiert" in der gesprochenen Phrase.
 * Tritt auf wenn ein nicht-interaktives Element (h4/h5/p/div) fokussiert wird —
 * Playwright setzt den Fokus, aber NVDA berichtet den Dokument-Kontext.
 */
function isDocumentFocus(phrase: string): boolean {
  const lower = phrase.toLowerCase();
  return lower.includes('dokument') && lower.includes('fokussiert');
}

// ---------------------------------------------------------------------------
// Dry-Run-Modus (ohne echtes NVDA)
// ---------------------------------------------------------------------------

async function runDryMode(candidate: AutomationCandidate): Promise<RetestResult> {
  const start = Date.now();
  // Simuliert: "kein NVDA vorhanden" → spoken = ""
  const result = createRetestResult(candidate, '', [], Date.now() - start);
  return { ...result, reason: `[DRY-RUN] ${result.reason}` };
}

// ---------------------------------------------------------------------------
// Echter NVDA-Retest via direktem Locator-Fokus
// ---------------------------------------------------------------------------

/**
 * Fokussiert ein Element via Playwright-Locator.
 * Versucht zuerst locator_primary, dann locator_fallbacks.
 * Gibt true zurueck wenn ein Locator erfolgreich war.
 */
async function focusElement(
  candidate: AutomationCandidate,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
): Promise<boolean> {
  const allLocators = [candidate.locator_primary, ...candidate.locator_fallbacks];

  for (const loc of allLocators) {
    try {
      if (loc.type === 'css') {
        await page.locator(loc.value).first().focus({ timeout: 5_000 });
        return true;
      }
      if (loc.type === 'xpath') {
        await page.locator(`xpath=${loc.value}`).first().focus({ timeout: 5_000 });
        return true;
      }
    } catch {
      // Naechsten Locator versuchen
    }
  }
  return false;
}

async function runNvdaScenario(
  candidate: AutomationCandidate,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nvda: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
): Promise<RetestResult> {
  const start = Date.now();

  try {
    // 1. Seite laden
    await page.goto(candidate.page_url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // 2. NVDA-Log leeren — verhindert Akkumulation aus vorherigen Szenarien
    await nvda.clearSpokenPhraseLog();

    // 3. Spezifisches Element fokussieren (praeziser als sequentielle K/Tab-Navigation)
    const focused = await focusElement(candidate, page);
    if (!focused) {
      return createErrorRetestResult(
        candidate,
        'Element nicht fokussierbar — alle Locators fehlgeschlagen',
        Date.now() - start,
      );
    }

    // 4. NVDA: aktuelles Fokus-Element vorlesen lassen (Insert+Tab)
    await nvda.perform(NVDAKeyCodeCommands.reportCurrentFocus);
    await page.waitForTimeout(NVDA_LISTEN_WAIT_MS);

    // 5. Spoken-Log seit clearSpokenPhraseLog lesen
    const rawLog: string[] = await nvda.spokenPhraseLog();
    const spokenLog = rawLog.filter(p => p.trim().length > 0);
    const lastSpoken = spokenLog.join('. ');

    if (isVerbose) console.log(`  spoken: "${lastSpoken}"`);

    // 6. Auth-Sperre erkennen
    if (isAuthError(lastSpoken)) {
      return {
        ...createRetestResult(candidate, lastSpoken, spokenLog, Date.now() - start),
        status: 'skipped',
        reason: `Seite nicht zugaenglich (Auth-Redirect erkannt): "${lastSpoken.slice(0, 80)}"`,
      };
    }

    // 7. Dokument-Fokus erkennen: NVDA meldet das Gesamtdokument statt des Elements.
    //    Tritt auf wenn der Locator auf ein nicht-interaktives Element zeigt (h4/h5/p/div),
    //    das Playwright fokussieren kann, NVDA aber als Dokument-Kontext behandelt.
    //    → Status 'error' statt 'failed' um irrerefuehrende Fehlerausgabe zu vermeiden.
    if (isDocumentFocus(lastSpoken)) {
      return createErrorRetestResult(
        candidate,
        `NVDA-Fokus auf Dokument statt Element — nicht-interaktives Element kann nicht fokussiert werden. Locator: ${candidate.locator_primary.value}`,
        Date.now() - start,
      );
    }

    return createRetestResult(candidate, lastSpoken, spokenLog, Date.now() - start);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return createErrorRetestResult(candidate, msg, Date.now() - start);
  }
}

// ---------------------------------------------------------------------------
// Haupt-Logik
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- Eingabedatei laden ---
  const sourceFile = findNormalizedFile(explicitDomain, explicitFile);
  const bundle: NormalizedScanBundle = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));

  const nvdaCandidates = bundle.automation_candidates.filter(c => c.nvda_candidate);

  console.log(`Quelldatei:       ${sourceFile}`);
  console.log(`NVDA-Kandidaten:  ${nvdaCandidates.length} / ${bundle.automation_candidates.length}`);
  console.log(`Modus:            ${isDryRun ? 'DRY-RUN (kein echtes NVDA)' : 'NVDA (Echtbetrieb)'}`);
  console.log('');

  if (nvdaCandidates.length === 0) {
    console.log('Keine NVDA-Kandidaten vorhanden. Abbruch.');
    process.exit(0);
  }

  const results: RetestResult[] = [];

  // Token-Anreicherung: expected_speech_tokens on-the-fly aus dom_snapshot berechnen
  // wenn das gespeicherte Bundle noch leere Arrays enthaelt (vor speech-extractor-Fix)
  const enrichedCandidates = nvdaCandidates.map(enrichCandidate);
  const enrichedCount = enrichedCandidates.filter(
    (c, i) => c.expected_speech_tokens.length > nvdaCandidates[i].expected_speech_tokens.length,
  ).length;
  if (enrichedCount > 0) {
    console.log(`Token-Anreicherung: ${enrichedCount} Kandidaten mit frischen Tokens aus dom_snapshot`);
  }

  if (isDryRun) {
    // --- Dry-Run: kein Browser, kein NVDA ---
    for (const candidate of enrichedCandidates) {
      if (isVerbose) console.log(`Szenario: ${candidate.scenario_id} (${candidate.rule_id})`);
      results.push(await runDryMode(candidate));
    }
  } else {
    // --- Echter NVDA-Retest ---
    console.log('Starte Playwright-Browser...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page    = await context.newPage();

    const { nvda } = await import('@guidepup/guidepup');

    console.log('Starte NVDA...');
    await nvda.start();

    try {
      for (const candidate of enrichedCandidates) {
        console.log(`Szenario ${results.length + 1}/${enrichedCandidates.length}: ${candidate.scenario_id}`);
        if (isVerbose) console.log(`  rule_id: ${candidate.rule_id}, URL: ${candidate.page_url}`);

        const result = await runNvdaScenario(candidate, nvda, page);
        results.push(result);

        const icon = result.status === 'passed' ? '✓' : result.status === 'skipped' ? '—' : '✗';
        console.log(`  ${icon} ${result.status.toUpperCase()}: ${result.reason}`);
      }
    } finally {
      console.log('\nNVDA wird beendet...');
      await nvda.stop();
      await browser.close();
    }
  }

  // --- Ergebnis-Report schreiben ---
  const report = buildRetestReport(
    results,
    sourceFile,
    bundle.meta.domain,
    isDryRun ? 'virtual-screen-reader' : 'nvda',
  );

  const outputBase = sourceFile.replace('_normalized.json', '_retest_results.json');
  fs.writeFileSync(outputBase, JSON.stringify(report, null, 2), 'utf-8');

  // --- Zusammenfassung ---
  console.log('');
  console.log('=== NVDA-Retest-Ergebnisse ===');
  console.log(`Gesamt:    ${report.total_candidates}`);
  console.log(`Passed:    ${report.passed}`);
  console.log(`Failed:    ${report.failed}`);
  console.log(`Skipped:   ${report.skipped}`);
  console.log(`Fehler:    ${report.errors}`);
  console.log(`Output:    ${outputBase}`);
}

main().catch(err => {
  console.error('Fehler beim NVDA-Retest:', err);
  process.exit(1);
});
