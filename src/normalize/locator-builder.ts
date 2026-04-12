/**
 * Locator-Builder: Erzeugt aus CSS-Selektor und HTML-Snippet eine primaere
 * Locator-Strategie und mehrere Fallback-Locatoren.
 *
 * Unterstuetzte Fallback-Strategien:
 * - xpath: aus ID/Tag-Attributen des CSS-Selektors abgeleitet (einfache Selektoren)
 * - aria:  aus aria-label / aria-labelledby im HTML-Snippet
 * - testid: aus data-testid im HTML-Snippet
 * - text:  sichtbarer Textinhalt aus HTML-Snippet (schwacher Fallback)
 *
 * Komplexe CSS-Selektoren (mit ' > ', ':nth-child' usw.) liefern keinen XPath-Fallback.
 * Das ist bewusst — fragile Approximationen sind schlimmer als kein Fallback.
 */

import type { Locator } from '../reporting/types.js';

/**
 * Konvertiert einfache CSS-Selektoren zu XPath.
 * Gibt null zurueck fuer zu komplexe Selektoren.
 */
function cssToXpath(selector: string): string | null {
  const s = selector.trim();

  // '#email' → '//*[@id="email"]'
  const idOnly = s.match(/^#([\w-]+)$/);
  if (idOnly) return `//*[@id="${idOnly[1]}"]`;

  // 'input#email' → '//input[@id="email"]'
  const tagId = s.match(/^([\w]+)#([\w-]+)$/);
  if (tagId) return `//${tagId[1]}[@id="${tagId[2]}"]`;

  // 'input[name="q"]' → '//input[@name="q"]'
  const attrSelector = s.match(/^([\w]+)\[(\w[\w-]*)=["']([^"']+)["']\]$/);
  if (attrSelector) return `//${attrSelector[1]}[@${attrSelector[2]}="${attrSelector[3]}"]`;

  // 'button' (einzelnes Tag) → '//button'
  const tagOnly = s.match(/^([\w]+)$/);
  if (tagOnly) return `//${tagOnly[1]}`;

  // Komplexe Selektoren: kein XPath — zu fragil
  return null;
}

/** Extrahiert aria-label-Wert aus HTML-Snippet. */
function extractAriaLabel(html: string): string | null {
  const m = html.match(/aria-label=["']([^"']+)["']/i);
  return m ? `[aria-label="${m[1]}"]` : null;
}

/** Extrahiert aria-labelledby-ID aus HTML-Snippet. */
function extractAriaLabelledby(html: string): string | null {
  const m = html.match(/aria-labelledby=["']([^"']+)["']/i);
  return m ? `[aria-labelledby="${m[1]}"]` : null;
}

/** Extrahiert data-testid-Wert aus HTML-Snippet. */
function extractTestId(html: string): string | null {
  const m = html.match(/data-testid=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** Extrahiert sichtbaren Text aus HTML-Snippet (Tags entfernt, max 80 Zeichen). */
function extractVisibleText(html: string): string | null {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 3) return null;
  return text.substring(0, 80);
}

/**
 * Erzeugt primaeren und Fallback-Locatoren aus Selector und HTML-Snippet.
 *
 * Duplikate innerhalb der Fallbacks werden vermieden.
 * Reihenfolge: xpath (stabiler) → aria → testid → text (fragilster Fallback)
 */
export function buildLocators(
  selector: string,
  html: string,
): { primary: Locator; fallbacks: Locator[] } {
  const primary: Locator = { type: 'css', value: selector };
  const fallbacks: Locator[] = [];
  const seen = new Set<string>();

  const addFallback = (locator: Locator) => {
    const key = `${locator.type}::${locator.value}`;
    if (!seen.has(key) && locator.value) {
      seen.add(key);
      fallbacks.push(locator);
    }
  };

  // XPath aus CSS-Selektor (nur einfache Selektoren)
  if (selector) {
    const xpath = cssToXpath(selector);
    if (xpath) addFallback({ type: 'xpath', value: xpath });
  }

  // ARIA-Fallbacks aus HTML-Snippet
  if (html) {
    const ariaLabel = extractAriaLabel(html);
    if (ariaLabel) addFallback({ type: 'aria', value: ariaLabel });

    const ariaLabelledby = extractAriaLabelledby(html);
    if (ariaLabelledby) addFallback({ type: 'aria', value: ariaLabelledby });

    // data-testid (stabiler als Text)
    const testId = extractTestId(html);
    if (testId) addFallback({ type: 'testid', value: testId });

    // Textinhalt als schwacher letzter Fallback
    const text = extractVisibleText(html);
    if (text) addFallback({ type: 'text', value: text });
  }

  return { primary, fallbacks };
}
