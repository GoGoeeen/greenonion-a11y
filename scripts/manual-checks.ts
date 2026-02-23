export type ManualCheckCategory =
  | 'Tastaturnavigation'
  | 'Multimedia'
  | 'Inhalte & Verstaendlichkeit'
  | 'Formulare & Eingaben';

export interface ManualCheckDefinition {
  id: string;
  rule: string;
  category: ManualCheckCategory;
  wcag: string;
  appliesTo: Array<'incomplete' | 'suspicious-alt-text'>;
  label: string;
}

// Gemeinsame Referenz fuer manuelle/semantische Checks.
// Wird von scan.ts an den LLM-Agenten uebergeben.
export const manualChecks: ManualCheckDefinition[] = [
  {
    id: 'mc-suspicious-alt-111',
    rule: 'suspicious-alt-text',
    category: 'Multimedia',
    wcag: '1.1.1',
    appliesTo: ['suspicious-alt-text', 'incomplete'],
    label: 'Alternativtexte fuer Bilder',
  },
  {
    id: 'mc-focus-visible-247',
    rule: 'focus-visible',
    category: 'Tastaturnavigation',
    wcag: '2.4.7',
    appliesTo: ['incomplete'],
    label: 'Sichtbarer Fokus',
  },
  {
    id: 'mc-keyboard-trap-212',
    rule: 'keyboard-trap',
    category: 'Tastaturnavigation',
    wcag: '2.1.2',
    appliesTo: ['incomplete'],
    label: 'Keine Tastaturfalle',
  },
  {
    id: 'mc-page-title-242',
    rule: 'page-title-unique',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '2.4.2',
    appliesTo: ['incomplete'],
    label: 'Seitentitel vorhanden und eindeutig',
  },
  {
    id: 'mc-heading-hierarchy-131',
    rule: 'heading-hierarchy',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '1.3.1',
    appliesTo: ['incomplete'],
    label: 'Semantische Struktur und Ueberschriften',
  },
  {
    id: 'mc-html-lang-311',
    rule: 'html-lang',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '3.1.1',
    appliesTo: ['incomplete'],
    label: 'Sprache der Seite',
  },
  {
    id: 'mc-html-lang-312',
    rule: 'html-lang',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '3.1.2',
    appliesTo: ['incomplete'],
    label: 'Sprache einzelner Textteile',
  },
  {
    id: 'mc-text-spacing-1412',
    rule: 'text-spacing-override',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '1.4.12',
    appliesTo: ['incomplete'],
    label: 'Textabstaende ohne Inhaltsverlust',
  },
  {
    id: 'mc-reduced-motion-231',
    rule: 'reduced-motion',
    category: 'Multimedia',
    wcag: '2.3.1',
    appliesTo: ['incomplete'],
    label: 'Animationen ohne Flackern/Trigger',
  },
  {
    id: 'mc-orphaned-label-332',
    rule: 'orphaned-label',
    category: 'Formulare & Eingaben',
    wcag: '3.3.2',
    appliesTo: ['incomplete'],
    label: 'Labels und Eingabehinweise',
  },
  {
    id: 'mc-orphaned-label-131',
    rule: 'orphaned-label',
    category: 'Formulare & Eingaben',
    wcag: '1.3.1',
    appliesTo: ['incomplete'],
    label: 'Semantische Zuordnung von Labels',
  },
];
