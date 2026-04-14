/**
 * Haupt-Normalisierer: RawScanResult + Finding[] + ManualCheckResult[] → NormalizedScanBundle
 *
 * Laedt bestehende Scan-Daten und erzeugt ein strukturiertes NormalizedScanBundle
 * fuer den Automation Layer. Bestehende Outputs bleiben unveraendert.
 *
 * Phase A: Alle Felder die aus bestehenden Daten ableitbar sind, werden befuellt.
 * Phase-D/E-Felder (preconditions, action_sequence, expected_*) bleiben als leere Arrays.
 */

import { createHash } from 'crypto';
import { generateFindingId, generateInstanceId, generateScenarioId } from './id-generators.js';
import { normalizeWcagSc } from './wcag-normalizer.js';
import { buildLocators } from './locator-builder.js';
import { classifyPageType } from './page-classifier.js';
import { classifyComponentType } from './component-classifier.js';
import { classifySrRelevance } from './sr-classifier.js';
import { buildNvdaScenario, canBuildScenario } from '../nvda/scenario-builder.js';
import type {
  NormalizedScanBundle,
  FindingInstance,
  AutomationCandidate,
  ReviewState,
  Severity,
  ExecutiveSummary,
} from '../reporting/types.js';

// --- Eingabe-Typen (kompatibel mit bestehender Pipeline) ---

interface RawNode {
  selector?: string;
  html?: string;
  dom_context?: string | null;
  failureSummary?: string;
  url?: string;
}

interface RawIssue {
  rule: string;
  engine?: string;
  severity?: string;
  description?: string;
  wcag?: string | string[];
  wcagTags?: string[];
  wcag_criteria?: string[];
  htmlcsCode?: string;
  needsReview?: boolean;
  nodes?: RawNode[];
}

interface RawPage {
  url: string;
  title?: string;
  issues?: RawIssue[];
  incomplete?: RawIssue[];
}

export interface RawScanInput {
  url: string;
  scannedAt?: string;
  scannerVersion?: string;
  mode?: string;
  pagesScanned?: number;
  totalIssues?: number;
  score?: number;
  pages: RawPage[];
  manual_checks?: ManualCheckInput[];
}

export interface FindingInput {
  rule_id: string;
  severity: string;
  element_count: number;
  wcag_criteria?: string[];
  description?: string;
}

export interface ManualCheckInput {
  id: string;
  rule: string;
  status: string;
  wcag?: string;
  wcag_criteria?: string[];
  nodes?: RawNode[];
  affected_pages?: string[];
}

// --- Hilfsfunktionen ---

/** Mappt den Engine-String auf einen ReviewState. */
function reviewStateFromEngine(engine?: string, override?: ReviewState): ReviewState {
  if (override) return override;
  switch (engine) {
    case 'llm-agent': return 'ai_suspected';
    case 'axe-core':
    case 'htmlcs':
    case 'custom': return 'scanner_finding';
    default: return 'scanner_finding';
  }
}

/** Normiert Severity-String zu Severity-Typ. */
function normalizeSeverity(severity?: string): Severity {
  switch (severity) {
    case 'critical': return 'critical';
    case 'serious': return 'serious';
    case 'moderate': return 'moderate';
    case 'minor': return 'minor';
    default: return 'minor';
  }
}

/** Berechnet Risk-Level aus Score. */
function scoreToRiskLevel(score: number): ExecutiveSummary['risk_level'] {
  if (score < 30) return 'critical';
  if (score < 60) return 'high';
  if (score < 80) return 'medium';
  return 'low';
}

