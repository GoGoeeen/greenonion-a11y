/**
 * GreenOnion A11y Batch-Scanner
 *
 * Liest eine NorthData-CSV-Exportdatei ein und führt für jedes Unternehmen
 * mit Website einen Barrierefreiheits-Scan durch. Pro Firma wird ein
 * PDF-Bericht generiert, der als Lead-Türöffner dient.
 *
 * Usage:
 *   node batch-scan.js <input.csv> [Optionen]
 *
 * Optionen:
 *   --output <dir>       Output-Ordner (default: ./reports)
 *   --max-pages <n>      Max Seiten pro Website (default: 5)
 *   --delay <seconds>    Pause zwischen Scans (default: 5)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { scan } from './scanner.js';
import { generateReport } from './report.js';

// ---------------------------------------------------------------------------
// CLI Argument Parser
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts[key] = argv[++i];
      } else {
        opts[key] = true;
      }
    } else {
      opts._positional.push(argv[i]);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// CSV Parser (Windows-1252, Semikolon-getrennt)
// ---------------------------------------------------------------------------
function parseCSV(filePath) {
  const buffer = readFileSync(filePath);

  // Decode Windows-1252 (Latin-1 superset, gängig bei NorthData-Exporten)
  const decoder = new TextDecoder('windows-1252');
  const text = decoder.decode(buffer);

  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length < 2) {
    throw new Error('CSV enthält keine Daten (nur Header oder leer)');
  }

  const headers = lines[0].split(';').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(';').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Website-Spalte finden (robust gegen verschiedene Spaltennamen)
// ---------------------------------------------------------------------------
function findColumn(headers, candidates) {
  const lower = headers.map(h => h.toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL-Normalizer
// ---------------------------------------------------------------------------
function normalizeUrl(raw) {
  if (!raw || raw.trim() === '') return null;
  let url = raw.trim();

  // Protokoll ergänzen
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ordnernamen-Sanitizer
// ---------------------------------------------------------------------------
function sanitizeFolderName(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\(.*?\)/g, '')           // Klammern entfernen
    .replace(/[^a-z0-9-]/g, '-')       // Sonderzeichen → Bindestrich
    .replace(/-+/g, '-')               // Mehrfache Bindestriche zusammenfassen
    .replace(/^-|-$/g, '')             // Führende/trailing Bindestriche entfernen
    .slice(0, 60);                     // Max 60 Zeichen
}

// ---------------------------------------------------------------------------
// Resume-State
// ---------------------------------------------------------------------------
function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch {
      console.warn('  Warnung: batch-state.json beschädigt, starte neu.');
    }
  }
  return { completed: {}, errors: {} };
}

function saveState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Zusammenfassung als CSV schreiben
// ---------------------------------------------------------------------------
function writeSummary(summaryPath, results) {
  const header = 'Firma;Website;Score;Verstoesse;Status';
  const lines = results.map(r =>
    `${r.name};${r.website};${r.score ?? ''};${r.violations ?? ''};${r.status}`
  );
  writeFileSync(summaryPath, [header, ...lines].join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Pause
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args._positional.length === 0) {
    console.log(`Usage: node batch-scan.js <input.csv> [Optionen]

GreenOnion A11y Batch-Scanner
Scannt Unternehmen aus einer NorthData-CSV und erstellt PDF-Berichte.

Optionen:
  --output <dir>       Output-Ordner (default: ./reports)
  --max-pages <n>      Max Seiten pro Website (default: 5)
  --delay <seconds>    Pause zwischen Scans (default: 5)

Beispiel:
  node batch-scan.js searchresults.csv --output ./reports --max-pages 3 --delay 2`);
    process.exit(1);
  }

  const csvPath = args._positional[0];
  const outputDir = args.output || './reports';
  const maxPages = parseInt(args['max-pages']) || 5;
  const delaySec = parseInt(args.delay) || 5;

  if (!existsSync(csvPath)) {
    console.error(`CSV-Datei nicht gefunden: ${csvPath}`);
    process.exit(1);
  }

  // CSV einlesen
  console.log(`\n  CSV einlesen: ${csvPath}`);
  const { headers, rows } = parseCSV(csvPath);
  console.log(`  ${rows.length} Zeilen gefunden, Spalten: ${headers.join(', ')}`);

  // Spalten erkennen
  const nameCol = findColumn(headers, ['Name', 'Firma', 'Firmenname', 'Company', 'Unternehmen']);
  const websiteCol = findColumn(headers, ['Website', 'Web', 'URL', 'Homepage', 'Webseite']);

  if (!nameCol) {
    console.error('  Fehler: Keine Spalte für Firmenname gefunden (erwartet: Name, Firma, Firmenname, Company, Unternehmen)');
    process.exit(1);
  }
  if (!websiteCol) {
    console.error('  Fehler: Keine Spalte für Website gefunden (erwartet: Website, Web, URL, Homepage, Webseite)');
    process.exit(1);
  }

  console.log(`  Spalten-Mapping: Name → "${nameCol}", Website → "${websiteCol}"`);

  // Firmen mit Website filtern
  const companies = rows
    .map(row => ({
      name: row[nameCol]?.trim(),
      website: normalizeUrl(row[websiteCol]),
      rawWebsite: row[websiteCol]?.trim(),
    }))
    .filter(c => c.name && c.website);

  console.log(`  ${companies.length} Firmen mit gültiger Website\n`);

  if (companies.length === 0) {
    console.log('  Keine Firmen mit Website gefunden. Abbruch.');
    process.exit(0);
  }

  // Output-Ordner erstellen
  mkdirSync(outputDir, { recursive: true });

  // Resume-State laden
  const statePath = join(outputDir, 'batch-state.json');
  const state = loadState(statePath);
  const summaryResults = [];

  // Bereits abgeschlossene Firmen in die Zusammenfassung übernehmen
  for (const [key, data] of Object.entries(state.completed)) {
    summaryResults.push(data);
  }

  let scannedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  console.log(`  Start Batch-Scan: ${companies.length} Firmen, max ${maxPages} Seiten, ${delaySec}s Pause\n`);
  console.log('  ' + '='.repeat(60) + '\n');

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const folderName = sanitizeFolderName(company.name);
    const stateKey = `${folderName}__${company.website}`;

    // Skip bereits gescannte Firmen
    if (state.completed[stateKey]) {
      skippedCount++;
      console.log(`  [${i + 1}/${companies.length}] ⏭ ${company.name} — bereits gescannt`);
      continue;
    }

    console.log(`  [${i + 1}/${companies.length}] 🔍 ${company.name} (${company.website})`);

    const companyDir = join(outputDir, folderName);
    mkdirSync(companyDir, { recursive: true });

    try {
      // Scan durchführen
      const scanResult = await scan({ url: company.website, maxPages });

      // Scan-Ergebnis speichern
      const jsonPath = join(companyDir, 'scan-result.json');
      writeFileSync(jsonPath, JSON.stringify(scanResult, null, 2));

      // PDF-Bericht generieren
      const pdfPath = join(companyDir, `bericht-${folderName}.pdf`);
      await generateReport({
        scanResult,
        customerName: company.name,
        outputPath: pdfPath,
      });

      // Ergebnis für Zusammenfassung
      const totalViolations = scanResult.pages
        ? scanResult.pages.reduce((sum, p) => sum + (p.violations?.length || 0), 0)
        : 0;

      const summaryEntry = {
        name: company.name,
        website: company.website,
        score: scanResult.score ?? '',
        violations: totalViolations,
        status: 'OK',
      };

      state.completed[stateKey] = summaryEntry;
      summaryResults.push(summaryEntry);
      scannedCount++;

      console.log(`    ✅ Score: ${scanResult.score ?? 'N/A'}, ${totalViolations} Verstöße\n`);
    } catch (err) {
      const summaryEntry = {
        name: company.name,
        website: company.website,
        score: '',
        violations: '',
        status: `FEHLER: ${err.message?.slice(0, 100) || 'Unbekannt'}`,
      };

      state.errors[stateKey] = {
        ...summaryEntry,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      };
      summaryResults.push(summaryEntry);
      errorCount++;

      console.log(`    ❌ Fehler: ${err.message}\n`);
    }

    // State nach jedem Scan speichern (Resume-Sicherheit)
    saveState(statePath, state);

    // Pause zwischen Scans (außer nach dem letzten)
    if (i < companies.length - 1) {
      const nextCompany = companies[i + 1];
      const nextKey = `${sanitizeFolderName(nextCompany.name)}__${nextCompany.website}`;
      if (!state.completed[nextKey]) {
        console.log(`  ⏳ ${delaySec}s Pause...`);
        await sleep(delaySec * 1000);
      }
    }
  }

  // Zusammenfassung schreiben
  const summaryPath = join(outputDir, 'zusammenfassung.csv');
  writeSummary(summaryPath, summaryResults);

  console.log('\n  ' + '='.repeat(60));
  console.log(`\n  Batch-Scan abgeschlossen!`);
  console.log(`    Gescannt:    ${scannedCount}`);
  console.log(`    Übersprungen: ${skippedCount}`);
  console.log(`    Fehler:      ${errorCount}`);
  console.log(`    Gesamt:      ${companies.length}`);
  console.log(`\n  Zusammenfassung: ${summaryPath}`);
  console.log(`  Berichte:       ${outputDir}/\n`);
}

main().catch(err => {
  console.error('  Fataler Fehler:', err);
  process.exit(1);
});
