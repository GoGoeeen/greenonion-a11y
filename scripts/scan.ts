/**
 * GreenOnion A11y Scanner — GitHub Actions Entry Point
 *
 * Wrapper um scanner.js, der Scan-Ergebnisse in die Supabase-Tabelle
 * `accessibility_scans` schreibt. Kann auch lokal mit --local ausgefuehrt
 * werden (Output als JSON-Datei statt Supabase).
 *
 * Usage (GitHub Actions):
 *   tsx scripts/scan.ts --domain example.com --client-id UUID --scan-id UUID --max-pages 5
 *
 * Usage (Lokal):
 *   tsx scripts/scan.ts --domain example.com --max-pages 3 --local
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { scan } from '../scanner.js';
import { runAgentEvaluation } from './agent.js';
import { manualChecks, type ManualCheckDefinition } from './manual-checks.js';
import {
  deduplicateFindingsFromPages,
  deriveAccessibilityScoreMetrics,
  extractWcagCriteria,
} from './accessibility-score.js';
import { writeFileSync, mkdirSync } from 'fs';
import { normalizeScan } from '../src/normalize/normalize-scan.js';
import { exportNormalizedBundle } from '../src/reporting/export-json.js';

// --- Types ---

interface Finding {
  rule_id: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  wcag_criteria: string[];
  description: string;
  affected_pages: string[];
  element_count: number;
  example_html: string;
  example_url: string;
}

type ComplianceStatus = 'Pass' | 'Fail' | 'Needs Human Review';

interface ManualCheckResult {
  id: string;
  rule: string;
  category: string;
  wcag: string;
  task: string;
  appliesTo: Array<'incomplete' | 'suspicious-alt-text'>;
  wcag_criteria: string[];
  status: ComplianceStatus;
  status_label: string;
  description: string;
  remediation?: {
    recommended_fix: string;
    explanation: string;
  };
  agent_descriptions: string[];
  nodes: Array<{ url: string; selector: string; html: string }>;
  affected_pages: string[];
}

interface CliArgs {
  domain?: string;
  'client-id'?: string;
  'scan-id'?: string;
  'max-pages'?: string;
  'scan-type'?: string;
  local?: boolean;
  [key: string]: string | boolean | undefined;
}

interface NormalizedDomain {
  baseUrl: string;
  host: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// --- CLI Argument Parser ---

function parseArgs(argv: string[]): CliArgs {
  const opts: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value Format
        opts[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts[raw] = next;
          i++;
        } else {
          opts[raw] = true;
        }
      }
    }
  }
  return opts;
}

function normalizeDomain(input: string): NormalizedDomain {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Leere Domain uebergeben');
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`Ungueltige Domain: ${input}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Ungueltiges Protokoll in Domain: ${parsed.protocol}`);
  }

  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    host: parsed.host,
  };
}

// --- robots.txt Check ---

async function checkRobotsTxt(baseUrl: string): Promise<{ allowed: boolean; warning?: string }> {
  try {
    const res = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { allowed: true };

    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim().toLowerCase());

    let inMatchingBlock = false;
    for (const line of lines) {
      if (line.startsWith('user-agent:')) {
        const agent = line.split(':')[1]?.trim();
        inMatchingBlock = agent === '*' || agent === 'greenonion';
      }
      if (inMatchingBlock && line === 'disallow: /') {
        return {
          allowed: false,
          warning: 'robots.txt verbietet Crawling (Disallow: /). Nur Startseite wird gescannt.',
        };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

async function probeReachability(targetUrl: string): Promise<void> {
  const methods: Array<'HEAD' | 'GET'> = ['HEAD', 'GET'];
  let lastError: Error | null = null;

  for (const method of methods) {
    try {
      const res = await fetch(targetUrl, {
        method,
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });

      if (!res.ok && res.status >= 500) {
        throw new Error(`Server antwortet mit Status ${res.status} bei ${method}`);
      }

      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    if (!response) {
      throw new Error('Playwright-Navigation lieferte keine HTTP-Antwort');
    }

    if (response.status() >= 500) {
      throw new Error(`Server antwortet mit Status ${response.status()} bei Playwright-Navigation`);
    }

    return;
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  throw lastError ?? new Error('Unbekannter Fehler bei Erreichbarkeitspruefung');
}

interface RawIssue {
  rule: string;
  severity: string;
  engine?: string;
  description: string;
  help?: string;
  helpUrl?: string;
  wcag?: string;
  wcagTags?: string[];
  remediation?: {
    recommended_fix?: string;
    explanation?: string;
  };
  nodes?: Array<{ url?: string; selector: string; html?: string; dom_context?: string | null; failureSummary?: string }>;
  needsReview?: boolean;
}

interface RawPage {
  url: string;
  title: string;
  issues: RawIssue[];
  incomplete?: RawIssue[];
  issueCount: number;
}

interface RawScanResult {
  url: string;
  scannedAt: string;
  pagesScanned: number;
  totalIssues: number;
  score: number;
  pages: RawPage[];
  manual_checks?: ManualCheckResult[];
}

function mergeManualCheckEvidence(
  evaluated: ManualCheckResult[],
  fromAgent: unknown,
): ManualCheckResult[] {
  const source = Array.isArray(fromAgent) ? fromAgent : [];
  const byId = new Map<
    string,
    {
      nodes: Array<{ url: string; selector: string; html: string }>;
      agent_descriptions: string[];
      status?: ComplianceStatus;
      status_label?: string;
      description?: string;
      remediation?: { recommended_fix: string; explanation: string };
    }
  >();

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const id = String(raw.id || '').trim();
    if (!id) continue;

    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const nodes = rawNodes
      .map((node) => {
        if (!node || typeof node !== 'object') return null;
        const n = node as Record<string, unknown>;
        const url = String(n.url || '').trim();
        const selector = String(n.selector || '').trim();
        const html = String(n.html || '');
        if (!url || !selector || !html) return null;
        return { url, selector, html };
      })
      .filter((node): node is { url: string; selector: string; html: string } => node !== null);

    const descriptions = Array.isArray(raw.agent_descriptions)
      ? raw.agent_descriptions.map((d) => String(d || '').trim()).filter(Boolean)
      : [];

    const statusRaw = String(raw.status || '').trim() as ComplianceStatus;
    const status = statusRaw === 'Pass' || statusRaw === 'Fail' || statusRaw === 'Needs Human Review'
      ? statusRaw
      : undefined;
    const status_label = String(raw.status_label || '').trim() || undefined;
    const description = String(raw.description || '').trim() || undefined;
    const remediationRaw = raw.remediation && typeof raw.remediation === 'object'
      ? (raw.remediation as Record<string, unknown>)
      : null;
    const recommended_fix = remediationRaw ? String(remediationRaw.recommended_fix || '').trim() : '';
    const remediationExplanation = remediationRaw ? String(remediationRaw.explanation || '').trim() : '';
    const remediation = recommended_fix && remediationExplanation
      ? { recommended_fix, explanation: remediationExplanation }
      : undefined;

    byId.set(id, {
      nodes,
      agent_descriptions: descriptions,
      status,
      status_label,
      description,
      remediation,
    });
  }

  const dedupeNodes = (nodes: Array<{ url: string; selector: string; html: string }>) => {
    const map = new Map<string, { url: string; selector: string; html: string }>();
    for (const node of nodes) {
      const key = `${node.url}||${node.selector}||${node.html}`;
      if (!map.has(key)) map.set(key, node);
    }
    return [...map.values()].slice(0, 5);
  };

  const dedupeStrings = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

  return evaluated.map((check) => {
    const sourceEntry = byId.get(check.id);
    if (!sourceEntry) return check;

    const mergedNodes = dedupeNodes([...(check.nodes || []), ...(sourceEntry.nodes || [])]);
    const mergedDescriptions = dedupeStrings([...(check.agent_descriptions || []), ...(sourceEntry.agent_descriptions || [])]);
    const nextStatus = sourceEntry.status || check.status;
    const nextStatusLabel = sourceEntry.status_label || (nextStatus === 'Pass' ? 'Verified by AI - Pass' : check.status_label);
    const nextDescription = sourceEntry.description || check.description;

    return {
      ...check,
      status: nextStatus,
      status_label: nextStatusLabel,
      description: nextDescription,
      remediation: sourceEntry.remediation || check.remediation,
      nodes: mergedNodes,
      agent_descriptions: mergedDescriptions,
      affected_pages: dedupeStrings([...(check.affected_pages || []), ...mergedNodes.map((n) => n.url)]),
    };
  });
}

function getIssueWcagCriteria(issue: RawIssue): string[] {
  const fromTags = extractWcagCriteria(issue.wcagTags || []);
  if (fromTags.length > 0) return fromTags;
  if (!issue.wcag) return [];

  const values: string[] = [];
  for (const sc of issue.wcag.split('/').map((s) => s.trim())) {
    if (sc && !values.includes(sc)) values.push(sc);
  }
  return values;
}

function evaluateManualChecks(
  pages: RawPage[],
  checks: ManualCheckDefinition[],
  aiEvaluated: boolean,
): ManualCheckResult[] {
  const QUALITATIVE_REVIEW_WCAG = new Set(['1.1.1', '1.3.1']);

  const toEvidenceNode = (
    pageUrl: string,
    node: { url?: string; selector?: string; html?: string },
  ): { url: string; selector: string; html: string } | null => {
    const selector = String(node?.selector || "").trim();
    const html = String(node?.html || "").trim();
    const url = String(node?.url || pageUrl || "").trim();
    if (!selector || !html || !url) return null;
    return { url, selector, html };
  };

  const dedupeEvidenceNodes = (
    nodes: Array<{ url: string; selector: string; html: string }>,
    limit = 5,
  ) => {
    const map = new Map<string, { url: string; selector: string; html: string }>();
    for (const node of nodes) {
      const key = `${node.url}||${node.selector}||${node.html}`;
      if (!map.has(key)) map.set(key, node);
      if (map.size >= limit) break;
    }
    return [...map.values()];
  };

  return checks.map((check) => {
    const taskText = check.task || check.label || check.rule;
    const failPages = new Set<string>();
    const failDescriptions: string[] = [];
    const failEvidenceNodes: Array<{ url: string; selector: string; html: string }> = [];
    const reviewEvidenceNodes: Array<{ url: string; selector: string; html: string }> = [];
    let remediation: { recommended_fix: string; explanation: string } | undefined;
    let hasApplicableCandidates = false;

    for (const page of pages) {
      const pageIssues = Array.isArray(page.issues) ? page.issues : [];
      const pageIncomplete = Array.isArray(page.incomplete) ? page.incomplete : [];

      if (check.appliesTo.includes('suspicious-alt-text')) {
        const suspiciousIssues = pageIssues.filter((i) => i.rule === 'suspicious-alt-text');
        const hasSuspiciousCandidates = suspiciousIssues.length > 0;
        if (hasSuspiciousCandidates) hasApplicableCandidates = true;
        for (const issue of suspiciousIssues) {
          const nodes = Array.isArray(issue.nodes) ? issue.nodes : [];
          for (const node of nodes) {
            const normalized = toEvidenceNode(page.url, node);
            if (normalized) reviewEvidenceNodes.push(normalized);
          }
        }
      }

      if (check.appliesTo.includes('incomplete')) {
        const relevantIncomplete = pageIncomplete.filter((issue) => {
          const wcagList = getIssueWcagCriteria(issue);
          if (wcagList.length === 0) return true;
          return wcagList.includes(check.wcag);
        });
        if (relevantIncomplete.length > 0) {
          hasApplicableCandidates = true;
          for (const issue of relevantIncomplete) {
            const nodes = Array.isArray(issue.nodes) ? issue.nodes : [];
            for (const node of nodes) {
              const normalized = toEvidenceNode(page.url, node);
              if (normalized) reviewEvidenceNodes.push(normalized);
            }
          }
        }
      }

      const llmFails = pageIssues.filter((issue) => {
        if (issue.engine !== 'llm-agent') return false;
        const wcagList = getIssueWcagCriteria(issue);
        return wcagList.includes(check.wcag);
      });

      if (llmFails.length > 0) {
        failPages.add(page.url);
        for (const issue of llmFails) {
          const text = (issue.description || '').trim();
          if (text && !failDescriptions.includes(text)) {
            failDescriptions.push(text);
          }
          const candidateFix = typeof issue.remediation?.recommended_fix === 'string'
            ? issue.remediation.recommended_fix.trim()
            : '';
          const candidateExplanation = typeof issue.remediation?.explanation === 'string'
            ? issue.remediation.explanation.trim()
            : '';
          if (!remediation && candidateFix && candidateExplanation) {
            remediation = {
              recommended_fix: candidateFix,
              explanation: candidateExplanation,
            };
          }
          const nodes = Array.isArray(issue.nodes) ? issue.nodes : [];
          for (const node of nodes) {
            const normalized = toEvidenceNode(page.url, node);
            if (normalized) failEvidenceNodes.push(normalized);
          }
        }
      }
    }

    if (failDescriptions.length > 0) {
      return {
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag: check.wcag,
        task: taskText,
        appliesTo: check.appliesTo,
        wcag_criteria: [check.wcag],
        status: 'Fail',
        status_label: 'Fail',
        description: 'Agent hat einen Verstoess zu diesem Check erkannt.',
        remediation,
        agent_descriptions: failDescriptions,
        nodes: dedupeEvidenceNodes(failEvidenceNodes, 5),
        affected_pages: [...failPages],
      };
    }

    const nodes = dedupeEvidenceNodes(reviewEvidenceNodes, 20);
    const hasRelevantCandidates = nodes.length > 0;
    const isQualitativeCriterion = QUALITATIVE_REVIEW_WCAG.has(check.wcag);

    if (nodes.length === 0 && check.autoPassIfEmpty === true) {
      return {
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag: check.wcag,
        task: taskText,
        appliesTo: check.appliesTo,
        wcag_criteria: [check.wcag],
        status: 'Pass',
        status_label: 'Automatisch verifiziert (Keine technischen Auffälligkeiten)',
        description: 'Keine relevanten technischen Verstoesse im automatischen Scan gefunden.',
        agent_descriptions: ['Die automatisierte Prüfung hat keine relevanten Verstöße für dieses Kriterium identifiziert. Eine manuelle Stichprobe ist optional.'],
        nodes: [],
        affected_pages: [],
      };
    }

    if (hasRelevantCandidates && isQualitativeCriterion) {
      return {
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag: check.wcag,
        task: taskText,
        appliesTo: check.appliesTo,
        wcag_criteria: [check.wcag],
        status: 'Needs Human Review',
        status_label: 'Needs Human Review',
        description: 'Qualitatives Kriterium mit vorhandenen Elementen; automatische Bewertung nicht eindeutig.',
        agent_descriptions: ['Es wurden relevante Elemente gefunden, die Bewertung dieses qualitativen Kriteriums erfordert jedoch eine manuelle Sichtpruefung.'],
        nodes: dedupeEvidenceNodes(reviewEvidenceNodes, 5),
        affected_pages: dedupeEvidenceNodes(reviewEvidenceNodes, 100).map((n) => n.url),
      };
    }

    if (aiEvaluated && hasApplicableCandidates) {
      return {
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag: check.wcag,
        task: taskText,
        appliesTo: check.appliesTo,
        wcag_criteria: [check.wcag],
        status: 'Pass',
        status_label: 'Verified by AI - Pass',
        description: 'Kein Verstoess erkannt.',
        agent_descriptions: [],
        nodes: [],
        affected_pages: [],
      };
    }

    const reviewReason = hasApplicableCandidates
      ? 'Automatische Bewertung war nicht eindeutig; die vorliegenden Hinweise sind semantisch nicht sicher als Pass oder Fail klassifizierbar.'
      : 'Keine relevanten Elemente fuer diesen Test auf der Seite gefunden; manuelle Pruefung erforderlich.';

    return {
      id: check.id,
      rule: check.rule,
      category: check.category,
      wcag: check.wcag,
      task: taskText,
      appliesTo: check.appliesTo,
      wcag_criteria: [check.wcag],
      status: 'Needs Human Review',
      status_label: 'Needs Human Review',
      description: hasApplicableCandidates
        ? 'Automatische Bewertung nicht eindeutig, manuelle Pruefung erforderlich.'
        : 'Fuer diesen Check lagen keine verifizierbaren Kandidaten vor.',
      agent_descriptions: [reviewReason],
      nodes: dedupeEvidenceNodes(reviewEvidenceNodes, 5),
      affected_pages: dedupeEvidenceNodes(reviewEvidenceNodes, 100).map((n) => n.url),
    };
  });
}

// --- Count severities from deduplicated findings ---

function countSeverities(findings: Finding[]) {
  let critical = 0, serious = 0, moderate = 0, minor = 0;
  for (const f of findings) {
    const count = f.element_count;
    switch (f.severity) {
      case 'critical': critical += count; break;
      case 'serious': serious += count; break;
      case 'moderate': moderate += count; break;
      case 'minor': minor += count; break;
    }
  }
  return { critical, serious, moderate, minor };
}

// --- Supabase Update Helpers ---

async function updatePagesScanned(supabase: SupabaseClient, scanId: string, pagesScanned: number) {
  const { error } = await supabase
    .from('accessibility_scans')
    .update({ pages_scanned: pagesScanned, updated_at: new Date().toISOString() })
    .eq('id', scanId);
  if (error) {
    console.error(`  Supabase pages_scanned update failed: ${error.message}`);
  }
}

async function updateScanStatus(
  supabase: SupabaseClient,
  scanId: string,
  status: string,
  errorMessage?: string,
) {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (errorMessage) {
    update.error_message = errorMessage;
  }
  const { error } = await supabase
    .from('accessibility_scans')
    .update(update)
    .eq('id', scanId);

  if (error) {
    console.error(`  Supabase status update failed: ${error.message}`);
  }
}

async function assertSingleScanRowExists(supabase: SupabaseClient, scanId: string) {
  const { data, error } = await supabase
    .from('accessibility_scans')
    .select('id')
    .eq('id', scanId);

  if (error) {
    throw new Error(`Supabase scan lookup failed: ${error.message}`);
  }

  const rowCount = data?.length ?? 0;
  if (rowCount === 0) {
    throw new Error(
      `Supabase scan lookup failed: scan_id ${scanId} wurde in accessibility_scans nicht gefunden. Vor dem workflow_dispatch muss die Zeile bereits existieren.`,
    );
  }

  if (rowCount > 1) {
    throw new Error(
      `Supabase scan lookup failed: scan_id ${scanId} ist in accessibility_scans nicht eindeutig (${rowCount} Treffer).`,
    );
  }
}

async function saveScanResults(
  supabase: SupabaseClient,
  scanId: string,
  data: {
    domain: string;
    pagesScanned: number;
    pagesScannedUrls: string[];
    findings: Finding[];
    rawResult: RawScanResult;
    score: number;
    counts: { critical: number; serious: number; moderate: number; minor: number };
    errorMessage?: string;
    normalizedBundle?: object;
  },
) {
  const totalFindings = data.findings.reduce((sum, f) => sum + f.element_count, 0);
  const expectedRawJsonLength = JSON.stringify(data.rawResult).length;
  const expectedPages = data.rawResult.pages?.length ?? 0;
  const expectedIssues = data.rawResult.totalIssues;

  const updatePayloadBase = {
    domain: data.domain,
    scan_date: new Date().toISOString(),
    pages_scanned: data.pagesScanned,
    pages_scanned_urls: data.pagesScannedUrls,
    total_findings: totalFindings,
    critical_count: data.counts.critical,
    serious_count: data.counts.serious,
    moderate_count: data.counts.moderate,
    minor_count: data.counts.minor,
    score: data.score,
    findings: data.findings,
    raw_scan_result: data.rawResult,
    status: 'completed',
    error_message: data.errorMessage || null,
    updated_at: new Date().toISOString(),
  };
  const updatePayloadWithManualChecks = {
    ...updatePayloadBase,
    manual_checks: data.rawResult.manual_checks ?? [],
  };
  const updatePayloadWithBundle = {
    ...updatePayloadWithManualChecks,
    normalized_bundle: data.normalizedBundle ?? null,
  };
  // Fallback-Flags: werden deaktiviert wenn die Spalte in Supabase fehlt
  let includeManualChecksColumn = true;
  let includeNormalizedBundle = data.normalizedBundle != null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let payload: object;
    if (includeNormalizedBundle && includeManualChecksColumn) {
      payload = updatePayloadWithBundle;
    } else if (includeManualChecksColumn) {
      payload = updatePayloadWithManualChecks;
    } else {
      payload = updatePayloadBase;
    }
    const { error: saveError } = await supabase
      .from('accessibility_scans')
      .update(payload)
      .eq('id', scanId);

    if (saveError) {
      const msg = String(saveError.message || '');
      const isMissingColumn = /(could not find|schema cache|column)/i.test(msg);

      if (includeNormalizedBundle && /normalized_bundle/i.test(msg) && isMissingColumn) {
        console.warn('  Hinweis: Spalte "normalized_bundle" fehlt in accessibility_scans. Migration noch nicht ausgefuehrt. Speichere ohne normalized_bundle.');
        includeNormalizedBundle = false;
        attempt--;
        continue;
      }

      if (includeManualChecksColumn && /manual_checks/i.test(msg) && isMissingColumn) {
        console.warn('  Hinweis: Spalte "manual_checks" fehlt in accessibility_scans. Speichere ohne Spalten-Update; Daten bleiben in raw_scan_result.manual_checks enthalten.');
        includeManualChecksColumn = false;
        attempt--;
        continue;
      }

      throw new Error(`Supabase save failed: ${saveError.message}`);
    }

    const { data: verifyRows, error: verifyError } = await supabase
      .from('accessibility_scans')
      .select('raw_scan_result')
      .eq('id', scanId);

    if (verifyError) {
      throw new Error(`Supabase verify failed: ${verifyError.message}`);
    }

    const verifyCount = verifyRows?.length ?? 0;
    if (verifyCount === 0) {
      throw new Error(
        `Supabase verify failed: scan_id ${scanId} wurde nach dem Speichern nicht gefunden. Wahrscheinlich existiert die Zeile nicht vor dem workflow_dispatch.`,
      );
    }

    if (verifyCount > 1) {
      throw new Error(
        `Supabase verify failed: scan_id ${scanId} ist nach dem Speichern nicht eindeutig (${verifyCount} Treffer).`,
      );
    }

    const verifyRow = verifyRows?.[0];
    const persisted = verifyRow?.raw_scan_result as RawScanResult | null;
    if (!persisted || typeof persisted !== 'object') {
      if (attempt === 2) {
        throw new Error('Supabase verify failed: raw_scan_result missing after save');
      }
      continue;
    }

    const persistedRawJsonLength = JSON.stringify(persisted).length;
    const persistedPages = persisted.pages?.length ?? 0;
    const persistedIssues = persisted.totalIssues;
    const isValid =
      persisted.pagesScanned === data.rawResult.pagesScanned &&
      persistedPages === expectedPages &&
      persistedIssues === expectedIssues &&
      persistedRawJsonLength >= expectedRawJsonLength;

    if (isValid) {
      return;
    }

    if (attempt === 2) {
      throw new Error(
        `Supabase verify failed: raw_scan_result mismatch (expected len=${expectedRawJsonLength}, pages=${expectedPages}, issues=${expectedIssues}; got len=${persistedRawJsonLength}, pages=${persistedPages}, issues=${String(persistedIssues)})`,
      );
    }
  }
}

// --- Main ---

async function main() {
  // Parse args — handle tsx's `--` separator
  const rawArgs = process.argv.slice(2).filter(a => a !== '--');
  const args = parseArgs(rawArgs);

  const rawDomain = args.domain;
  const clientId = args['client-id'];
  const scanId = args['scan-id'];
  const rawMaxPages = args['max-pages'] || '10';
  const maxPages = parseInt(rawMaxPages, 10);
  const scanType = args['scan-type'] === 'quick' ? 'quick' : 'full';
  const isLocal = args.local === true;

  if (!rawDomain) {
    console.error('Fehler: --domain ist erforderlich');
    console.error('Usage: tsx scripts/scan.ts --domain example.com [--client-id UUID] [--scan-id UUID] [--max-pages 10] [--local]');
    process.exit(1);
  }

  let normalized: NormalizedDomain;
  try {
    normalized = normalizeDomain(rawDomain);
  } catch (err) {
    console.error(`Fehler: ${(err as Error).message}`);
    process.exit(1);
  }
  const targetUrl = normalized.baseUrl;
  const domain = normalized.host;

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    console.error(`Fehler: --max-pages muss eine positive Ganzzahl sein (erhalten: ${rawMaxPages})`);
    process.exit(1);
  }

  // Supabase init (nur wenn nicht --local)
  let supabase: SupabaseClient | null = null;
  if (!isLocal) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      console.error('Fehler: SUPABASE_URL und SUPABASE_SERVICE_KEY muessen gesetzt sein (oder --local verwenden)');
      process.exit(1);
    }
    if (!scanId) {
      console.error('Fehler: --scan-id ist erforderlich (oder --local verwenden)');
      process.exit(1);
    }
    if (!clientId) {
      console.error('Fehler: --client-id ist erforderlich (oder --local verwenden)');
      process.exit(1);
    }
    if (!isUuid(scanId)) {
      console.error(`Fehler: --scan-id ist keine gueltige UUID (${scanId})`);
      process.exit(1);
    }
    if (!isUuid(clientId)) {
      console.error(`Fehler: --client-id ist keine gueltige UUID (${clientId})`);
      process.exit(1);
    }
    supabase = createClient(url, key);
    await assertSingleScanRowExists(supabase, scanId);
  }

  console.log(`\n  GreenOnion A11y Scanner — GitHub Actions Mode`);
  console.log(`  Domain: ${targetUrl}`);
  console.log(`  Max Pages: ${maxPages}`);
  console.log(`  Scan Type: ${scanType}`);
  console.log(`  Mode: ${isLocal ? 'local' : 'supabase'}`);
  if (scanId) console.log(`  Scan ID: ${scanId}`);
  if (clientId) console.log(`  Client ID: ${clientId}`);
  console.log('');

  // Set status to running
  if (supabase && scanId) {
    await updateScanStatus(supabase, scanId, 'running');
  }

  // Gesamt-Timeout: 5 Min. fuer Quick Scan, 10 Min. fuer Full Scan
  const timeoutMs = scanType === 'quick' ? 5 * 60 * 1000 : 10 * 60 * 1000;
  const timeoutLabel = scanType === 'quick' ? '5 Minuten' : '10 Minuten';
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Scan-Timeout: ${timeoutLabel} ueberschritten`)), timeoutMs);
  });

  try {
    // robots.txt pruefen
    const robotsCheck = await checkRobotsTxt(targetUrl);
    let effectiveMaxPages = maxPages;
    let warningMessage: string | undefined;

    if (!robotsCheck.allowed) {
      console.log(`  Warnung: ${robotsCheck.warning}`);
      effectiveMaxPages = 1;
      warningMessage = robotsCheck.warning;
    }

    // Domain erreichbar? Fallback von HEAD auf GET, falls HEAD vom Ziel nicht sauber unterstuetzt wird.
    try {
      await probeReachability(targetUrl);
    } catch (err) {
      const message = `Domain ${targetUrl} nicht erreichbar: ${(err as Error).message}`;
      console.error(`  ${message}`);
      if (supabase && scanId) {
        await updateScanStatus(supabase, scanId, 'failed', message);
      }
      process.exit(1);
    }

    // Scan ausfuehren (mit Timeout)
    const progressCallback = (supabase && scanId)
      ? async (done: number, _total: number) => {
          await updatePagesScanned(supabase, scanId, done);
        }
      : undefined;

    const scanResult = await Promise.race([
      scan({ url: targetUrl, maxPages: effectiveMaxPages, onProgress: progressCallback }) as Promise<RawScanResult>,
      timeoutPromise,
    ]);
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const checksForAgent = manualChecks.filter((check) => check.autoPassIfEmpty !== true);
    let enrichedScanResult: RawScanResult = scanResult;

    if (scanType === 'quick') {
      console.log('  LLM-Agent: Uebersprungen (Quick Scan).');
    } else if (!openaiApiKey) {
      console.warn('  Warnung: OPENAI_API_KEY fehlt - LLM-Agent wird uebersprungen.');
    } else {
      console.log('  LLM-Agent: Starte semantische Nachpruefung...');
      enrichedScanResult = await runAgentEvaluation(scanResult, openaiApiKey, checksForAgent);
      console.log('  LLM-Agent: Nachpruefung abgeschlossen.');
    }

    const finalScanResult: RawScanResult = enrichedScanResult;

    const evaluatedManualChecks = evaluateManualChecks(finalScanResult.pages, manualChecks, Boolean(openaiApiKey));
    const mergedManualChecks = mergeManualCheckEvidence(evaluatedManualChecks, finalScanResult.manual_checks);
    finalScanResult.manual_checks = mergedManualChecks;

    // Findings deduplizieren
    const findings = deduplicateFindingsFromPages(enrichedScanResult.pages) as Finding[];
    const scoreMetrics = deriveAccessibilityScoreMetrics({
      findings,
      pages_scanned: finalScanResult.pagesScanned,
    });
    const score = scoreMetrics.score;
    const counts = countSeverities(findings);
    const pagesScannedUrls = finalScanResult.pages.map((p: RawPage) => p.url);
    finalScanResult.score = score;

    console.log(`\n  Deduplizierte Findings: ${findings.length} Regeln`);
    console.log(`  Score: ${score}/100`);
    console.log(`  Critical: ${counts.critical}, Serious: ${counts.serious}, Moderate: ${counts.moderate}, Minor: ${counts.minor}`);

    const timestamp = Date.now();
    const outputBaseName = `scan_${domain.replace(/[^a-z0-9.-]/gi, '_')}_${timestamp}`;

    // Normalisierter Bundle — vor Save erzeugen, damit er in beide Pfade (lokal + Supabase) fliesst
    let normalizedBundle: ReturnType<typeof normalizeScan> | null = null;
    try {
      normalizedBundle = normalizeScan(
        finalScanResult as Parameters<typeof normalizeScan>[0],
        findings,
        mergedManualChecks as Parameters<typeof normalizeScan>[2],
      );
    } catch (bundleErr) {
      console.warn(`  Warnung: Normalisierung fehlgeschlagen, Bundle wird nicht gespeichert: ${(bundleErr as Error).message}`);
    }

    if (isLocal) {
      // Lokaler Modus: JSON-Datei speichern
      mkdirSync('output', { recursive: true });
      const outputPath = `output/${outputBaseName}.json`;
      const output = {
        domain,
        scan_date: new Date().toISOString(),
        pages_scanned: finalScanResult.pagesScanned,
        pages_scanned_urls: pagesScannedUrls,
        score,
        ...counts,
        total_findings: findings.reduce((sum, f) => sum + f.element_count, 0),
        findings,
        manual_checks: finalScanResult.manual_checks,
        warning: warningMessage,
      };
      writeFileSync(outputPath, JSON.stringify(output, null, 2));
      console.log(`\n  Ergebnis gespeichert: ${outputPath}\n`);
    } else if (supabase && scanId) {
      // Supabase-Modus — normalizedBundle wird mitgegeben (null = Migration noch nicht ausgefuehrt)
      await saveScanResults(supabase, scanId, {
        domain,
        pagesScanned: finalScanResult.pagesScanned,
        pagesScannedUrls,
        findings,
        rawResult: {
          ...finalScanResult,
          manual_checks: finalScanResult.manual_checks ?? [],
        },
        score,
        counts,
        errorMessage: warningMessage,
        normalizedBundle: normalizedBundle ?? undefined,
      });
      console.log(`\n  Ergebnis in Supabase gespeichert (Scan ${scanId})\n`);
    }

    // Normalisierter Bundle-Export (Phase B) — lokale JSON-Datei
    if (normalizedBundle) {
      try {
        mkdirSync('output', { recursive: true });
        const normalizedPath = `output/${outputBaseName}_normalized.json`;
        await exportNormalizedBundle(normalizedBundle, normalizedPath);
        console.log(`  Normalisierter Bundle gespeichert: ${normalizedPath}`);
        console.log(`  finding_instances: ${normalizedBundle.finding_instances.length}, automation_candidates: ${normalizedBundle.automation_candidates.length}\n`);
      } catch (exportErr) {
        // Datei-Export scheitert nie den Haupt-Scan
        console.warn(`  Warnung: Normalisierter Bundle-Export (Datei) fehlgeschlagen: ${(exportErr as Error).message}`);
      }
    }

  } catch (err) {
    const message = (err as Error).message || 'Unbekannter Fehler';
    console.error(`\n  Scan fehlgeschlagen: ${message}`);

    if (supabase && scanId) {
      await updateScanStatus(supabase, scanId, 'failed', message);
      console.log(`  Status 'failed' in Supabase gesetzt\n`);
    }

    process.exit(1);
  }
}

main();
