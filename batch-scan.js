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
 *   --sort-by <spalte>   Nach Spalte sortieren (z.B. "Umsatz EUR")
 *   --sort-dir <asc|desc> Sortierrichtung (default: asc)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { scan } from './scanner.js';
import { generateReport } from './report.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Supabase Client Initialization
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyRawScanResult(scanId, expectedRawResult) {
  const expectedLength = JSON.stringify(expectedRawResult).length;
  const expectedPages = expectedRawResult.pages?.length || 0;
  const expectedIssues = expectedRawResult.totalIssues;

  const { data, error } = await supabase
    .from('accessibility_scans')
    .select('raw_scan_result')
    .eq('id', scanId)
    .single();

  if (error) {
    throw new Error(`Supabase verify failed: ${error.message}`);
  }

  const persisted = data?.raw_scan_result;
  if (!persisted || typeof persisted !== 'object') {
    throw new Error('Supabase verify failed: raw_scan_result missing after save');
  }

  const persistedLength = JSON.stringify(persisted).length;
  const persistedPages = persisted.pages?.length || 0;
  const persistedIssues = persisted.totalIssues;
  const isValid =
    persisted.pagesScanned === expectedRawResult.pagesScanned &&
    persistedPages === expectedPages &&
    persistedIssues === expectedIssues &&
    persistedLength >= expectedLength;

  if (!isValid) {
    throw new Error(
      `Supabase verify failed: raw_scan_result mismatch (expected len=${expectedLength}, pages=${expectedPages}, issues=${expectedIssues}; got len=${persistedLength}, pages=${persistedPages}, issues=${String(persistedIssues)})`
    );
  }
}


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
  const header = 'Firma;Website;Score;Verstoesse;Status;ShareLink';
  const lines = results.map(r =>
    `${r.name};${r.website};${r.score ?? ''};${r.violations ?? ''};${r.status};${r.shareLink ?? ''}`
  );
  writeFileSync(summaryPath, [header, ...lines].join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Deutsche Zahl parsen (z.B. "240.214.492,36" → 240214492.36)
// ---------------------------------------------------------------------------
function parseGermanNumber(str) {
  if (!str || str.trim() === '') return null;
  const cleaned = str.trim().replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Pause
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Trigger API Scan
// ---------------------------------------------------------------------------
async function triggerAccessibilityScan(client) {
  if (!supabase) {
    console.error('Supabase credentials missing. Cannot trigger scan.');
    return;
  }

  // Bedingung: Status pending UND enabled (hier simuliert)
  // In einer echten App würde man das Client-Objekt prüfen.
  // Für diesen Test nehmen wir an, wenn die Funktion aufgerufen wird, soll gescannt werden.

  try {
    const { data, error } = await supabase.functions.invoke('scan-accessibility', {
      body: { clientId: client.id, domain: client.domain },
    });

    if (error) throw error;

    console.log(`  [API] Scan triggered for ${client.domain}. Scan ID: ${data.scanId}`);
    return data;
  } catch (err) {
    console.error(`  [API] Failed to trigger scan for ${client.domain}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker Mode
// ---------------------------------------------------------------------------
async function runWorker() {
  console.log('Starting Accessibility Scan Worker...');
  console.log('Polling for pending scans...');

  if (!supabase) {
    console.error('Supabase credentials missing. Worker cannot start.');
    process.exit(1);
  }

  while (true) {
    try {
      // 1. Fetch pending scan
      const { data: scanJob, error } = await supabase
        .from('accessibility_scans')
        .select('*')
        .eq('status', 'pending')
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        console.error('Error fetching pinsted scan:', error.message);
      }

      if (scanJob) {
        console.log(`\nProcessing scan job: ${scanJob.id} for ${scanJob.domain}`);

        // Update status to processing
        await supabase
          .from('accessibility_scans')
          .update({ status: 'processing' })
          .eq('id', scanJob.id);

        try {
          // Normalize URL - add https:// if missing
          let normalizedUrl = scanJob.domain.trim();
          if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
            normalizedUrl = 'https://' + normalizedUrl;
            console.log(`  Normalized URL: ${normalizedUrl}`);
          }

          // 2. Run Scanner
          const result = await scan({ url: normalizedUrl, maxPages: 50 }); // Default max pages

          // 3. Transform results to match existing database schema
          // Count severity levels
          let criticalCount = 0;
          let seriousCount = 0;
          let moderateCount = 0;
          let minorCount = 0;

          const allFindings = [];
          for (const page of result.pages) {
            for (const issue of page.issues) {
              const nodeCount = issue.nodes?.length || 1;

              // Count by severity
              if (issue.severity === 'critical') criticalCount += nodeCount;
              else if (issue.severity === 'serious') seriousCount += nodeCount;
              else if (issue.severity === 'moderate') moderateCount += nodeCount;
              else if (issue.severity === 'minor') minorCount += nodeCount;

              // Add to findings array
              allFindings.push({
                rule: issue.rule || issue.id,
                severity: issue.severity,
                wcag: issue.wcag,
                description: issue.description,
                impact: issue.impact,
                help: issue.help,
                helpUrl: issue.helpUrl,
                pageUrl: page.url,
                nodeCount,
                nodes: issue.nodes
              });
            }
          }

          // 4. Save results to database + verify persisted raw payload
          let saveOk = false;
          let lastSaveError = null;

          for (let attempt = 1; attempt <= 2; attempt++) {
            const { error: updateError } = await supabase
              .from('accessibility_scans')
              .update({
                status: 'completed',
                scan_date: new Date().toISOString(),
                pages_scanned: result.pagesScanned,
                pages_scanned_urls: result.pages.map(p => p.url),
                total_findings: result.totalIssues,
                critical_count: criticalCount,
                serious_count: seriousCount,
                moderate_count: moderateCount,
                minor_count: minorCount,
                score: result.score,
                findings: allFindings,
                raw_scan_result: result,
                updated_at: new Date().toISOString()
              })
              .eq('id', scanJob.id);

            if (updateError) {
              lastSaveError = updateError.message;
              break;
            }

            try {
              await verifyRawScanResult(scanJob.id, result);
              saveOk = true;
              break;
            } catch (verifyErr) {
              lastSaveError = verifyErr.message;
            }
          }

          if (!saveOk) {
            throw new Error(lastSaveError || 'Unknown save/verify error');
          }

          console.log(`Scan completed for ${scanJob.domain}`);

        } catch (scanError) {
          console.error(`❌ Scan failed for ${scanJob.domain}:`, scanError.message);

          const { error: updateError } = await supabase
            .from('accessibility_scans')
            .update({
              status: 'failed',
              error_message: scanError.message,
              scanned_at: new Date().toISOString()
            })
            .eq('id', scanJob.id);

          if (updateError) {
            console.error(`Failed to update error status:`, updateError.message);
          } else {
            console.log(`  Status set to 'failed' in database`);
          }
        }
      } else {
        // No jobs, wait a bit
        // process.stdout.write('.');
      }

      await sleep(5000); // 5 seconds poll interval

    } catch (err) {
      console.error('Worker loop error:', err);
      await sleep(5000);
    }
  }
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Check for worker mode first - it doesn't need a CSV file
  const isWorker = args.worker || false;

  if (isWorker) {
    await runWorker();
    return;
  }

  // For non-worker modes, CSV is required
  if (args._positional.length === 0) {
    console.log(`Usage: node batch-scan.js <input.csv> [Optionen]

GreenOnion A11y Batch-Scanner
Scannt Unternehmen aus einer NorthData-CSV und erstellt PDF-Berichte.

Optionen:
  --output <dir>       Output-Ordner (default: ./reports)
  --max-pages <n>      Max Seiten pro Website (default: 5)
  --delay <seconds>    Pause zwischen Scans (default: 5)
  --sort-by <spalte>   Nach CSV-Spalte sortieren (z.B. "Umsatz EUR")
  --sort-dir <asc|desc> Sortierrichtung (default: asc)
  --worker             Startet den Worker-Prozess (Polling)
  --trigger-api        Nutzt die API statt lokalem Scan (für Batch-Mode)


Beispiel:
  node batch-scan.js searchresults.csv --output ./reports --max-pages 3 --delay 2
  node batch-scan.js searchresults.csv --sort-by "Umsatz EUR" --sort-dir asc
  node batch-scan.js --worker`);
    process.exit(1);
  }

  const csvPath = args._positional[0];
  const outputDir = args.output || './reports';
  const maxPages = parseInt(args['max-pages']) || 5;
  const delaySec = parseInt(args.delay) || 5;
  const sortBy = args['sort-by'] || null;

  const sortDir = (args['sort-dir'] || 'asc').toLowerCase();
  const useApi = args['trigger-api'] || false;

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
      _row: row,
    }))
    .filter(c => c.name && c.website);

  // Sortierung
  if (sortBy) {
    const sortCol = findColumn(headers, [sortBy]);
    if (!sortCol) {
      console.error(`  Fehler: Sortier-Spalte "${sortBy}" nicht gefunden.`);
      console.error(`  Verfügbare Spalten: ${headers.join(', ')}`);
      process.exit(1);
    }
    companies.sort((a, b) => {
      const valA = parseGermanNumber(a._row[sortCol]);
      const valB = parseGermanNumber(b._row[sortCol]);
      // Firmen ohne Wert ans Ende
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1;
      if (valB === null) return -1;
      return sortDir === 'desc' ? valB - valA : valA - valB;
    });
    console.log(`  Sortiert nach "${sortCol}" (${sortDir === 'desc' ? 'absteigend' : 'aufsteigend'})`);
  }

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
      if (useApi) {
        // Simulate a client object
        const client = { id: '00000000-0000-0000-0000-000000000000', domain: company.website }; // Dummy UUID for now or standard one
        // Note: In real setup, we should probably create the client in DB first if it doesn't exist
        // For this demo, we just call the trigger
        await triggerAccessibilityScan(client);
        console.log('    -> Triggered via API');
        continue; // Skip local processing
      }

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

      // Supabase INSERT → share_token wird automatisch generiert
      let shareLink = '';
      if (supabase) {
        try {
          const { data: inserted, error: insertErr } = await supabase
            .from('accessibility_scans')
            .insert({
              domain: company.website,
              status: 'completed',
              score: scanResult.score ?? null,
              total_findings: totalViolations,
              pages_scanned: scanResult.pages?.length ?? 0,
              raw_scan_result: scanResult,
            })
            .select('share_token')
            .single();
          if (!insertErr && inserted?.share_token) {
            shareLink = `https://gogoeeen.github.io/greenonion-a11y/report-viewer.html?token=${inserted.share_token}`;
            console.log(`    🔗 Share-Link: ${shareLink}`);
          }
        } catch (sbErr) {
          console.log(`    ⚠ Supabase-Speicherung fehlgeschlagen: ${sbErr.message}`);
        }
      }

      const summaryEntry = {
        name: company.name,
        website: company.website,
        score: scanResult.score ?? '',
        violations: totalViolations,
        status: 'OK',
        shareLink,
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

