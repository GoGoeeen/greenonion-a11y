/**
 * Extrahiert erwartete NVDA-Sprach-Tokens aus einem HTML-Snippet.
 *
 * NVDA liest Elemente in dieser Reihenfolge vor:
 *   1. aria-labelledby (aufgeloest) — nicht ohne vollstaendigen DOM verfuegbar
 *   2. aria-label
 *   3. title-Attribut (als Fallback)
 *   4. Sichtbarer Textinhalt (innerText-Aequivalent)
 *   5. alt-Attribut (fuer Bilder)
 *   6. placeholder (fuer Inputs, als Fallback wenn kein Label)
 *   7. value (fuer Buttons vom Typ submit/reset)
 *
 * Fuer Regeln die auf fehlendes Accessible-Name prufen (link-name, image-alt etc.)
 * werden zusaetzliche Fallback-Tokens aus href/src extrahiert — NVDA liest bei
 * fehlendem Namen teils die URL oder den Dateinamen vor.
 *
 * Alle extrahierten Tokens sind heuristisch (Phase D/E).
 */

/** Extrahiert den Wert eines HTML-Attributs aus einem Snippet. */
function extractAttr(html: string, attr: string): string | null {
  // Unterstuetzt: attr="value", attr='value'
  const pattern = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = html.match(pattern);
  return match ? match[1].trim() : null;
}

/** Entfernt HTML-Tags und normalisiert Whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrahiert Tokens aus dem sichtbaren Text (innerText-Heuristik). */
function extractVisibleText(html: string, maxLength = 80): string | null {
  const text = stripHtml(html);
  if (!text || text.length < 2) return null;
  return text.substring(0, maxLength);
}

/**
 * Normiert eine URL auf einen kurzen, erkennbaren Token.
 * "https://greenonion.at/en/ueber-uns/" → "greenonion.at/en/ueber-uns"
 */
