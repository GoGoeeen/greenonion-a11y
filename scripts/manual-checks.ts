export type ManualCheckCategory =
  | 'Tastaturnavigation'
  | 'Multimedia'
  | 'Inhalte & Verstaendlichkeit'
  | 'Formulare & Eingaben';

export interface ManualCheck {
  id: string;
  rule: string;
  category: ManualCheckCategory;
  wcag: string;
  appliesTo: Array<'incomplete' | 'suspicious-alt-text'>;
  task: string;
  label?: string;
  autoPassIfEmpty?: boolean;
}

export type ManualCheckDefinition = ManualCheck;

// Gemeinsame Referenz fuer manuelle/semantische Checks.
// Wird von scan.ts an den LLM-Agenten uebergeben.
export const manualChecks: ManualCheckDefinition[] = [
  {
    id: 'mc-suspicious-alt-111',
    rule: 'suspicious-alt-text',
    category: 'Multimedia',
    wcag: '1.1.1',
    appliesTo: ['suspicious-alt-text', 'incomplete'],
    task: 'Sind Alternativtexte fuer Bilder inhaltlich passend und nicht generisch?',
    label: 'Alternativtexte fuer Bilder',
  },
  {
    id: 'mc-focus-visible-247',
    rule: 'focus-visible',
    category: 'Tastaturnavigation',
    wcag: '2.4.7',
    appliesTo: ['incomplete'],
    task: 'Sind alle interaktiven Elemente mit der Tastatur klar fokussierbar?',
    label: 'Sichtbarer Fokus',
  },
  {
    id: 'mc-keyboard-trap-212',
    rule: 'keyboard-trap',
    category: 'Tastaturnavigation',
    wcag: '2.1.2',
    appliesTo: ['incomplete'],
    task: 'Gibt es keine Tastaturfalle und ist die Navigation per Tastatur durchgaengig moeglich?',
    label: 'Keine Tastaturfalle',
    autoPassIfEmpty: true,
  },
  {
    id: 'mc-page-title-242',
    rule: 'page-title-unique',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '2.4.2',
    appliesTo: ['incomplete'],
    task: 'Sind Seitentitel vorhanden, eindeutig und beschreiben den Seiteninhalt?',
    label: 'Seitentitel vorhanden und eindeutig',
    autoPassIfEmpty: true,
  },
  {
    id: 'mc-heading-hierarchy-131',
    rule: 'heading-hierarchy',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '1.3.1',
    appliesTo: ['incomplete'],
    task: 'Sind Ueberschriften semantisch korrekt strukturiert und sinnvoll geschachtelt?',
    label: 'Semantische Struktur und Ueberschriften',
  },
  {
    id: 'mc-html-lang-311',
    rule: 'html-lang',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '3.1.1',
    appliesTo: ['incomplete'],
    task: 'Ist die Hauptsprache der Seite korrekt ausgezeichnet?',
    label: 'Sprache der Seite',
    autoPassIfEmpty: true,
  },
  {
    id: 'mc-html-lang-312',
    rule: 'html-lang',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '3.1.2',
    appliesTo: ['incomplete'],
    task: 'Sind abweichende Sprachabschnitte innerhalb der Seite korrekt markiert?',
    label: 'Sprache einzelner Textteile',
    autoPassIfEmpty: true,
  },
  {
    id: 'mc-text-spacing-1412',
    rule: 'text-spacing-override',
    category: 'Inhalte & Verstaendlichkeit',
    wcag: '1.4.12',
    appliesTo: ['incomplete'],
    task: 'Bleibt der Inhalt bei angepassten Textabstaenden vollstaendig nutzbar?',
    label: 'Textabstaende ohne Inhaltsverlust',
    autoPassIfEmpty: true,
  },
  {
    id: 'mc-reduced-motion-231',
    rule: 'reduced-motion',
    category: 'Multimedia',
    wcag: '2.3.1',
    appliesTo: ['incomplete'],
    task: 'Werden Animationen reduziert und keine potenziell triggernden Effekte erzwungen?',
    label: 'Animationen ohne Flackern/Trigger',
  },
  {
    id: 'mc-orphaned-label-332',
    rule: 'orphaned-label',
    category: 'Formulare & Eingaben',
    wcag: '3.3.2',
    appliesTo: ['incomplete'],
    task: 'Sind Eingabefelder mit klaren Labels und Hinweisen versehen?',
    label: 'Labels und Eingabehinweise',
  },
  {
    id: 'mc-orphaned-label-131',
    rule: 'orphaned-label',
    category: 'Formulare & Eingaben',
    wcag: '1.3.1',
    appliesTo: ['incomplete'],
    task: 'Sind Labels semantisch korrekt mit den zugehoerigen Eingabefeldern verknuepft?',
    label: 'Semantische Zuordnung von Labels',
  },
];
