/**
 * NVDA-Aktionssequenzen pro Regel.
 *
 * Mappt rule_id auf eine konkrete Tastatursequenz fuer NVDA.
 * Basiert auf NVDA-Tastenkuerzeln (Windows-Standardtastatur):
 *   Tab   — naechstes fokussierbares Element
 *   K     — naechster Link
 *   H     — naechste Ueberschrift
 *   D     — naechste Landmark/Region
 *   G     — naechste Grafik
 *   B     — naechster Button
 *   F     — naechstes Formularfeld
 *   Insert+T — Seitentitel vorlesen
 *
 * Alle generierten Sequenzen sind heuristisch (Phase D) und werden
 * in Phase E durch aufgezeichnete NVDA-Baselines verfeinert.
 */

export interface NvdaAction {
  step: number;
  action: string;
  /** Ziel-Element (Beschreibung oder Locator-Typ) */
  target?: string;
  /** Erwarteter NVDA-Zwischenwert oder Tastenwert */
  value?: string;
}

/** Sequenz fuer das Navigieren zum naechsten Link und Vorlesen */
const NAV_LINK: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_k', target: 'link', value: 'naechsten Link anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Link-Ansage pruefen' },
];

/** Sequenz fuer Tab-Navigation zu einem Formularfeld */
const NAV_TAB_FORM: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_tab', target: 'form_element', value: 'Formularfeld fokussieren' },
  { step: 3, action: 'nvda_listen', value: 'Label-Ansage pruefen' },
];

/** Sequenz fuer Button-Navigation */
const NAV_BUTTON: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_b', target: 'button', value: 'naechsten Button anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Button-Name pruefen' },
];

/** Sequenz fuer Grafik-Navigation */
const NAV_GRAPHIC: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_g', target: 'graphic', value: 'naechste Grafik anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Alt-Text pruefen' },
];

/** Sequenz fuer Ueberschriften-Navigation */
const NAV_HEADING: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_h', target: 'heading', value: 'naechste Ueberschrift anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Ueberschriften-Text und Level pruefen' },
];

/** Sequenz fuer Landmark-Navigation */
const NAV_LANDMARK: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_d', target: 'landmark', value: 'naechste Landmark anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Landmark-Bezeichnung pruefen' },
];

/** Sequenz fuer Seitentitel-Pruefung */
const NAV_PAGE_TITLE: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_insert_t', value: 'Seitentitel vorlesen lassen (Insert+T)' },
  { step: 3, action: 'nvda_listen', value: 'Seitentitel pruefen' },
];

/** Sequenz fuer Select/Combobox */
const NAV_SELECT: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_tab', target: 'select', value: 'Select-Element fokussieren' },
  { step: 3, action: 'nvda_listen', value: 'Label-Ansage pruefen' },
];

/** Sequenz fuer ARIA-basierte Elemente */
const NAV_ARIA_GENERIC: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_tab', target: 'aria_element', value: 'ARIA-Element fokussieren' },
  { step: 3, action: 'nvda_listen', value: 'Rolle und Name pruefen' },
];

/** Sequenz fuer Skip-Link-Pruefung */
const NAV_SKIP_LINK: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_tab', target: 'skip_link', value: 'ersten Tab-Stopp anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Skip-Link-Text pruefen' },
  { step: 4, action: 'press_enter', value: 'Skip-Link aktivieren' },
  { step: 5, action: 'nvda_listen', value: 'Sprungziel pruefen' },
];

/** Sequenz fuer Frame-/iFrame-Navigation */
const NAV_FRAME: NvdaAction[] = [
  { step: 1, action: 'open_page' },
  { step: 2, action: 'press_m', target: 'frame', value: 'naechsten Frame anspringen' },
  { step: 3, action: 'nvda_listen', value: 'Frame-Titel pruefen' },
];

/**
 * Vollstaendige Lookup-Tabelle: rule_id → NvdaAction[].
 * Unbekannte Rules erhalten __default__ basierend auf sr_relevance.
 */