function urlToToken(url: string): string | null {
  if (!url || url.startsWith('#') || url.startsWith('javascript')) return null;
  return url
    .replace(/^https?:\/\//, '')  // Protokoll entfernen
    .replace(/\/$/, '')            // Trailing Slash entfernen
    .trim() || null;
}

/**
 * Extrahiert den Dateinamen aus einem src-Pfad.
 * "https://example.com/uploads/logo-800x200.webp" → "logo-800x200.webp"
 * Stripped auch Groessen-Suffixe: "logo-800x200" → "logo"
 */
function srcToFilenameToken(src: string): string | null {
  if (!src) return null;
  const filename = src.split('/').pop()?.split('?')[0] ?? '';
  if (!filename || filename.length < 3) return null;
  // Groessen-Suffix entfernen: logo-1024x193.webp → logo, logo-300x57 → logo
  const withoutExt = filename.replace(/\.[^.]+$/, '');           // .webp/.png entfernen
  const withoutSize = withoutExt.replace(/-\d+x\d+(-\d+x\d+)?$/, ''); // -800x200 entfernen
  return withoutSize.length >= 3 ? withoutSize : withoutExt;
}

/**
 * Extrahiert erwartete NVDA-Sprach-Tokens aus einem HTML-Snippet.
 *
 * Gibt ein Array von Tokens zurueck die NVDA typischerweise vorliest —
 * sortiert nach NVDA-Prioritaet. Leeres Array = kein Token extrahierbar.
 *
 * @param html   HTML-Snippet des betroffenen Elements
 * @param ruleId Regel-ID fuer kontext-spezifische Extraktion
 */
export function extractSpeechTokens(html: string, ruleId?: string): string[] {
  if (!html) return [];

  const tokens: string[] = [];

  // 1. aria-label — hoechste Prioritaet, NVDA bevorzugt dieses
  const ariaLabel = extractAttr(html, 'aria-label');
  if (ariaLabel) tokens.push(ariaLabel);

  // 2. alt-Attribut (Bilder, Input type=image)
  const alt = extractAttr(html, 'alt');
  if (alt && alt.trim().length > 0) {
    // Leeres alt="" = dekorativ → kein Token
    tokens.push(alt);
  }

  // 3. title-Attribut
  const title = extractAttr(html, 'title');
  if (title && !tokens.length) tokens.push(title);

  // 4. value fuer Submit/Reset-Buttons
  const inputType = extractAttr(html, 'type');
  if (inputType && (inputType.toLowerCase() === 'submit' || inputType.toLowerCase() === 'reset' || inputType.toLowerCase() === 'button')) {
    const value = extractAttr(html, 'value');
    if (value && !tokens.length) tokens.push(value);
  }

  // 5. Sichtbarer Text — nur wenn kein aria-label vorhanden
  if (!ariaLabel) {
    const visible = extractVisibleText(html);
    if (visible && !tokens.includes(visible)) tokens.push(visible);
  }

  // 6. placeholder — letzter Fallback fuer Inputs ohne Label
  const placeholder = extractAttr(html, 'placeholder');
  if (placeholder && !tokens.length) tokens.push(placeholder);

  // 7. Regel-spezifische Fallbacks fuer fehlendes Accessible-Name
  //    NVDA liest bei fehlendem Namen teils die URL oder den Dateinamen.
  //    Diese Tokens markieren den IST-Zustand (kaputt), nicht den SOLL-Zustand.
  if (tokens.length === 0) {
    tokens.push(...extractFallbackTokens(html, ruleId));
  }

  // Duplikate entfernen, leere Strings filtern
  return [...new Set(tokens.filter(t => t.trim().length > 0))];
}

/**
 * Fallback-Tokens fuer Regeln die auf fehlendes Accessible-Name prufen.
 *
 * Wird nur aufgerufen wenn kein anderer Token gefunden wurde.
 * Extrahiert href-URL oder Bild-Dateiname als NVDA-Fallback-Ausgabe.
 */
function extractFallbackTokens(html: string, ruleId?: string): string[] {
  const fallbacks: string[] = [];

  // link-name: NVDA liest bei unnamed Links die href-URL vor
  if (ruleId === 'link-name' || ruleId === 'link-in-text-block') {
    const href = extractAttr(html, 'href');
    const hrefToken = urlToToken(href ?? '');
    if (hrefToken) fallbacks.push(hrefToken);

    // Bild-src als zusaetzlicher Fallback (falls Link nur ein Bild enthaelt)
    const src = extractAttr(html, 'src');
    const srcToken = srcToFilenameToken(src ?? '');
    if (srcToken && !fallbacks.some(t => t.includes(srcToken))) {
      fallbacks.push(srcToken);
    }
  }

  // image-alt / role-img-alt / svg-img-alt / input-image-alt:
  // NVDA liest Dateiname des Bildes wenn kein alt-Text vorhanden
  if (
    ruleId === 'image-alt' ||
    ruleId === 'image-redundant-alt' ||
    ruleId === 'role-img-alt' ||
    ruleId === 'svg-img-alt' ||
    ruleId === 'input-image-alt'
  ) {
    const src = extractAttr(html, 'src');
    const srcToken = srcToFilenameToken(src ?? '');
    if (srcToken) fallbacks.push(srcToken);
  }

  // button-name: href oder Kontext-Text als Fallback
  if (ruleId === 'button-name' || ruleId === 'input-button-name') {
    const value = extractAttr(html, 'value');
    if (value) fallbacks.push(value);
  }

  return fallbacks;
}

/**
 * Extrahiert den erwarteten Navigations-Outcome basierend auf dem Element-Typ.
 *
 * @param html      HTML-Snippet
 * @param ruleId    Regel-ID
 * @param component Komponenten-Typ
 */
export function extractNavigationOutcome(
  html: string,
  ruleId: string,
  component: string,
): string | undefined {
  // Links → Seitennavigation
  if (component === 'link' || ruleId === 'link-name') {
    const href = extractAttr(html, 'href');
    if (href && href.startsWith('#')) return 'focus_jumps_to_anchor';
    return 'page_navigation';
  }

  // Buttons → Aktion
  if (component === 'button' || ruleId === 'button-name') {
    const type = extractAttr(html, 'type');
    if (type === 'submit') return 'form_submitted';
    return 'action_triggered';
  }

  // Skip-Links → Fokus-Sprung
  if (ruleId === 'bypass' || ruleId === 'skip-link') {
    return 'focus_jumps_to_main_content';
  }

  // Formularfelder → Fokus bleibt
  if (['text_input', 'select', 'checkbox', 'radio', 'textarea'].includes(component)) {
    return 'focus_on_element';
  }

  return undefined;
}
