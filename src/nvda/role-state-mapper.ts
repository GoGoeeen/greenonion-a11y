/**
 * Mappt component_type und HTML-Snippet auf erwartete ARIA-Rollen und Zustaende.
 *
 * NVDA gibt Rollen in Windows MSAA / UIA-Terminologie aus:
 *   button  → "Schaltfläche" / "button"
 *   link    → "Link" / "link"
 *   edit    → "Bearbeitungsfeld" / "edit"
 *   combobox → "Kombinationsfeld" / "combobox"
 *   checkBox → "Kontrollkästchen" / "checkBox"
 *   radioButton → "Optionsschaltfläche" / "radioButton"
 *   heading → "Ueberschrift Ebene N"
 *   graphic → "Grafik"
 *
 * Alle Werte sind heuristisch (Phase D). Phase E verfeinert mit echten NVDA-Aufnahmen.
 */

/** Extrahiert den Wert eines HTML-Attributs. */
function getAttr(html: string, attr: string): string | null {
  const m = html.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*?)["']`, 'i'));
  return m ? m[1] : null;
}

/** Erkennt ARIA-Zustands-Attribute und gibt Tokens zurueck. */
function extractAriaStates(html: string): string[] {
  const states: string[] = [];

  if (/aria-required\s*=\s*["']true["']/i.test(html)) states.push('required');
  if (/aria-disabled\s*=\s*["']true["']/i.test(html)) states.push('unavailable');
  if (/aria-expanded\s*=\s*["']true["']/i.test(html))  states.push('expanded');
  if (/aria-expanded\s*=\s*["']false["']/i.test(html)) states.push('collapsed');
  if (/aria-checked\s*=\s*["']true["']/i.test(html))   states.push('checked');
  if (/aria-checked\s*=\s*["']false["']/i.test(html))  states.push('unchecked');
  if (/aria-pressed\s*=\s*["']true["']/i.test(html))   states.push('pressed');
  if (/aria-invalid\s*=\s*["']true["']/i.test(html))   states.push('invalid entry');
  if (/aria-multiselectable\s*=\s*["']true["']/i.test(html)) states.push('multi-select');

  // HTML-native Zustaende
  if (/\brequired\b/i.test(html) && !/aria-required/i.test(html)) states.push('required');
  if (/\bdisabled\b/i.test(html)) states.push('unavailable');
  if (/\breadonly\b/i.test(html)) states.push('read only');
  if (/\bchecked\b/i.test(html) && !/ aria-checked/i.test(html)) states.push('checked');

  return states;
}

/** Erkennt Ueberschriften-Level aus HTML (h1-h6 oder aria-level). */
function extractHeadingLevel(html: string): number | null {
  const levelMatch = html.match(/<h([1-6])\b/i);
  if (levelMatch) return parseInt(levelMatch[1], 10);

  const ariaLevel = getAttr(html, 'aria-level');
  if (ariaLevel) return parseInt(ariaLevel, 10);

  return null;
}

/** Erkennt Input-Typ fuer praezisere Rollen-Zuordnung. */
function getInputType(html: string): string {
  return (getAttr(html, 'type') ?? 'text').toLowerCase();
}

/**
 * Gibt erwartete ARIA-Rollen und Zustaende fuer ein Element zurueck.
 *
 * @param componentType  Klassifizierter Komponenten-Typ
 * @param html           HTML-Snippet des Elements
 * @param ruleId         Regel-ID fuer zusaetzlichen Kontext
 * @returns              Array von Rollen-/Zustands-Strings (NVDA-Terminologie)
 */
export function mapRoleState(
  componentType: string,
  html: string,
  ruleId?: string,
): string[] {
  const ariaStates = extractAriaStates(html);
  const roles: string[] = [];

  // Explizite ARIA-Role hat Vorrang
  const explicitRole = getAttr(html, 'role');
  if (explicitRole) {
    roles.push(explicitRole);
    return [...roles, ...ariaStates];
  }

  switch (componentType) {
    case 'button': {
      const inputType = getInputType(html);
      if (/\bbutton\b/i.test(html) || inputType === 'button' || inputType === 'submit' || inputType === 'reset') {
        roles.push('button');
      }
      break;
    }

    case 'link':
      roles.push('link');
      break;

    case 'text_input': {
      const type = getInputType(html);
      switch (type) {
        case 'password': roles.push('edit', 'protected'); break;
        case 'search':   roles.push('edit', 'search field'); break;
        case 'number':   roles.push('spinButton'); break;
        case 'email':
        case 'url':
        case 'tel':
        case 'text':
        default:         roles.push('edit'); break;
      }
      break;
    }

    case 'select':
      roles.push('combobox');
      break;

    case 'checkbox':
      roles.push('checkBox');
      break;

    case 'radio':
      roles.push('radioButton');
      break;

    case 'textarea':
      roles.push('edit', 'multi-line');
      break;

    case 'image': {
      // Leeres alt = dekorativ, NVDA ignoriert
      const alt = getAttr(html, 'alt');
      if (alt === '') {
        return []; // Keine Rolle → NVDA liest nicht vor
      }
      roles.push('graphic');
      break;
    }

    case 'heading': {
      const level = extractHeadingLevel(html);
      roles.push(level ? `heading level ${level}` : 'heading');
      break;
    }

    case 'form':
      roles.push('grouping');
      break;

    case 'landmark':
      roles.push('region');
      break;

    case 'dialog':
      roles.push('dialog');
      break;

    case 'menu':
      roles.push('menu');
      break;

    case 'tab':
      roles.push('tab');
      break;

    case 'list':
      roles.push('list');
      break;

    case 'table':
      roles.push('table');
      break;

    default:
      // Kein spezifischer Rollentyp bekannt — leer lassen
      break;
  }

  return [...roles, ...ariaStates];
}
