/**
 * Zentrale Typ-Definitionen fuer den 3-Layer Accessibility Report.
 *
 * Basiert auf: docs/a11y-report-3-layer-architecture.md (Section 7)
 * Alle Felder mit Kommentar "Phase D/E" werden erst in spaeteren Ausbaustufen befuellt.
 */

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export type ReviewState =
  | 'scanner_finding' // Automatisch erkannt (axe, HTMLCS, custom)
  | 'manual_review'   // Manuell zu pruefen
  | 'ai_verified'     // LLM hat bestaetigt (Pass)
  | 'ai_suspected'    // LLM hat verdaechtigt oder incomplete
  | 'false_positive'; // Als False Positive markiert

export type SrRelevance =
  | 'sr_direct'         // Direkt per NVDA testbar (Label, Name, Rolle)
  | 'sr_indirect'       // Bedingt testbar (Struktur, Navigation, Tastatur)
  | 'sr_not_suitable'   // Nicht NVDA-testbar (Kontrast, visuell)
  | 'manual_only'       // Nur manuell pruefbar (Semantik, Qualitaet)
  | 'needs_flow_context'; // Braucht Flow-/Interaktionskontext (Phase D)

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type RetestStrategy =
  | 'dom_only'         // Statische DOM-Pruefung ausreichend
  | 'keyboard_only'    // Tastaturnavigation erforderlich
  | 'nvda_voice_assert' // NVDA-Sprachausgabe-Assertion
  | 'manual';          // Nur manuelle Pruefung moeglich

export type LocatorType = 'css' | 'xpath' | 'aria' | 'testid' | 'text';

export interface Locator {
  type: LocatorType;
  value: string;
}

/**
 * Eine konkrete Instanz eines Accessibility-Findings auf einer Seite / einem Element.
 *
 * Phase A: Alle Felder aus bestehenden Scan-Daten oder heuristisch.
 * Felder mit Kommentar "Phase D/E" sind als Platzhalter modelliert.
 */
export interface FindingInstance {
  instance_id: string;  // Deterministisch: SHA256(rule_id::page_url::selector)
  finding_id: string;   // Deterministisch: SHA256(rule_id::domain::severity)

  page_url: string;
  page_title?: string;

  /** Heuristisch per URL-Pattern. Immer `_heuristics.page_type === true`. */
  page_type: string;
  /** Heuristisch per rule_id + HTML-Snippet. Immer `_heuristics.component_type === true`. */
  component_type: string;

  review_state: ReviewState;
  scanner_source: string;  // 'axe-core' | 'htmlcs' | 'custom' | 'llm-agent' | 'manual-check'
  severity: Severity;
  rule_id: string;

  /** Normiert aus wcag/wcagTags/wcag_criteria → ['1.1.1', '2.4.2'] */
  wcag_sc: string[];

  locator_primary: Locator;
  locator_fallbacks: Locator[];

  /** Element-HTML-Snippet (max 500 Zeichen, unveraendert aus Scanner). */
  html_snippet: string;
  /**
   * DOM-Snapshot (parentElement.outerHTML, max 2000 Zeichen).
   * null = in Phase A noch nicht vollstaendig erfasst.
   */
  dom_snapshot: string | null;

  failure_summary?: string;
  confidence: ConfidenceLevel;
  manual_review_reason?: string;

  /**
   * Transparenz-Marker fuer heuristische Felder.
   * Verhindert falsche Sicherheit bei automatisch klassifizierten Werten.
   */
  _heuristics?: {
    page_type?: true;
    component_type?: true;
  };
}

/**
 * Automation Layer — NVDA/SR-testbarer Kandidat.
 *
 * Phase A: preconditions, action_sequence, expected_* sind leer ([]).
 * Sie werden in Phase D durch Flow-Recording befuellt.
 */
export interface AutomationCandidate {
  finding_id: string;
  instance_id: string;
  /** Phase C/D: aus Flow + Component + Rule modelliert. Phase A: scn-Prefix + instance hash. */
  scenario_id: string;

