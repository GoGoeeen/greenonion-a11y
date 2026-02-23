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
import { scan } from '../scanner.js';
import { runAgentEvaluation } from './agent.js';
import { manualChecks, type ManualCheckDefinition } from './manual-checks.js';
import { writeFileSync, mkdirSync } from 'fs';

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
  wcag_criteria: string[];
  status: ComplianceStatus;
  status_label: string;
  description: string;
  agent_descriptions: string[];
  affected_pages: string[];
}

interface CliArgs {
  domain?: string;
  'client-id'?: string;
  'scan-id'?: string;
  'max-pages'?: string;
  local?: boolean;
  [key: string]: string | boolean | undefined;
}

interface NormalizedDomain {
  baseUrl: string;
  host: string;
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

// --- Score Calculation (deduplizierte Findings) ---

function calculateScore(findings: Finding[]): number {
  const weights: Record<string, number> = { critical: 15, serious: 8, moderate: 3, minor: 1 };
  let penalty = 0;
  for (const f of findings) {
    const weight = weights[f.severity] ?? 1;
    penalty += weight * Math.min(f.element_count, 10);
  }
  return Math.max(0, Math.round(100 - (penalty / 200) * 100));
}

// --- WCAG-Tag Extraction ---

function extractWcagCriteria(tags: string[]): string[] {
  const criteria: string[] = [];
  for (const tag of tags) {
    // z.B. 'wcag412' → '4.1.2', 'wcag131' → '1.3.1'
    const match = tag.match(/^wcag(\d)(\d)(\d+)$/);
    if (match) {
      criteria.push(`${match[1]}.${match[2]}.${match[3]}`);
    }
  }
  return criteria;
}

// --- Deduplicate Findings Across Pages ---

interface RawIssue {
  rule: string;
  severity: string;
  engine?: string;
  description: string;
  help?: string;
  helpUrl?: string;
  wcag?: string;
  wcagTags?: string[];
  nodes?: Array<{ selector: string; html?: string; failureSummary?: string }>;
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

function deduplicateFindings(pages: RawPage[]): Finding[] {
  const map = new Map<string, Finding>();

  for (const page of pages) {
    for (const issue of page.issues) {
      // Skip error markers
      if (issue.rule === '_error') continue;

      const key = issue.rule;
      const existing = map.get(key);

      const nodeCount = issue.nodes?.length || 1;
      const wcagTags = issue.wcagTags || [];
      const wcagCriteria = extractWcagCriteria(wcagTags);

      // Wenn wcag-Feld direkt vorhanden (z.B. bei Custom Checks)
      if (issue.wcag && wcagCriteria.length === 0) {
        for (const sc of issue.wcag.split('/').map(s => s.trim())) {
          if (sc && !wcagCriteria.includes(sc)) {
            wcagCriteria.push(sc);
          }
        }
      }

      const exampleNode = issue.nodes?.[0];
      const exampleHtml = (exampleNode?.html || '').substring(0, 200);

      if (existing) {
        existing.element_count += nodeCount;
        if (!existing.affected_pages.includes(page.url)) {
          existing.affected_pages.push(page.url);
        }
        // Merge WCAG criteria
        for (const c of wcagCriteria) {
          if (!existing.wcag_criteria.includes(c)) {
            existing.wcag_criteria.push(c);
          }
        }
      } else {
        map.set(key, {
          rule_id: issue.rule,
          severity: (issue.severity as Finding['severity']) || 'moderate',
          wcag_criteria: wcagCriteria,
          description: issue.description || issue.help || issue.rule,
          affected_pages: [page.url],
          element_count: nodeCount,
          example_html: exampleHtml,
          example_url: page.url,
        });
      }
    }
  }

  return [...map.values()];
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
  return checks.map((check) => {
    const failPages = new Set<string>();
    const failDescriptions: string[] = [];
    let hasApplicableCandidates = false;

    for (const page of pages) {
      const pageIssues = Array.isArray(page.issues) ? page.issues : [];
      const pageIncomplete = Array.isArray(page.incomplete) ? page.incomplete : [];

      if (check.appliesTo.includes('suspicious-alt-text')) {
        const hasSuspiciousCandidates = pageIssues.some((i) => i.rule === 'suspicious-alt-text');
        if (hasSuspiciousCandidates) hasApplicableCandidates = true;
      }

      if (check.appliesTo.includes('incomplete')) {
        const relevantIncomplete = pageIncomplete.filter((issue) => {
          const wcagList = getIssueWcagCriteria(issue);
          if (wcagList.length === 0) return true;
          return wcagList.includes(check.wcag);
        });
        if (relevantIncomplete.length > 0) {
          hasApplicableCandidates = true;
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
        }
      }
    }

    if (failDescriptions.length > 0) {
      return {
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag_criteria: [check.wcag],
        status: 'Fail',
        status_label: 'Fail',
        description: 'Agent hat einen Verstoess zu diesem Check erkannt.',
        agent_descriptions: failDescriptions,
        affected_pages: [...failPages],
      };
    }

    if (aiEvaluated && hasApplicableCandidates) {
      return {
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag_criteria: [check.wcag],
        status: 'Pass',
        status_label: 'Verified by AI - Pass',
        description: 'Kein Verstoess erkannt.',
        agent_descriptions: [],
        affected_pages: [],
      };
    }

    return {
      id: check.id,
      rule: check.rule,
      category: check.category,
      wcag_criteria: [check.wcag],
      status: 'Needs Human Review',
      status_label: 'Needs Human Review',
      description: hasApplicableCandidates
        ? 'Automatische Bewertung nicht eindeutig, manuelle Pruefung erforderlich.'
        : 'Fuer diesen Check lagen keine verifizierbaren Kandidaten vor.',
      agent_descriptions: [],
      affected_pages: [],
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

function calculateManualCheckPenalty(
  checks: ManualCheckResult[],
  findings: Finding[],
): number {
  const findingWcag = new Set(findings.flatMap((f) => f.wcag_criteria || []));
  let penalty = 0;
  for (const check of checks) {
    if (check.status !== 'Fail') continue;
    const wcag = check.wcag_criteria[0];
    if (!wcag || findingWcag.has(wcag)) continue;
    // Fallback: falls ein Agent-Fail nicht in deduplizierten Findings gelandet ist,
    // geben wir denselben Basispunktabzug wie bei einem moderaten Finding.
    penalty += 3;
  }
  return penalty;
}

// --- Supabase Update Helpers ---

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
  },
) {
  const totalFindings = data.findings.reduce((sum, f) => sum + f.element_count, 0);
  const expectedRawJsonLength = JSON.stringify(data.rawResult).length;
  const expectedPages = data.rawResult.pages?.length ?? 0;
  const expectedIssues = data.rawResult.totalIssues;

  const updatePayload = {
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

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { error: saveError } = await supabase
      .from('accessibility_scans')
      .update(updatePayload)
      .eq('id', scanId);

    if (saveError) {
      throw new Error(`Supabase save failed: ${saveError.message}`);
    }

    const { data: verifyRow, error: verifyError } = await supabase
      .from('accessibility_scans')
      .select('raw_scan_result')
      .eq('id', scanId)
      .single();

    if (verifyError) {
      throw new Error(`Supabase verify failed: ${verifyError.message}`);
    }

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
  const maxPages = parseInt(args['max-pages'] || '5', 10);
  const isLocal = args.local === true;

  if (!rawDomain) {
    console.error('Fehler: --domain ist erforderlich');
    console.error('Usage: tsx scripts/scan.ts --domain example.com [--client-id UUID] [--scan-id UUID] [--max-pages 5] [--local]');
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
    supabase = createClient(url, key);
  }

  console.log(`\n  GreenOnion A11y Scanner — GitHub Actions Mode`);
  console.log(`  Domain: ${targetUrl}`);
  console.log(`  Max Pages: ${maxPages}`);
  console.log(`  Mode: ${isLocal ? 'local' : 'supabase'}`);
  if (scanId) console.log(`  Scan ID: ${scanId}`);
  console.log('');

  // Set status to running
  if (supabase && scanId) {
    await updateScanStatus(supabase, scanId, 'running');
  }

  // Gesamt-Timeout: 5 Minuten
  const timeoutMs = 5 * 60 * 1000;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Scan-Timeout: 5 Minuten ueberschritten')), timeoutMs);
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

    // Domain erreichbar?
    try {
      const probe = await fetch(targetUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      if (!probe.ok && probe.status >= 500) {
        throw new Error(`Server antwortet mit Status ${probe.status}`);
      }
    } catch (err) {
      const message = `Domain ${targetUrl} nicht erreichbar: ${(err as Error).message}`;
      console.error(`  ${message}`);
      if (supabase && scanId) {
        await updateScanStatus(supabase, scanId, 'failed', message);
      }
      process.exit(1);
    }

    // Scan ausfuehren (mit Timeout)
    const scanResult = await Promise.race([
      scan({ url: targetUrl, maxPages: effectiveMaxPages }) as Promise<RawScanResult>,
      timeoutPromise,
    ]);
    const openaiApiKey = process.env.OPENAI_API_KEY;
    let enrichedScanResult: RawScanResult = scanResult;

    if (!openaiApiKey) {
      console.warn('  Warnung: OPENAI_API_KEY fehlt - LLM-Agent wird uebersprungen.');
    } else {
      console.log('  LLM-Agent: Starte semantische Nachpruefung...');
      enrichedScanResult = await runAgentEvaluation(scanResult, openaiApiKey, manualChecks);
      console.log('  LLM-Agent: Nachpruefung abgeschlossen.');
    }

    const finalScanResult: RawScanResult = enrichedScanResult;

    finalScanResult.manual_checks = evaluateManualChecks(finalScanResult.pages, manualChecks, Boolean(openaiApiKey));

    // Findings deduplizieren
    const findings = deduplicateFindings(enrichedScanResult.pages);
    const baseScore = calculateScore(findings);
    const manualPenalty = calculateManualCheckPenalty(finalScanResult.manual_checks, findings);
    const score = Math.max(0, baseScore - manualPenalty);
    const counts = countSeverities(findings);
    const pagesScannedUrls = finalScanResult.pages.map((p: RawPage) => p.url);

    console.log(`\n  Deduplizierte Findings: ${findings.length} Regeln`);
    console.log(`  Score: ${score}/100`);
    console.log(`  Critical: ${counts.critical}, Serious: ${counts.serious}, Moderate: ${counts.moderate}, Minor: ${counts.minor}`);

    if (isLocal) {
      // Lokaler Modus: JSON-Datei speichern
      mkdirSync('output', { recursive: true });
      const outputPath = `output/scan_${domain.replace(/[^a-z0-9.-]/gi, '_')}_${Date.now()}.json`;
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
      // Supabase-Modus
      await saveScanResults(supabase, scanId, {
        domain,
        pagesScanned: finalScanResult.pagesScanned,
        pagesScannedUrls,
        findings,
        rawResult: finalScanResult,
        score,
        counts,
        errorMessage: warningMessage,
      });
      console.log(`\n  Ergebnis in Supabase gespeichert (Scan ${scanId})\n`);
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
