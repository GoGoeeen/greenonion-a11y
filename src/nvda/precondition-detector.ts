/**
 * Heuristischer Precondition-Detektor fuer NVDA-Szenarien.
 *
 * Leitet Vorbedingungen aus page_type, URL und rule_id ab.
 * Ergebnis ist immer als Heuristik zu verstehen — vollstaendige
 * Login-State-Erkennung erfordert Flow-Recording (Phase E).
 */

/** Bekannte Preconditions als Konstanten (verhindert Tippfehler). */
export const PRECOND = {
  PAGE_LOADED:          'page_loaded',
  USER_AUTHENTICATED:   'user_authenticated',
  USER_UNAUTHENTICATED: 'user_unauthenticated',
  FORM_VISIBLE:         'form_visible',
  DIALOG_OPEN:          'dialog_open',
  ITEMS_IN_CART:        'items_in_cart',
  SEARCH_RESULTS_LOADED: 'search_results_loaded',
  NAVIGATION_EXPANDED:  'navigation_expanded',
} as const;

/** URL-Patterns die auf Auth-geschuetzte Seiten hinweisen. */
const AUTH_URL_PATTERNS = [
  /\/dashboard/i, /\/admin/i, /\/profile/i, /\/account/i,
  /\/settings/i,  /\/mein/i,  /\/konto/i,  /\/profil/i,
  /\/checkout/i,  /\/order/i, /\/bestellung/i,
];

/** URL-Patterns fuer oeffentliche Seiten (kein Login noetig). */
const PUBLIC_URL_PATTERNS = [
  /\/(login|signin|anmelden|einloggen)/i,
  /\/(register|signup|registrieren)/i,
  /\/(home|start|index|main)?$/i,
  /\/(about|ueber|kontakt|contact|impressum|datenschutz|privacy)/i,
];

/** Rule-IDs die spezielle Vorbedingungen brauchen. */
const RULE_PRECOND_MAP: Record<string, string[]> = {
  'bypass':         [PRECOND.PAGE_LOADED],
  'skip-link':      [PRECOND.PAGE_LOADED],
  'dialog-name':    [PRECOND.DIALOG_OPEN],
  'aria-dialog-name': [PRECOND.DIALOG_OPEN],
  'focus-trap':     [PRECOND.DIALOG_OPEN],
};

/**
 * Erkennt ob eine URL auf eine Auth-geschuetzte Seite hinweist.
 */
function isAuthRequired(url: string): boolean {
  return AUTH_URL_PATTERNS.some(p => p.test(url));
}

/**
 * Erkennt ob eine URL auf eine oeffentliche Seite hinweist.
 */
function isPublicPage(url: string): boolean {
  return PUBLIC_URL_PATTERNS.some(p => p.test(url));
}

/**
 * Leitet Preconditions aus page_type, URL und rule_id ab.
 *
 * @param pageType  Heuristisch klassifizierter Seitentyp
 * @param pageUrl   Vollstaendige Seiten-URL
 * @param ruleId    Regel-ID fuer spezifische Overrides
 * @returns         Array von Precondition-Strings (niemals leer — immer min. page_loaded)
 */
export function detectPreconditions(
  pageType: string,
  pageUrl: string,
  ruleId: string,
): string[] {
  // Rule-spezifische Preconditions haben hoechste Prioritaet
  const ruleSpecific = RULE_PRECOND_MAP[ruleId];
  if (ruleSpecific) return ruleSpecific;

  const preconds = new Set<string>();
  preconds.add(PRECOND.PAGE_LOADED);

  // Aus page_type ableiten
  switch (pageType) {
    case 'login':
    case 'register':
      preconds.add(PRECOND.USER_UNAUTHENTICATED);
      break;

    case 'checkout':
      preconds.add(PRECOND.USER_AUTHENTICATED);
      preconds.add(PRECOND.ITEMS_IN_CART);
      break;

    case 'dashboard':
    case 'profile':
      preconds.add(PRECOND.USER_AUTHENTICATED);
      break;

    case 'form':
    case 'contact':
      preconds.add(PRECOND.FORM_VISIBLE);
      break;

    case 'search':
      preconds.add(PRECOND.SEARCH_RESULTS_LOADED);
      break;

    default:
      // URL-basierte Fallback-Heuristik
      if (isAuthRequired(pageUrl) && !isPublicPage(pageUrl)) {
        preconds.add(PRECOND.USER_AUTHENTICATED);
      }
      break;
  }

  return [...preconds];
}
