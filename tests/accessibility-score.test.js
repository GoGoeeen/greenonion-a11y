import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAccessibilityScoreMetrics } from '../scripts/accessibility-score.js';

test('moderate and serious findings do not collapse to zero by repetition alone', () => {
  const findings = [
    { rule_id: 'serious-1', severity: 'serious', element_count: 8 },
    { rule_id: 'serious-2', severity: 'high', element_count: 7 },
    { rule_id: 'serious-3', severity: 'serious', element_count: 9 },
    { rule_id: 'serious-4', severity: 'serious', element_count: 6 },
    { rule_id: 'moderate-1', severity: 'moderate', element_count: 5 },
    { rule_id: 'moderate-2', severity: 'medium', element_count: 6 },
    { rule_id: 'moderate-3', severity: 'moderate', element_count: 4 },
    { rule_id: 'moderate-4', severity: 'moderate', element_count: 8 },
    { rule_id: 'moderate-5', severity: 'moderate', element_count: 5 },
    { rule_id: 'moderate-6', severity: 'moderate', element_count: 4 },
    { rule_id: 'moderate-7', severity: 'moderate', element_count: 3 },
    { rule_id: 'moderate-8', severity: 'moderate', element_count: 5 },
  ];

  const metrics = deriveAccessibilityScoreMetrics({
    findings,
    pages_scanned: 10,
  });

  assert.equal(metrics.uniqueSerious, 4);
  assert.equal(metrics.uniqueModerate, 8);
  assert.equal(metrics.affectedElements, 70);
  assert.equal(metrics.score, 67);
  assert.ok(metrics.score > 0);
});

test('heavy critical findings can still produce a very low score', () => {
  const findings = Array.from({ length: 10 }, (_, index) => ({
    rule_id: `critical-${index + 1}`,
    severity: 'critical',
    element_count: 20,
  }));

  const metrics = deriveAccessibilityScoreMetrics({
    findings,
    pages_scanned: 1,
  });

  assert.equal(metrics.uniqueCritical, 10);
  assert.equal(metrics.affectedElements, 200);
  assert.equal(metrics.score, 0);
});

test('moedling-like data resolves to 41 with raw results fallback parsing', () => {
  const violations = [
    ...Array.from({ length: 9 }, (_, index) => ({
      ruleId: `serious-${index + 1}`,
      severity: index % 2 === 0 ? 'serious' : 'high',
      occurrences: index === 8 ? 40 : 42,
    })),
    ...Array.from({ length: 14 }, (_, index) => ({
      violationId: `moderate-${index + 1}`,
      severity: index % 2 === 0 ? 'moderate' : 'medium',
      count: index === 13 ? 57 : 54,
    })),
  ];

  const metrics = deriveAccessibilityScoreMetrics({
    pages_scanned: 10,
    raw_scan_result: {
      results: {
        violations,
      },
    },
  });

  assert.equal(metrics.uniqueSerious, 9);
  assert.equal(metrics.uniqueModerate, 14);
  assert.equal(metrics.uniqueFindings, 23);
  assert.equal(metrics.affectedElements, 1135);
  assert.equal(metrics.score, 41);
});