/** Zaehlt Top-WCAG-Areas aus FindingInstances (nach Haeufigkeit). */
function countTopWcagAreas(
  instances: FindingInstance[],
  limit = 5,
): Array<{ wcag_sc: string; instance_count: number }> {
  const counts = new Map<string, number>();
  for (const inst of instances) {
    for (const sc of inst.wcag_sc) {
      counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([wcag_sc, instance_count]) => ({ wcag_sc, instance_count }));
}

/**
 * Normalisiert alle Nodes eines Raw-Issues zu FindingInstances.
 */
function normalizeIssueToInstances(
  page: RawPage,
  issue: RawIssue,
  domain: string,
  reviewStateOverride?: ReviewState,
): FindingInstance[] {
  if (!issue.nodes || issue.nodes.length === 0) return [];

  const wcag_sc = normalizeWcagSc({
    wcag: issue.wcag,
    wcagTags: issue.wcagTags,
    wcag_criteria: issue.wcag_criteria,
    htmlcsCode: issue.htmlcsCode,
  });

  const severity = normalizeSeverity(issue.severity);
  const finding_id = generateFindingId(issue.rule, domain, severity);
  const { page_type } = classifyPageType(page.url, page.title);
  const srClass = classifySrRelevance(issue.rule, issue.engine);
  const review_state = reviewStateFromEngine(issue.engine, reviewStateOverride);

  return issue.nodes.map(node => {
    const selector = node.selector ?? '';
    const html = node.html ?? '';
    const instance_id = generateInstanceId(issue.rule, page.url, selector);
    const { component_type } = classifyComponentType(issue.rule, html);
    const { primary: locator_primary, fallbacks: locator_fallbacks } = buildLocators(selector, html);

    return {
      instance_id,
      finding_id,
      page_url: page.url,
      page_title: page.title,
      page_type,
      component_type,
      review_state,
      scanner_source: issue.engine ?? 'unknown',
      severity,
      rule_id: issue.rule,
      wcag_sc,
      locator_primary,
      locator_fallbacks,
      html_snippet: html,
      dom_snapshot: node.dom_context ?? null,
      failure_summary: node.failureSummary,
      confidence: srClass.confidence,
      manual_review_reason: srClass.manual_review_reason,
      _heuristics: { page_type: true, component_type: true },
    };
  });
}

/**
 * Normalisiert Manual-Check-Nodes zu FindingInstances.
 */
function normalizeManualCheckToInstances(
  check: ManualCheckInput,
  domain: string,
): FindingInstance[] {
  if (!check.nodes || check.nodes.length === 0) return [];

  const wcag_sc = normalizeWcagSc({
    wcag: check.wcag,
    wcag_criteria: check.wcag_criteria,
  });

  const review_state: ReviewState =
    check.status === 'Pass' ? 'ai_verified' :
    check.status === 'Fail' ? 'ai_suspected' :
    'manual_review';

  const srClass = classifySrRelevance(check.rule, 'manual');

  return check.nodes.map(node => {
    const pageUrl = node.url ?? '';
    const selector = node.selector ?? '';
    const html = node.html ?? '';
    const instance_id = generateInstanceId(check.rule, pageUrl, selector);
    const finding_id = generateFindingId(check.rule, domain, 'moderate');
    const { page_type } = classifyPageType(pageUrl);
    const { component_type } = classifyComponentType(check.rule, html);
    const { primary: locator_primary, fallbacks: locator_fallbacks } = buildLocators(selector, html);

    return {
      instance_id,
      finding_id,
      page_url: pageUrl,
      page_title: undefined,
      page_type,
      component_type,
      review_state,
      scanner_source: 'manual-check',
      // Manual-Checks haben keine direkte Severity — moderate als Platzhalter
      severity: 'moderate' as Severity,
      rule_id: check.rule,
      wcag_sc,
      locator_primary,
      locator_fallbacks,
      html_snippet: html,
      dom_snapshot: null,
      failure_summary: undefined,
      confidence: srClass.confidence,
      manual_review_reason: srClass.manual_review_reason ?? 'Manueller Check — keine automatische Assertion moeglich.',
      _heuristics: { page_type: true, component_type: true },
    };
  });
}

/**
 * Baut AutomationCandidates aus FindingInstances.
 * Schliesst sr_not_suitable und manual_only aus.
 * Phase D: befuellt preconditions, action_sequence, expected_role_state,
 *          expected_speech_tokens, expected_navigation_outcome per Heuristik.
 */
function buildAutomationCandidates(instances: FindingInstance[]): AutomationCandidate[] {
  const candidates: AutomationCandidate[] = [];

  for (const inst of instances) {
    const sc = classifySrRelevance(inst.rule_id, inst.scanner_source);
    if (sc.sr_relevance === 'sr_not_suitable' || sc.sr_relevance === 'manual_only') {
      continue;
    }

    // Phase D: NVDA-Szenario heuristisch befuellen (sr_direct + sr_indirect)
    const scenario = canBuildScenario(sc.sr_relevance)
      ? buildNvdaScenario(
          {
            rule_id: inst.rule_id,
            sr_relevance: sc.sr_relevance,
            page_type: inst.page_type,
            component_type: inst.component_type,
          },
          inst.page_url,
          inst.html_snippet,
        )
      : null;

    candidates.push({
      finding_id: inst.finding_id,
      instance_id: inst.instance_id,
      scenario_id: generateScenarioId(inst.instance_id),
      nvda_candidate: sc.nvda_candidate,
      sr_relevance: sc.sr_relevance,
      page_url: inst.page_url,
      page_type: inst.page_type,
      component_type: inst.component_type,
      rule_id: inst.rule_id,
      wcag_sc: inst.wcag_sc,
      severity: inst.severity,
      scan_source: inst.scanner_source,
      locator_primary: inst.locator_primary,
      locator_fallbacks: inst.locator_fallbacks,
      dom_snapshot: inst.dom_snapshot,
      // Phase D: heuristisch befuellt fuer sr_direct/sr_indirect; leer fuer needs_flow_context
      preconditions:              scenario?.preconditions          ?? [],
      action_sequence:            scenario?.action_sequence        ?? [],
      expected_role_state:        scenario?.expected_role_state    ?? [],
      expected_speech_tokens:     scenario?.expected_speech_tokens ?? [],
      expected_navigation_outcome: scenario?.expected_navigation_outcome,
      manual_review_reason: inst.manual_review_reason,
      confidence: inst.confidence,
      retest_strategy: sc.retest_strategy,
    });
  }

  return candidates;
}

/**
 * Hauptfunktion: Normalisiert den gesamten Scan zu einem NormalizedScanBundle.
 *
 * Verarbeitet:
 * 1. Raw-Issues (violations) aus allen Seiten
 * 2. Incomplete-Checks (needs_review) als ai_suspected
 * 3. Manual-Check-Nodes
 */
export interface NormalizeScanOptions {
  /** Supabase-Scan-ID — wird in meta.scan_id eingebettet fuer automatische Retest-Speicherung. */
  scanId?: string;
}

export function normalizeScan(
  rawScanResult: RawScanInput,
  findings: FindingInput[],
  manualChecks: ManualCheckInput[],
  options: NormalizeScanOptions = {},
): NormalizedScanBundle {
  const domain = (() => {
    try {
      return new URL(rawScanResult.url).hostname;
    } catch {
      return rawScanResult.url;
    }
  })();

  const instances: FindingInstance[] = [];

  // 1. Raw-Issues (violations) und Incomplete aus allen Seiten
  for (const page of rawScanResult.pages ?? []) {
    for (const issue of page.issues ?? []) {
      instances.push(...normalizeIssueToInstances(page, issue, domain));
    }

    // Incomplete-Checks: axe markiert diese als "wahrscheinlich fehlerhaft, nicht bestaetigt"
    for (const issue of page.incomplete ?? []) {
      instances.push(...normalizeIssueToInstances(page, issue, domain, 'ai_suspected'));
    }
  }

  // 2. Manual-Check-Nodes
  for (const check of manualChecks) {
    instances.push(...normalizeManualCheckToInstances(check, domain));
  }

  // 3. AutomationCandidates (gefiltert: nur sr_direct + sr_indirect + needs_flow_context)
  const automationCandidates = buildAutomationCandidates(instances);

  // 4. Executive Summary aufbauen
  const score = rawScanResult.score ?? 0;
  const severityCounts: Record<Severity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) {
    const sev = normalizeSeverity(f.severity);
    severityCounts[sev] += f.element_count;
  }

  const evidenceBreakdown = {
    automatic_findings: instances.filter(i =>
      i.scanner_source !== 'manual-check' && i.scanner_source !== 'llm-agent'
    ).length,
    manual_check_findings: instances.filter(i => i.scanner_source === 'manual-check').length,
    ai_verified_findings: instances.filter(i => i.review_state === 'ai_verified').length,
    needs_human_review: instances.filter(i => i.review_state === 'manual_review').length,
  };

  const executiveSummary: ExecutiveSummary = {
    score,
    risk_level: scoreToRiskLevel(score),
    pages_scanned: rawScanResult.pagesScanned ?? rawScanResult.pages.length,
    total_findings: findings.reduce((sum, f) => sum + f.element_count, 0),
    severity_counts: severityCounts,
    evidence_breakdown: evidenceBreakdown,
    top_wcag_areas: countTopWcagAreas(instances),
  };

  // 5. Report-ID deterministisch aus URL + Scan-Zeitpunkt
  const reportId = createHash('sha256')
    .update(`${rawScanResult.url}::${rawScanResult.scannedAt ?? new Date().toISOString()}`)
    .digest('hex')
    .substring(0, 16);

  return {
    meta: {
      report_id: `rpt-${reportId}`,
      generated_at: new Date().toISOString(),
      scanner_version: rawScanResult.scannerVersion ?? '2.0',
      domain,
      scan_date: rawScanResult.scannedAt ?? new Date().toISOString(),
      mode: rawScanResult.mode ?? 'public',
      bundle_version: '1.0-alpha',
      ...(options.scanId ? { scan_id: options.scanId } : {}),
    },
    executive_summary: executiveSummary,
    finding_instances: instances,
    automation_candidates: automationCandidates,
  };
}
