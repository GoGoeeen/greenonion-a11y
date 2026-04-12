/**
 * Screen-Reader-Relevanz-Klassifikator.
 *
 * Bestimmt per regelbasierter Lookup-Tabelle:
 * - sr_relevance:        Wie testbar ist das Finding mit einem Screen Reader?
 * - nvda_candidate:      Ist automatisches NVDA-Testing sinnvoll?
 * - retest_strategy:     Wie soll das Finding getestet werden?
 * - confidence:          Wie sicher ist die Klassifikation?
 * - manual_review_reason: Warum braucht dieses Finding manuelle Pruefung?
 *
 * Basiert auf: docs/a11y-report-3-layer-architecture.md Section 6 (NVDA-Tauglichkeit)
 */

import type { SrRelevance, ConfidenceLevel, RetestStrategy } from '../reporting/types.js';

export interface SrClassification {
  sr_relevance: SrRelevance;
  nvda_candidate: boolean;
  retest_strategy: RetestStrategy;
  confidence: ConfidenceLevel;
  manual_review_reason?: string;
}

type SrRuleEntry = Omit<SrClassification, 'nvda_candidate'>;

// Zentrale SR-Relevanz-Lookup-Tabelle
const SR_RULE_MAP: Readonly<Record<string, SrRuleEntry>> = {

  // === sr_direct: Direkt NVDA-testbar ===
  // Labels & Accessible Names — fehlende Namen sind direkt in NVDA-Ausgabe pruefbar

  'label': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'label-content-name-mismatch': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'button-name': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'link-name': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'image-alt': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'image-redundant-alt': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'select-name': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'aria-label': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'aria-labelledby': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'aria-command-name': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'orphaned-label': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'empty-heading': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'role-img-alt': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'object-alt': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'aria-allowed-attr': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },
  'aria-required-attr': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },
  'aria-valid-attr-value': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },

  // Seiten-Titel & Sprache — direkt vorhersagbar in NVDA
  'document-title': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'page-title-empty': { sr_relevance: 'sr_direct', retest_strategy: 'nvda_voice_assert', confidence: 'high' },
  'html-has-lang': { sr_relevance: 'sr_direct', retest_strategy: 'dom_only', confidence: 'high' },
  'html-lang-valid': { sr_relevance: 'sr_direct', retest_strategy: 'dom_only', confidence: 'high' },
  'html-lang': { sr_relevance: 'sr_direct', retest_strategy: 'dom_only', confidence: 'high' },
  'html-xml-lang-mismatch': { sr_relevance: 'sr_direct', retest_strategy: 'dom_only', confidence: 'high' },

  // === sr_indirect: Bedingt NVDA-testbar ===

  // Ueberschriften & Struktur — testbar, aber braucht Navigationskontext
  'heading-order': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'page-has-heading-one': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'heading-hierarchy': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },

  // Skip Links & Landmarks
  'bypass': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'skip-link': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'landmark-one-main': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'landmark-main-is-top-level': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'landmark-complementary-is-top-level': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'landmark-no-duplicate-banner': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'landmark-no-duplicate-contentinfo': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },
  'region': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },

  // Fokus & Tastaturnavigation
  'focus-visible': {
    sr_relevance: 'sr_indirect',
    retest_strategy: 'keyboard_only',
    confidence: 'medium',
    manual_review_reason: 'Fokus-Indikatoren sind primär visuell; SR-Relevanz besteht nur bei fehlendem Fokus-Management.',
  },
  'focus-order-semantics': { sr_relevance: 'sr_indirect', retest_strategy: 'keyboard_only', confidence: 'medium' },

  // Tabellen (strukturell SR-relevant, aber braucht Navigationskontext)
  'table-duplicate-name': { sr_relevance: 'sr_indirect', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },
  'th-has-data-cells': { sr_relevance: 'sr_indirect', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },
  'td-headers-attr': { sr_relevance: 'sr_indirect', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },
  'scope-attr-valid': { sr_relevance: 'sr_indirect', retest_strategy: 'nvda_voice_assert', confidence: 'medium' },

  // Keyboard Trap
  'keyboard-trap': {
    sr_relevance: 'sr_indirect',
    retest_strategy: 'keyboard_only',
    confidence: 'medium',
    manual_review_reason: 'Keyboard-Traps muessen manuell verifiziert werden — automatische Erkennung ist heuristisch.',
  },

  // === sr_not_suitable: Nicht NVDA-testbar ===

  'color-contrast': {
    sr_relevance: 'sr_not_suitable',
    retest_strategy: 'dom_only',
    confidence: 'high',
    manual_review_reason: 'Farbkontrast ist rein visuell — kein Screen-Reader-Test moeglich.',
  },
  'text-spacing-override': {
    sr_relevance: 'sr_not_suitable',
    retest_strategy: 'dom_only',
    confidence: 'high',
    manual_review_reason: 'Text-Spacing ist rein visuell — kein Screen-Reader-Test moeglich.',
  },
  'reflow-320px': {
    sr_relevance: 'sr_not_suitable',
    retest_strategy: 'dom_only',
    confidence: 'high',
    manual_review_reason: 'Reflow-Probleme sind rein visuell — kein Screen-Reader-Test moeglich.',
  },
  'reduced-motion': {
    sr_relevance: 'sr_not_suitable',
    retest_strategy: 'dom_only',
    confidence: 'high',
    manual_review_reason: 'Animation / Reduced-Motion ist rein visuell — kein Screen-Reader-Test moeglich.',
  },
  'justified-text': {
    sr_relevance: 'sr_not_suitable',
    retest_strategy: 'dom_only',
    confidence: 'high',
    manual_review_reason: 'Blocksatz ist rein visuell — kein Screen-Reader-Test moeglich.',
  },

  // === manual_only: Qualitative Pruefung erforderlich ===

  'suspicious-alt-text': {
    sr_relevance: 'manual_only',
    retest_strategy: 'manual',
    confidence: 'low',
    manual_review_reason: 'Alt-Text-Qualitaet ist semantisch — maschinelle Beurteilung nicht ausreichend; AI oder Mensch erforderlich.',
  },
  'redundant-link': {
    sr_relevance: 'manual_only',
    retest_strategy: 'manual',
    confidence: 'low',
    manual_review_reason: 'Redundante Links benoetigen inhaltliche Kontextbeurteilung.',
  },
};