  nvda_candidate: boolean;
  sr_relevance: SrRelevance;

  page_url: string;
  page_type?: string;
  component_type?: string;
  rule_id: string;
  wcag_sc: string[];
  severity: Severity;
  scan_source: string;

  locator_primary: Locator;
  locator_fallbacks: Locator[];
  dom_snapshot: string | null;

  /** Phase D: Login-State, geladene Seite etc. Leer in Phase A. */
  preconditions: string[];
  /** Phase D: Tastaturschritte, Klick-Interaktionen. Leer in Phase A. */
  action_sequence: Array<{ step: number; action: string; target?: string; value?: string }>;
  /** Phase D: Erwartete ARIA-Rolle / State. Leer in Phase A. */
  expected_role_state: string[];
  /** Phase E: Erwartete NVDA-Sprachausgabe-Tokens. Leer in Phase A. */
  expected_speech_tokens: string[];
  /** Phase D: Erwarteter Endzustand nach Interaktion. */
  expected_navigation_outcome?: string;

  manual_review_reason?: string;
  confidence: ConfidenceLevel;
  retest_strategy: RetestStrategy;
}

export interface ExecutiveSummary {
  score: number;
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  pages_scanned: number;
  total_findings: number;
  severity_counts: Record<Severity, number>;
  evidence_breakdown: {
    automatic_findings: number;
    manual_check_findings: number;
    ai_verified_findings: number;
    needs_human_review: number;
  };
  top_wcag_areas: Array<{ wcag_sc: string; instance_count: number }>;
}

export interface NormalizedScanBundleMeta {
  report_id: string;
  generated_at: string;
  scanner_version: string;
  domain: string;
  scan_date: string;
  mode: string;
  /** Phase A — paralleler Export, UI-Layer folgt in Phase C */
  bundle_version: '1.0-alpha';
}

/**
 * Der vollstaendige normalisierte Scan-Bundle.
 *
 * Wird parallel zum bestehenden Output erzeugt.
 * Root-JSON-Struktur fuer *_normalized.json.
 */
export interface NormalizedScanBundle {
  meta: NormalizedScanBundleMeta;
  executive_summary: ExecutiveSummary;
  finding_instances: FindingInstance[];
  automation_candidates: AutomationCandidate[];
}

// ---------------------------------------------------------------------------
// Phase E — NVDA-Retest-Ergebnisse
// ---------------------------------------------------------------------------

/** Status eines einzelnen Retest-Laufs. */
export type RetestStatus = 'passed' | 'failed' | 'skipped' | 'error';

/**
 * Ergebnis eines einzelnen NVDA-Szenario-Retests.
 *
 * Phase E: Wird fuer jeden AutomationCandidate mit nvda_candidate: true erzeugt.
 */
export interface RetestResult {
  instance_id: string;
  scenario_id: string;
  rule_id: string;
  page_url: string;
  sr_relevance: SrRelevance;
  retest_strategy: RetestStrategy;

  /** Erwartete Tokens aus Phase D (kann leer sein = skipped). */
  expected_speech_tokens: string[];
  /** Tatsaechlich von NVDA/Virtual-SR gesprochene Phrase. */
  spoken_phrase: string;
  /** Komplettes Spoken-Log (alle Phasen der action_sequence). */
  spoken_log: string[];

  status: RetestStatus;
  /** Erklaerung warum passed/failed/skipped. */
  reason: string;

  /** Zeitstempel des Retest-Laufs (ISO 8601). */
  tested_at: string;
  /** Dauer des Szenarios in Millisekunden. */
  duration_ms: number;
}

/**
 * Gesamtbericht eines NVDA-Retest-Laufs.
 *
 * Wird als output/*_retest_results.json gespeichert.
 */
export interface RetestReport {
  generated_at: string;
  source_file: string;
  domain: string;
  runner: 'nvda' | 'virtual-screen-reader';

  total_candidates: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;

  results: RetestResult[];
}
