/**
 * Deterministische ID-Generatoren fuer Finding-Instances.
 *
 * Alle IDs sind SHA-256-basiert und stabil solange die Eingabewerte gleich bleiben.
 */

import { createHash } from 'crypto';

/**
 * Erzeugt eine deterministische finding_id fuer ein Finding.
 *
 * Stabil ueber mehrere Scans derselben Domain, solange rule_id und severity gleich bleiben.
 * Basis: rule_id + domain (Hostname ohne www) + severity
 */
export function generateFindingId(ruleId: string, domain: string, severity: string): string {
  const normalizedDomain = domain.replace(/^www\./i, '').toLowerCase();
  const hash = createHash('sha256')
    .update(`${ruleId}::${normalizedDomain}::${severity}`)
    .digest('hex')
    .substring(0, 12);
  return `find-${hash}`;
}

/**
 * Erzeugt eine deterministische instance_id fuer eine konkrete Elementinstanz.
 *
 * Stabil solange selector, page_url (ohne Query/Fragment) und rule_id unveraendert bleiben.
 * Basis: rule_id + page_url (normiert) + selector
 */
export function generateInstanceId(ruleId: string, pageUrl: string, selector: string): string {
  // URL normieren: Fragment und Query entfernen fuer Stabilitaet ueber Scans
  let normalizedUrl = pageUrl;
  try {
    const u = new URL(pageUrl);
    normalizedUrl = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Ungueltige URL — unveraendert verwenden
  }

  const hash = createHash('sha256')
    .update(`${ruleId}::${normalizedUrl}::${selector}`)
    .digest('hex')
    .substring(0, 12);
  return `inst-${hash}`;
}

/**
 * Erzeugt eine scenario_id als Platzhalter fuer Phase A.
 *
 * In Phase C/D wird sie durch echte Flow-/Komponentenlogik ersetzt.
 * Basis: instance_id mit 'scn-' Prefix.
 */
export function generateScenarioId(instanceId: string): string {
  return instanceId.replace(/^inst-/, 'scn-');
}
