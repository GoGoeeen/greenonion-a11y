/**
 * Heuristischer Component-Type-Klassifikator.
 *
 * Bestimmt den Komponententyp aus rule_id (Primaerstrategie) und HTML-Snippet (Fallback).
 * ALLE Klassifikationen sind heuristisch — `heuristic: true` wird immer gesetzt.
 *
 * Fuer belastbare Component-Type-Daten ist ein Design-System-Mapping erforderlich (Phase C).
 */

export type ComponentType =
  | 'text_input'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'textarea'
  | 'button'
  | 'link'
  | 'image'
  | 'heading'
  | 'form'
  | 'table'
  | 'list'
  | 'landmark'
  | 'media'
  | 'dialog'
  | 'tab'
  | 'menu'
  | 'page'
  | 'unknown';

export interface ComponentTypeResult {
  component_type: ComponentType;
  heuristic: true;
}

// Regel-zu-Komponenten-Mapping (direkteste Zuordnung, spezifischste zuerst)
const RULE_COMPONENT_MAP: Readonly<Record<string, ComponentType>> = {
  // Formular-Inputs
  'label': 'text_input',
  'label-content-name-mismatch': 'text_input',
  'select-name': 'select',
  'checkboxgroup': 'checkbox',
  'radiogroup': 'radio',
  'textarea-name': 'textarea',
  'orphaned-label': 'text_input',

  // Buttons & Links
  'button-name': 'button',
  'link-name': 'link',
  'link-in-text-block': 'link',
  'redundant-link': 'link',

  // Bilder
  'image-alt': 'image',
  'image-redundant-alt': 'image',
  'suspicious-alt-text': 'image',
  'role-img-alt': 'image',

  // Ueberschriften & Seitenstruktur
  'heading-order': 'heading',
  'page-has-heading-one': 'heading',
  'heading-hierarchy': 'heading',
  'empty-heading': 'heading',

  // Seite & Globalstruktur
  'document-title': 'page',
  'page-title-empty': 'page',
  'html-has-lang': 'page',
  'html-lang-valid': 'page',
  'html-lang': 'page',
  'html-xml-lang-mismatch': 'page',
  'reflow-320px': 'page',
  'reduced-motion': 'page',

  // Landmarks & Navigation
  'landmark-one-main': 'landmark',
  'landmark-main-is-top-level': 'landmark',
  'landmark-complementary-is-top-level': 'landmark',
  'landmark-no-duplicate-banner': 'landmark',
  'landmark-no-duplicate-contentinfo': 'landmark',
  'bypass': 'landmark',
  'region': 'landmark',
  'skip-link': 'landmark',

  // Tabellen
  'table-duplicate-name': 'table',
  'th-has-data-cells': 'table',
  'td-headers-attr': 'table',
  'scope-attr-valid': 'table',
  'table-fake-caption': 'table',

  // Medien
  'audio-caption': 'media',
  'video-caption': 'media',
  'video-description': 'media',
  'object-alt': 'media',

  // ARIA
  'aria-allowed-attr': 'unknown',
  'aria-required-attr': 'unknown',
  'aria-required-children': 'unknown',
  'aria-required-parent': 'unknown',
  'aria-roles': 'unknown',
  'aria-valid-attr': 'unknown',
  'aria-valid-attr-value': 'unknown',
};

// HTML-Tag-zu-Komponenten-Mapping (Fallback wenn Regel-Map nicht eindeutig)
const HTML_TAG_PATTERNS: Array<{ pattern: RegExp; type: ComponentType }> = [
  { pattern: /^<input[^>]+type=["']?(email|text|password|tel|number|search|url|date|time)/i, type: 'text_input' },
  { pattern: /^<input[^>]+type=["']?checkbox/i, type: 'checkbox' },
  { pattern: /^<input[^>]+type=["']?radio/i, type: 'radio' },
  { pattern: /^<input[^>]+type=["']?(submit|button|reset)/i, type: 'button' },
  { pattern: /^<(select|datalist)/i, type: 'select' },
  { pattern: /^<textarea/i, type: 'textarea' },
  { pattern: /^<input(?![^>]+type)/i, type: 'text_input' }, // input ohne type
  { pattern: /^<button/i, type: 'button' },
  { pattern: /^<a[\s>]/i, type: 'link' },
  { pattern: /^<img/i, type: 'image' },
  { pattern: /^<(h1|h2|h3|h4|h5|h6)[\s>]/i, type: 'heading' },
  { pattern: /^<form[\s>]/i, type: 'form' },
  { pattern: /^<table[\s>]/i, type: 'table' },
  { pattern: /^<(ul|ol|dl)[\s>]/i, type: 'list' },
  { pattern: /^<(nav|main|header|footer|aside)[\s>]/i, type: 'landmark' },
  { pattern: /^<(video|audio|iframe)[\s>]/i, type: 'media' },
  { pattern: /role=["']?dialog/i, type: 'dialog' },
  { pattern: /role=["']?tablist/i, type: 'tab' },
  { pattern: /role=["']?menu/i, type: 'menu' },
];

/**
 * Klassifiziert den Komponententyp aus rule_id und HTML-Snippet.
 * Primaere Strategie: Regel-Map. Fallback: HTML-Tag-Analyse.
 */
export function classifyComponentType(ruleId: string, html: string): ComponentTypeResult {
  // 1. Regel-Mapping (direkteste Zuordnung, priorisiert)
  const fromRule = RULE_COMPONENT_MAP[ruleId];
  if (fromRule !== undefined && fromRule !== 'unknown') {
    return { component_type: fromRule, heuristic: true };
  }

  // 2. HTML-Tag-Analyse als Fallback
  if (html) {
    const trimmedHtml = html.trim();
    for (const { pattern, type } of HTML_TAG_PATTERNS) {
      if (pattern.test(trimmedHtml)) {
        return { component_type: type, heuristic: true };
      }
    }
  }

  // 3. Regel-Map-Fallback (auch 'unknown' aus Regel-Map)
  if (fromRule !== undefined) {
    return { component_type: fromRule, heuristic: true };
  }

  return { component_type: 'unknown', heuristic: true };
}
