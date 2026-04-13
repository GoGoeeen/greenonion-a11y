/**
 * NVDA-Szenario-Builder (Phase D).
 *
 * Befuellt die bisher leeren Felder in AutomationCandidates:
 *   preconditions[]         — Seiten-/Auth-Vorbedingungen
 *   action_sequence[]       — NVDA-Tastaturschritte
 *   expected_role_state[]   — ARIA-Rolle + Zustand
 *   expected_speech_tokens[]— Erwartete NVDA-Ausgabe-Tokens
 *   expected_navigation_outcome — Endzustand nach Interaktion
 *
 * Wird nur fuer sr_direct und sr_indirect aufgerufen.
 * needs_flow_context bleibt leer (Phase E).
 * Alle Ergebnisse sind heuristisch markiert.
 */

import { getActionSequence }       from './action-sequences.js';
import { extractSpeechTokens, extractNavigationOutcome } from './speech-extractor.js';
import { detectPreconditions }     from './precondition-detector.js';
import { mapRoleState }            from './role-state-mapper.js';
import type { AutomationCandidate, SrRelevance } from '../reporting/types.js';

export interface NvdaScenarioFields {
  preconditions:              string[];
  action_sequence:            AutomationCandidate['action_sequence'];
  expected_role_state:        string[];
  expected_speech_tokens:     string[];
  expected_navigation_outcome?: string;
}

/**
 * Baut ein NVDA-Szenario fuer einen AutomationCandidaten.
 *
 * @param candidate  AutomationCandidate (vor Phase-D-Anreicherung)
 * @param htmlSnippet HTML-Snippet des betroffenen Elements (aus FindingInstance)
 * @returns          Befuellte NvdaScenarioFields oder null fuer needs_flow_context
 */
export function buildNvdaScenario(
  candidate: Pick<AutomationCandidate,
    'rule_id' | 'sr_relevance' | 'page_type' | 'component_type'
  >,
  pageUrl: string,
  htmlSnippet: string,
): NvdaScenarioFields | null {
  const { rule_id, sr_relevance, page_type, component_type } = candidate;

  // needs_flow_context und leere sr_relevance → kein Szenario in Phase D
  if (!sr_relevance || sr_relevance === 'needs_flow_context') {
    return null;
  }

  // Nur sr_direct und sr_indirect bekommen Szenarien in Phase D
  if (sr_relevance !== 'sr_direct' && sr_relevance !== 'sr_indirect') {
    return null;
  }

  const preconditions = detectPreconditions(
    page_type ?? 'unknown',
    pageUrl,
    rule_id,
  );

  const action_sequence = getActionSequence(
    rule_id,
    sr_relevance as 'sr_direct' | 'sr_indirect',
  );

  const expected_role_state = mapRoleState(
    component_type ?? 'unknown',
    htmlSnippet,
    rule_id,
  );

  const expected_speech_tokens = extractSpeechTokens(htmlSnippet, rule_id);

  const expected_navigation_outcome = extractNavigationOutcome(
    htmlSnippet,
    rule_id,
    component_type ?? 'unknown',
  );

  return {
    preconditions,
    action_sequence,
    expected_role_state,
    expected_speech_tokens,
    expected_navigation_outcome,
  };
}

/**
 * Gibt an ob fuer eine sr_relevance ein Szenario generiert werden kann.
 */
export function canBuildScenario(srRelevance: SrRelevance): boolean {
  return srRelevance === 'sr_direct' || srRelevance === 'sr_indirect';
}