const ACTION_MAP: Record<string, NvdaAction[]> = {
  // --- Labels & Formularfelder (sr_direct) ---
  'label':                NAV_TAB_FORM,
  'label-content-name-mismatch': NAV_TAB_FORM,
  'select-name':          NAV_SELECT,
  'textarea':             NAV_TAB_FORM,
  'input-button-name':    NAV_BUTTON,
  'input-image-alt':      NAV_GRAPHIC,

  // --- Buttons & Links (sr_direct) ---
  'button-name':          NAV_BUTTON,
  'link-name':            NAV_LINK,
  'link-in-text-block':   NAV_LINK,

  // --- Bilder (sr_direct) ---
  'image-alt':            NAV_GRAPHIC,
  'image-redundant-alt':  NAV_GRAPHIC,
  'role-img-alt':         NAV_GRAPHIC,
  'svg-img-alt':          NAV_GRAPHIC,

  // --- Seite & Sprache (sr_direct) ---
  'html-has-lang':        NAV_PAGE_TITLE,
  'html-lang-valid':      NAV_PAGE_TITLE,
  'document-title':       NAV_PAGE_TITLE,
  'page-title':           NAV_PAGE_TITLE,
  'valid-lang':           NAV_PAGE_TITLE,

  // --- ARIA (sr_direct) ---
  'aria-command-name':    NAV_ARIA_GENERIC,
  'aria-input-field-name': NAV_TAB_FORM,
  'aria-meter-name':      NAV_ARIA_GENERIC,
  'aria-progressbar-name': NAV_ARIA_GENERIC,
  'aria-required-attr':   NAV_TAB_FORM,
  'aria-toggle-field-name': NAV_TAB_FORM,
  'aria-tooltip-name':    NAV_ARIA_GENERIC,
  'aria-treeitem-name':   NAV_ARIA_GENERIC,
  'aria-label':           NAV_ARIA_GENERIC,
  'aria-labelledby':      NAV_ARIA_GENERIC,

  // --- Ueberschriften (sr_indirect) ---
  'heading-order':        NAV_HEADING,
  'page-has-heading-one': NAV_HEADING,

  // --- Landmarks (sr_indirect) ---
  'landmark-one-main':    NAV_LANDMARK,
  'landmark-main-is-top-level': NAV_LANDMARK,
  'landmark-no-duplicate-banner': NAV_LANDMARK,
  'landmark-no-duplicate-main': NAV_LANDMARK,
  'bypass':               NAV_SKIP_LINK,
  'skip-link':            NAV_SKIP_LINK,

  // --- Frames (sr_indirect) ---
  'frame-title':          NAV_FRAME,
  'frame-focusable-content': NAV_FRAME,

  // --- Fokus (sr_indirect) ---
  'focus-order-semantics': NAV_TAB_FORM,
  'focus-trap':           NAV_TAB_FORM,

  // --- Tabellen (sr_indirect) ---
  'td-headers-attr':      [
    { step: 1, action: 'open_page' },
    { step: 2, action: 'press_t', target: 'table', value: 'naechste Tabelle anspringen' },
    { step: 3, action: 'navigate_cells', value: 'Tabellenzellen durchnavigieren' },
    { step: 4, action: 'nvda_listen', value: 'Spalten-/Zeilenheader pruefen' },
  ],
  'th-has-data-cells':    [
    { step: 1, action: 'open_page' },
    { step: 2, action: 'press_t', target: 'table' },
    { step: 3, action: 'navigate_cells' },
    { step: 4, action: 'nvda_listen', value: 'Header-Zuordnung pruefen' },
  ],
};

/**
 * Gibt die Aktionssequenz fuer eine regel_id zurueck.
 * Fallback-Sequenz je nach sr_relevance.
 */
export function getActionSequence(
  ruleId: string,
  srRelevance: 'sr_direct' | 'sr_indirect' | 'needs_flow_context',
): NvdaAction[] {
  const mapped = ACTION_MAP[ruleId];
  if (mapped) {
    // Neue Kopie mit richtigen Step-Nummern (gegen Mutationen)
    return mapped.map((a, i) => ({ ...a, step: i + 1 }));
  }

  // Fallback je nach SR-Relevance
  if (srRelevance === 'sr_direct') {
    return NAV_TAB_FORM.map((a, i) => ({ ...a, step: i + 1 }));
  }
  if (srRelevance === 'sr_indirect') {
    return NAV_TAB_FORM.map((a, i) => ({ ...a, step: i + 1 }));
  }

  // needs_flow_context: leer — Flow-Recording erforderlich
  return [];
}
