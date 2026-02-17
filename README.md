# GreenOnion A11y Scanner

Automatisierter WCAG 2.1 AA Barrierefreiheits-Scanner mit PDF-Berichterstellung. Kombiniert drei Prüf-Engines (axe-core, HTML_CodeSniffer, Custom Checks) zu einem Gesamtscore pro Website.

## Architektur

```
┌─────────────────────┐     workflow_dispatch      ┌──────────────────────┐
│   Admin-App /       │ ─────────────────────────→ │   GitHub Actions     │
│   Lead-Generator    │    (domain, client_id,     │   scan.yml           │
│                     │     scan_id, max_pages)    │                      │
└─────────────────────┘                            │  1. npm ci           │
                                                   │  2. playwright inst. │
        ┌──────────────────────────────────────────│  3. tsx scan.ts      │
        │           Ergebnisse                     └──────────────────────┘
        ▼                                                    │
┌─────────────────────┐                                      │ scan()
│   Supabase          │     INSERT/UPDATE                    │
│   accessibility_    │ ←────────────────────────────────────┘
│   scans             │
└─────────────────────┘
```

**Ablauf:**
1. Admin-App erstellt Zeile in `accessibility_scans` (status=`pending`)
2. Admin-App triggert GitHub Action via `workflow_dispatch`
3. GitHub Action führt `scripts/scan.ts` aus
4. Scan-Ergebnisse werden in dieselbe Zeile geschrieben (status=`completed` oder `failed`)

## Features

- **Multi-Engine-Scan** — axe-core + HTML_CodeSniffer + eigene Prüfungen (Focus, Headings, Language, Animations, Reflow)
- **Automatisches Crawling** — Sitemap-basiert oder Link-Crawling, konfigurierbare Seitenanzahl
- **Cookie-Banner-Handling** — Automatisches Wegklicken gängiger Cookie-Consent-Dialoge
- **Authentifizierte Scans** — Login mit Credentials und konfigurierbaren Selektoren
- **GitHub Actions Integration** — Scan als Service per API triggerbar
- **PDF-Berichte** — Professionelle Berichte im GreenOnion-CI mit Score und Handlungsempfehlungen
- **Batch-Scanner** — CSV-Import (NorthData-Export), automatischer Scan hunderter Firmen mit Resume-Funktion
- **WordPress-Remediation** — Automatische Behebung von Barrierefreiheitsproblemen via WP REST API

## Voraussetzungen

- Node.js >= 20
- Playwright-Browser (`npx playwright install chromium`)

## Installation

```bash
git clone https://github.com/GoGoeeen/greenonion-a11y.git
cd greenonion-a11y
npm install
npx playwright install chromium
cp .env.example .env  # Anpassen für Supabase/Notion/WordPress
```

## GitHub Actions Setup

### Secrets konfigurieren

Im GitHub-Repository unter **Settings → Secrets and variables → Actions** folgende Secrets anlegen:

| Secret | Beschreibung |
|--------|-------------|
| `SUPABASE_URL` | Supabase Projekt-URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase Service-Role-Key (nicht Anon-Key!) |

### Scan manuell triggern (GitHub UI)

1. **Actions** Tab öffnen
2. **Accessibility Scan** Workflow auswählen
3. **Run workflow** klicken
4. Felder ausfüllen: `domain`, `client_id`, `scan_id`, `max_pages`

### Scan per API triggern

```bash
curl -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/GoGoeeen/greenonion-a11y/actions/workflows/scan.yml/dispatches \
  -d '{
    "ref": "main",
    "inputs": {
      "domain": "example.com",
      "client_id": "UUID",
      "scan_id": "UUID",
      "max_pages": "5"
    }
  }'
```

Referenz-Code für TypeScript: `scripts/trigger-example.ts`

## Verwendung

### Neuer Scan (GitHub Actions-kompatibel)

```bash
# Lokal testen (Ergebnis als JSON-Datei)
npm run scan:local -- --domain=example.com --max-pages=3

# Mit Supabase (wie in GitHub Actions)
npm run scan -- --domain=example.com --client-id=UUID --scan-id=UUID --max-pages=5
```

### Legacy-Scanner (direkter Aufruf)

```bash
# Öffentlicher Scan (max 30 Seiten)
node scanner.js https://example.com 30

# Authentifizierter Scan
node scanner.js https://example.com --user email@test.com --pass secret123

# Mit eigener URL-Liste
node scanner.js https://example.com --urls urls.txt
```

### PDF-Bericht erstellen

```bash
node report.js scan_example.com_1234.json "Musterfirma GmbH" bericht.pdf
```

### Batch-Scan (Lead-Generierung)

```bash
node batch-scan.js searchresults.csv --output ./reports --max-pages 5 --delay 5
```

## npm Scripts

| Script | Befehl | Beschreibung |
|--------|--------|-------------|
| `scan` | `tsx scripts/scan.ts` | Neuer Scanner (Supabase/GitHub Actions) |
| `scan:local` | `tsx scripts/scan.ts -- --local` | Lokaler Test (JSON-Output) |
| `scan:legacy` | `node scanner.js` | Legacy-Scanner (direkter Aufruf) |
| `report` | `node report.js` | PDF-Bericht generieren |
| `fix` | `node wp-adapter.js` | WordPress-Remediation |
| `batch` | `node batch-scan.js` | Batch-Scanner |

## Scoring

Der neue Scanner verwendet eine gewichtete Score-Berechnung auf Basis deduplizierter Findings:

| Schweregrad | Gewicht pro Element (max 10) |
|-------------|-----|
| Critical | 15 |
| Serious | 8 |
| Moderate | 3 |
| Minor | 1 |

Formel: `Score = max(0, round(100 - (penalty / 200) * 100))`

## Supabase-Schema

Die Scan-Ergebnisse werden in der Tabelle `accessibility_scans` gespeichert:

| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| `id` | UUID | Primary Key |
| `client_id` | UUID | Referenz auf Kunden |
| `domain` | TEXT | Gescannte Domain |
| `scan_date` | TIMESTAMPTZ | Zeitpunkt des Scans |
| `pages_scanned` | INTEGER | Anzahl gescannter Seiten |
| `total_findings` | INTEGER | Gesamtzahl der Verstöße |
| `critical_count` | INTEGER | Kritische Verstöße |
| `serious_count` | INTEGER | Schwerwiegende Verstöße |
| `moderate_count` | INTEGER | Mittlere Verstöße |
| `minor_count` | INTEGER | Geringfügige Verstöße |
| `score` | INTEGER | Barrierefreiheits-Score (0-100) |
| `status` | TEXT | pending/running/completed/failed |
| `findings` | JSONB | Deduplizierte Findings |
| `pages_scanned_urls` | TEXT[] | Liste der gescannten URLs |
| `raw_scan_result` | JSONB | Rohdaten des Scans |
| `error_message` | TEXT | Fehlermeldung bei Abbruch |

## Technologie-Stack

- **Playwright** — Browser-Automatisierung und Crawling
- **axe-core** — Primäre WCAG-Prüfung
- **HTML_CodeSniffer** — Ergänzende WCAG-Prüfung
- **tsx** — TypeScript-Ausführung ohne Kompilierung
- **Supabase** — Ergebnis-Speicherung
- **GitHub Actions** — Scan-Ausführung als Service

## Lizenz

Proprietary — GreenOnion FlexCo
