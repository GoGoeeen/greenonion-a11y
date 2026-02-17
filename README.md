# GreenOnion A11y Scanner

Automatisierter WCAG 2.1 AA Barrierefreiheits-Scanner mit PDF-Berichterstellung. Kombiniert drei Prüf-Engines (axe-core, HTML_CodeSniffer, Custom Checks) zu einem Gesamtscore pro Website.

## Features

- **Multi-Engine-Scan** — axe-core + HTML_CodeSniffer + eigene Prüfungen (Focus, Headings, Language, Animations, Reflow)
- **Automatisches Crawling** — Sitemap-basiert oder Link-Crawling, konfigurierbare Seitenanzahl
- **Authentifizierte Scans** — Login mit Credentials und konfigurierbaren Selektoren
- **PDF-Berichte** — Professionelle Berichte im GreenOnion-CI mit Score, Verstößen nach Kategorie und Handlungsempfehlungen
- **Batch-Scanner** — CSV-Import (NorthData-Export), automatischer Scan hunderter Firmen mit Resume-Funktion
- **WordPress-Remediation** — Automatische Behebung von Barrierefreiheitsproblemen via WP REST API
- **Notion-Sync** — Findings in Notion-Datenbank synchronisieren und Status nach Behebung aktualisieren

## Voraussetzungen

- Node.js >= 18
- Playwright-Browser (`npx playwright install chromium`)

## Installation

```bash
git clone https://github.com/GoGoeeen/greenonion-a11y.git
cd greenonion-a11y
npm install
cp .env.example .env  # Anpassen für Notion/Supabase/WordPress
```

## Verwendung

### Einzelner Scan

```bash
# Öffentlicher Scan (max 30 Seiten)
node scanner.js https://example.com 30

# Authentifizierter Scan
node scanner.js https://example.com --user email@test.com --pass secret123

# Mit eigener URL-Liste
node scanner.js https://example.com --urls urls.txt
```

Output: `scan_example.com_<timestamp>.json`

### PDF-Bericht erstellen

```bash
node report.js scan_example.com_1234.json "Musterfirma GmbH" bericht.pdf
```

### Batch-Scan (Lead-Generierung)

Scannt Unternehmen aus einer NorthData-CSV-Exportdatei und erstellt pro Firma einen PDF-Bericht.

```bash
node batch-scan.js searchresults.csv --output ./reports --max-pages 5 --delay 5
```

| Option | Default | Beschreibung |
|---|---|---|
| `--output <dir>` | `./reports` | Output-Ordner |
| `--max-pages <n>` | `5` | Max Seiten pro Website |
| `--delay <seconds>` | `5` | Pause zwischen Scans |

**CSV-Format:** Semikolon-getrennt, Windows-1252-Encoding. Spalten werden per Header erkannt (`Name`, `Website` etc.).

**Output-Struktur:**
```
reports/
  batch-state.json           # Resume-State (Abbruch + Neustart möglich)
  zusammenfassung.csv        # Übersicht: Firma, Website, Score, Verstöße, Status
  firmenname/
    scan-result.json         # Rohdaten
    bericht-firmenname.pdf   # PDF-Bericht
```

### WordPress-Remediation

```bash
node wp-adapter.js <scan-result.json> [--wp-url URL --wp-user USER --wp-pass PASS]
```

### Notion-Sync

```bash
node notion-sync.js push <scan-result.json> <notion-db-id>
node notion-sync.js update-fixed <remediation-result.json> <notion-db-id>
```

## npm Scripts

```bash
npm run scan      # node scanner.js
npm run report    # node report.js
npm run fix       # node wp-adapter.js
npm run batch     # node batch-scan.js
```

## Scoring

Der Score (0-100) gewichtet Verstöße nach Schweregrad:

| Schweregrad | Gewicht |
|---|---|
| Critical | 10 |
| Serious | 5 |
| Moderate | 2 |
| Minor | 1 |

## Technologie-Stack

- **Playwright** — Browser-Automatisierung und Crawling
- **axe-core** — Primäre WCAG-Prüfung
- **HTML_CodeSniffer** — Ergänzende WCAG-Prüfung
- **Puppeteer** — PDF-Generierung
- **Supabase** — Ergebnis-Speicherung (optional)
- **Notion API** — Finding-Tracking (optional)

## Lizenz

Proprietary — GreenOnion FlexCo
