function normalizeSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'serious' || normalized === 'high') return 'serious';
  if (normalized === 'moderate' || normalized === 'medium') return 'moderate';
  return 'minor';
}

function getRuleId(source) {
  const candidates = [
    source?.id,
    source?.ruleId,
    source?.rule_id,
    source?.rule,
    source?.violationId,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }

  return 'unknown-rule';
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getAffectedElements(source) {
  if (Array.isArray(source?.nodes)) {
    return Math.max(1, source.nodes.length);
  }

  const candidates = [
    source?.count,
    source?.nodeCount,
    source?.occurrences,
    source?.elements,
    source?.element_count,
  ];

  for (const candidate of candidates) {
    const parsed = toPositiveNumber(candidate);
    if (parsed > 0) return Math.max(1, Math.round(parsed));
  }

  return 1;
}

export function extractWcagCriteria(tags) {
  const criteria = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    const match = String(tag).match(/^wcag(\d)(\d)(\d+)$/);
    if (match) {
      criteria.push(`${match[1]}.${match[2]}.${match[3]}`);
    }
  }
  return criteria;
}

export function deduplicateFindingsFromPages(pages) {
  const map = new Map();

  for (const page of Array.isArray(pages) ? pages : []) {
    for (const issue of Array.isArray(page?.issues) ? page.issues : []) {
      if (issue?.rule === '_error') continue;

      const key = getRuleId(issue);
      const existing = map.get(key);
      const nodeCount = getAffectedElements(issue);
      const wcagTags = Array.isArray(issue?.wcagTags) ? issue.wcagTags : [];
      const wcagCriteria = extractWcagCriteria(wcagTags);

      if (issue?.wcag && wcagCriteria.length === 0) {
        for (const sc of String(issue.wcag).split('/').map((value) => value.trim())) {
          if (sc && !wcagCriteria.includes(sc)) {
            wcagCriteria.push(sc);
          }
        }
      }

      const exampleNode = Array.isArray(issue?.nodes) ? issue.nodes[0] : undefined;
      const exampleHtml = String(exampleNode?.html || '').substring(0, 200);

      if (existing) {
        existing.element_count += nodeCount;
        if (!existing.affected_pages.includes(page.url)) {
          existing.affected_pages.push(page.url);
        }
        for (const criterion of wcagCriteria) {
          if (!existing.wcag_criteria.includes(criterion)) {
            existing.wcag_criteria.push(criterion);
          }
        }
        continue;
      }

      map.set(key, {
        rule_id: key,
        severity: normalizeSeverity(issue?.severity),
        wcag_criteria: wcagCriteria,
        description: issue?.description || issue?.help || key,
        affected_pages: [page.url],
        element_count: nodeCount,
        example_html: exampleHtml,
        example_url: page.url,
      });
    }
  }

  return [...map.values()];
}

function getPagesScanned(scan) {
  return Math.max(
    1,
    Number(
      scan?.pages_scanned ??
      scan?.pagesScanned ??
      scan?.raw_scan_result?.pages_scanned ??
      scan?.raw_scan_result?.pagesScanned,
    ) || 1,
  );
}

function getViolations(scan) {
  const candidates = [
    scan?.findings,
    scan?.violations,
    scan?.raw_scan_result?.violations,
    scan?.raw_scan_result?.results?.violations,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

export function deriveAccessibilityScoreMetrics(scan) {
  const pagesScanned = getPagesScanned(scan);
  const violations = getViolations(scan);
  const uniqueBySeverityAndRule = new Set();
  const uniqueRulesBySeverity = {
    critical: new Set(),
    serious: new Set(),
    moderate: new Set(),
    minor: new Set(),
  };
  let affectedElements = 0;

  for (const violation of violations) {
    const ruleId = getRuleId(violation);
    const severity = normalizeSeverity(violation?.severity);
    uniqueBySeverityAndRule.add(`${severity}::${ruleId}`);
    uniqueRulesBySeverity[severity].add(ruleId);
    affectedElements += getAffectedElements(violation);
  }

  const uniqueCritical = uniqueRulesBySeverity.critical.size;
  const uniqueSerious = uniqueRulesBySeverity.serious.size;
  const uniqueModerate = uniqueRulesBySeverity.moderate.size;
  const uniqueMinor = uniqueRulesBySeverity.minor.size;
  const uniqueFindings = uniqueBySeverityAndRule.size;
  const ratioElementsPerFinding = uniqueFindings > 0 ? affectedElements / uniqueFindings : 1;

  const weightedUniqueFindings =
    uniqueCritical * 24 +
    uniqueSerious * 13 +
    uniqueModerate * 6 +
    uniqueMinor * 2;

  const uniquePenaltyBase =
    100 * (1 - Math.exp(-((weightedUniqueFindings / pagesScanned) / 35)));

  const repetitionRatio = Math.max(1, ratioElementsPerFinding || 1);
  const repetitionPenalty = Math.min(12, Math.log1p(repetitionRatio - 1) * 4.5);

  const expectedUniqueForScope = pagesScanned * 1.5;
  const excessUniqueFindings = Math.max(0, uniqueFindings - expectedUniqueForScope);
  const uniqueVolumePenalty = 10 * (1 - Math.exp(-excessUniqueFindings / 18));

  const penalty = uniquePenaltyBase + repetitionPenalty + uniqueVolumePenalty;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  return {
    pagesScanned,
    affectedElements,
    ratioElementsPerFinding,
    uniqueCritical,
    uniqueSerious,
    uniqueModerate,
    uniqueMinor,
    uniqueFindings,
    weightedUniqueFindings,
    uniquePenaltyBase,
    repetitionPenalty,
    uniqueVolumePenalty,
    penalty,
    score,
  };
}

export function calculateAccessibilityScore(scan) {
  return deriveAccessibilityScoreMetrics(scan).score;
}
