import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { NormalizedScanBundle } from '../src/reporting/types.js';
import {
  assertBundleReadyForPersistence,
  isBundleRequiredForScan,
  verifyPersistedNormalizedBundle,
} from '../src/reporting/normalized-bundle-persistence.js';

function buildBundle(overrides: Partial<NormalizedScanBundle> = {}): NormalizedScanBundle {
  return {
    meta: {
      report_id: 'rpt-test',
      generated_at: '2026-04-14T08:00:00.000Z',
      scanner_version: '2.0',
      domain: 'example.com',
      scan_date: '2026-04-14T08:00:00.000Z',
      mode: 'public',
      bundle_version: '1.0-alpha',
      scan_id: '627e4833-60d4-44e4-8608-43856260e13b',
    },
    executive_summary: {
      score: 77,
      risk_level: 'medium',
      pages_scanned: 10,
      total_findings: 907,
      severity_counts: {
        critical: 1,
        serious: 2,
        moderate: 3,
        minor: 4,
      },
      evidence_breakdown: {
        automatic_findings: 10,
        manual_check_findings: 2,
        ai_verified_findings: 1,
        needs_human_review: 3,
      },
      top_wcag_areas: [],
    },
    finding_instances: [
      {
        instance_id: 'inst-1',
        finding_id: 'find-1',
        page_url: 'https://example.com',
        page_type: 'home',
        component_type: 'button',
        review_state: 'scanner_finding',
        scanner_source: 'axe-core',
        severity: 'serious',
        rule_id: 'button-name',
        wcag_sc: ['4.1.2'],
        locator_primary: { type: 'css', value: '#cta' },
        locator_fallbacks: [],
        html_snippet: '<button id="cta"></button>',
        dom_snapshot: null,
        confidence: 'high',
      },
    ],
    automation_candidates: [
      {
        finding_id: 'find-1',
        instance_id: 'inst-1',
        scenario_id: 'scn-1',
        nvda_candidate: true,
        sr_relevance: 'sr_direct',
        page_url: 'https://example.com',
        page_type: 'home',
        component_type: 'button',
        rule_id: 'button-name',
        wcag_sc: ['4.1.2'],
        severity: 'serious',
        scan_source: 'axe-core',
        locator_primary: { type: 'css', value: '#cta' },
        locator_fallbacks: [],
        dom_snapshot: null,
        preconditions: [],
        action_sequence: [],
        expected_role_state: [],
        expected_speech_tokens: [],
        confidence: 'high',
        retest_strategy: 'dom_only',
      },
    ],
    ...overrides,
  };
}

describe('normalized bundle persistence guard', () => {
  test('fordert Bundle fuer vollstaendigen Full-Scan im Supabase-Modus', () => {
    const required = isBundleRequiredForScan({
      isLocal: false,
      scanType: 'full',
      rawResult: {
        pagesScanned: 10,
        pages: Array.from({ length: 10 }, (_, idx) => ({ url: `https://example.com/${idx}` })),
      },
    });

    assert.equal(required, true);
  });

  test('wirft klaren Fehler, wenn erforderliches Bundle fehlt', () => {
    assert.throws(
      () => assertBundleReadyForPersistence(null, {
        isLocal: false,
        scanType: 'full',
        scanId: '627e4833-60d4-44e4-8608-43856260e13b',
        rawResult: {
          pagesScanned: 10,
          pages: Array.from({ length: 10 }, (_, idx) => ({ url: `https://example.com/${idx}` })),
        },
      }),
      /Normalized bundle fehlt/,
    );
  });

  test('erkennt fehlendes persistiertes Bundle', () => {
    const result = verifyPersistedNormalizedBundle(buildBundle(), null);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /missing after save/);
  });

  test('erkennt verkuerztes oder beschaedigtes persistiertes Bundle', () => {
    const bundle = buildBundle();
    const result = verifyPersistedNormalizedBundle(bundle, {
      ...bundle,
      automation_candidates: [],
    });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /automation_candidates mismatch/);
  });
});
