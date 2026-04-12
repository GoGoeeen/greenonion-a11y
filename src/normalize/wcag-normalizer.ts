/**
 * WCAG-Normalisierung: Vereinheitlicht die drei inkonsistenten WCAG-Felder
 * des bestehenden Scan-Outputs zu einem normierten wcag_sc[]-Array.
 *
 * Eingabeformate in der bestehenden Pipeline:
 * - `wcagTags`: ['wcag242', 'wcag2a'] — axe-core Format
 * - `wcag`: '2.4.2 / 1.3.1' — Custom-Checks-Format (slash-separiert)
 * - `wcag_criteria`: ['2.4.2'] — Dedupliziertes findings-Format
 * - `htmlcsCode`: 'WCAG2AA.Principle1.Guideline1_1.1_1_1.H37' — HTMLCS Format
 *
 * Ausgabe: dedupliziertes, sortiertes Array im Format ['1.1.1', '2.4.2']
 */

/**
 * Parst einen axe-Tag wie 'wcag242' zu '2.4.2'.
 * Gibt null zurueck fuer Nicht-WCAG-Tags oder Guideline-only-Tags.
 */
function parseWcagTag(tag: string): string | null {
  // Bereits normiertes Format '2.4.2' — direkt weitergeben
  if (/^\d+\.\d+\.\d+$/.test(tag)) return tag;

  // axe-Format: 'wcag' + Ziffernblock (ohne Punkte), z.B. 'wcag242' -> '2.4.2'
  const match = tag.match(/^wcag(\d)(\d+)$/);
  if (!match) return null;

  const principle = match[1]; // z.B. '2'
  const rest = match[2];      // z.B. '42'

  if (rest.length < 2) return null; // Nur Guideline (wcag21) — kein SC

  if (rest.length === 2) {
    // z.B. wcag242 → principle=2, rest=42 → 2.4.2
    return `${principle}.${rest[0]}.${rest[1]}`;
  }
  if (rest.length === 3) {
    // z.B. wcag4131 wuerde rest=131 → 1.3.1
    return `${principle}.${rest[0]}.${rest.substring(1)}`;
  }

  return null;
}

/**
 * Parst Slash-separierte WCAG-SC-Strings wie '1.3.1 / 3.3.2' → ['1.3.1', '3.3.2'].
 * Ignoriert Strings die nicht dem Format X.Y.Z entsprechen.
 */
function parseWcagString(wcag: string): string[] {
  return wcag
    .split('/')
    .map(s => s.trim())
    .filter(s => /^\d+\.\d+\.\d+$/.test(s));
}

/**
 * Normiert alle WCAG-Felder eines Issues zu einem einheitlichen wcag_sc[]-Array.
 * Ergebnis: dedupliziert, sortiert, Format '1.1.1'.
 */
export function normalizeWcagSc(issue: {
  wcag?: string | string[];
  wcagTags?: string[];
  wcag_criteria?: string[];
  htmlcsCode?: string;
}): string[] {
  const result = new Set<string>();

  // 1. wcag_criteria (bereits normiert aus accessibility-score.js deduplication)
  if (Array.isArray(issue.wcag_criteria)) {
    for (const sc of issue.wcag_criteria) {
      if (/^\d+\.\d+\.\d+$/.test(sc)) result.add(sc);
    }
  }

  // 2. wcagTags (axe-core Format: 'wcag242', 'wcag111' usw.)
  if (Array.isArray(issue.wcagTags)) {
    for (const tag of issue.wcagTags) {
      const sc = parseWcagTag(tag);
      if (sc) result.add(sc);
    }
  }

  // 3. wcag (Custom-Checks-Format, Slash-separiert oder Array)
  if (typeof issue.wcag === 'string') {
    for (const sc of parseWcagString(issue.wcag)) {
      result.add(sc);
    }
  } else if (Array.isArray(issue.wcag)) {
    for (const w of issue.wcag) {
      if (typeof w === 'string') {
        for (const sc of parseWcagString(w)) result.add(sc);
      }
    }
  }

  // 4. HTMLCS-Code (Format: WCAG2AA.PrincipleX.GuidelineX_Y.X_Y_Z.Hxx)
  if (typeof issue.htmlcsCode === 'string') {
    const m = issue.htmlcsCode.match(/\.(\d+)_(\d+)_(\d+)/);
    if (m) result.add(`${m[1]}.${m[2]}.${m[3]}`);
  }

  return [...result].sort();
}
