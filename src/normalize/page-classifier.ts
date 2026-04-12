/**
 * Heuristischer Page-Type-Klassifikator.
 *
 * Bestimmt den Seitentyp aus URL-Pattern und optionalem Page-Title.
 * ALLE Klassifikationen sind heuristisch — `heuristic: true` wird immer gesetzt.
 *
 * Fuer belastbare Page-Type-Daten ist ein manuelles Flow-Mapping erforderlich (Phase C).
 * Die hier erzeugten Werte sind Approximationen fuer Executive-Aggregation und SR-Relevanz-Schätzung.
 */

export type PageType =
  | 'home'
  | 'login'
  | 'register'
  | 'form'
  | 'checkout'
  | 'article'
  | 'listing'
  | 'detail'
  | 'dashboard'
  | 'profile'
  | 'search'
  | 'error'
  | 'legal'
  | 'contact'
  | 'unknown';

export interface PageTypeResult {
  page_type: PageType;
  heuristic: true;
}

// URL-Pattern-Tabelle — geordnet nach Spezifitaet (spezifischste zuerst)
const URL_PATTERNS: Array<{ pattern: RegExp; type: PageType }> = [
  { pattern: /\/(login|signin|anmelden|anmeldung|einloggen)(\/|$|\?|#)/i, type: 'login' },
  { pattern: /\/(logout|signout|abmelden)(\/|$|\?|#)/i, type: 'login' },
  { pattern: /\/(register|signup|registrierung|registrieren|konto-erstellen|neues-konto)(\/|$|\?|#)/i, type: 'register' },
  { pattern: /\/(checkout|warenkorb|cart|bezahlen|payment|order|bestellung)(\/|$|\?|#)/i, type: 'checkout' },
  { pattern: /\/(dashboard|cockpit|mein-bereich|my-area)(\/|$|\?|#)/i, type: 'dashboard' },
  { pattern: /\/(profile|profil|account|konto|mein-konto|my-account)(\/|$|\?|#)/i, type: 'profile' },
  { pattern: /\/(search|suche|suchergebnisse|results)(\/|$|\?|#)/i, type: 'search' },
  { pattern: /\/(kontakt|contact|anfrage|request|feedback)(\/|$|\?|#)/i, type: 'contact' },
  { pattern: /\/(impressum|datenschutz|agb|nutzungsbedingungen|privacy|legal|terms|disclaimer|cookie)(\/|$|\?|#)/i, type: 'legal' },
  { pattern: /\/(404|403|500|error|fehler|not-found|seite-nicht-gefunden)(\/|$|\?|#)/i, type: 'error' },
  { pattern: /\/(blog|news|artikel|article|post|beitrag|presse|aktuelles)(\/|$|\?|#)/i, type: 'article' },
  { pattern: /\/(produkte|products|kategorie|category|shop|store|sortiment|kollektion)(\/|$|\?|#)/i, type: 'listing' },
  { pattern: /\/(produkt|product|detail|item|p\/)(\/|$|\?|#)/i, type: 'detail' },
  { pattern: /\/(formular|form|antrag|bewerbung|application|wizard)(\/|$|\?|#)/i, type: 'form' },
];

// Title-Pattern-Fallback (wenn URL-Analyse nicht eindeutig)
const TITLE_PATTERNS: Array<{ pattern: RegExp; type: PageType }> = [
  { pattern: /\b(login|anmelden|einloggen|sign in|anmeldung)\b/i, type: 'login' },
  { pattern: /\b(registrierung|register|account erstellen|konto erstellen)\b/i, type: 'register' },
  { pattern: /\b(warenkorb|checkout|bezahlen|kasse|bestellung)\b/i, type: 'checkout' },
  { pattern: /\b(dashboard|cockpit|mein bereich)\b/i, type: 'dashboard' },
  { pattern: /\b(kontakt|contact|anfrage senden)\b/i, type: 'contact' },
  { pattern: /\b(impressum|datenschutz|agb|privacy)\b/i, type: 'legal' },
  { pattern: /\b(suche|suchergebnisse|search results)\b/i, type: 'search' },
];

/**
 * Klassifiziert den Seitentyp aus URL und optionalem Title.
 * Gibt immer `heuristic: true` zurueck.
 */
export function classifyPageType(url: string, title?: string): PageTypeResult {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  // Startseite erkennen (bevor Patterns geprueft werden)
  if (pathname === '/' || pathname === '' || /^\/index\.html?$/i.test(pathname)) {
    return { page_type: 'home', heuristic: true };
  }

  // URL-Pattern pruefen
  for (const { pattern, type } of URL_PATTERNS) {
    if (pattern.test(pathname)) {
      return { page_type: type, heuristic: true };
    }
  }

  // Title-Fallback pruefen
  if (title) {
    for (const { pattern, type } of TITLE_PATTERNS) {
      if (pattern.test(title)) {
        return { page_type: type, heuristic: true };
      }
    }
  }

  return { page_type: 'unknown', heuristic: true };
}