// Default fuer unbekannte Regeln (konservativer Default)
const DEFAULT_CLASSIFICATION: SrRuleEntry = {
  sr_relevance: 'needs_flow_context',
  retest_strategy: 'manual',
  confidence: 'low',
  manual_review_reason: 'Regel nicht in SR-Klassifikationstabelle — manuelle Einordnung erforderlich.',
};

/**
 * Klassifiziert SR-Relevanz, NVDA-Kandidatur und Retest-Strategie fuer eine Regel.
 *
 * Fuer LLM-Agent-Issues: immer manual_only (AI-Issues brauchen menschliche Verifikation).
 * Fuer unbekannte Regeln: needs_flow_context (konservativer Default).
 */
export function classifySrRelevance(ruleId: string, engine?: string): SrClassification {
  // LLM-Agent-Issues sind per Definition manuell
  if (engine === 'llm-agent') {
    return {
      sr_relevance: 'manual_only',
      nvda_candidate: false,
      retest_strategy: 'manual',
      confidence: 'low',
      manual_review_reason: 'LLM-Agent-Findings benoetigen manuelle Verifikation.',
    };
  }

  const base = SR_RULE_MAP[ruleId] ?? DEFAULT_CLASSIFICATION;
  const nvda_candidate = base.sr_relevance === 'sr_direct';

  return { ...base, nvda_candidate };
}
