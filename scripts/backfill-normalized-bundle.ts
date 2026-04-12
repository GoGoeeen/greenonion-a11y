/**
 * Phase B Backfill — normalized_bundle fuer bestehende Supabase-Records erzeugen
 *
 * Liest alle accessibility_scans-Records ohne normalized_bundle, erzeugt aus
 * raw_scan_result + findings + manual_checks einen NormalizedScanBundle und
 * schreibt ihn in die normalized_bundle-Spalte zurueck.
 *
 * Voraussetzung: Migration 20260412120000_add_normalized_bundle.sql muss
 * in Supabase ausgefuehrt worden sein.
 *
 * Usage:
 *   tsx scripts/backfill-normalized-bundle.ts
 *   tsx scripts/backfill-normalized-bundle.ts --dry-run   (nur Ausgabe, kein Schreiben)
 *   tsx scripts/backfill-normalized-bundle.ts --limit 10  (max. N Records)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeScan } from '../src/normalize/normalize-scan.js';

// --- Typen fuer Raw-DB-Records ---

interface DbScanRow {
  id: string;
  domain: string;
  scan_date: string | null;
  raw_scan_result: unknown;
  findings: unknown;
  manual_checks: unknown;
}

// --- CLI-Args ---

const DEFAULT_BATCH_SIZE = 3;

function parseBackfillArgs(): { dryRun: boolean; limit: number | null; batchSize: number } {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx !== -1 && argv[limitIdx + 1] ? parseInt(argv[limitIdx + 1], 10) : null;
  const batchIdx = argv.indexOf('--batch-size');
  const batchSize = batchIdx !== -1 && argv[batchIdx + 1]
    ? parseInt(argv[batchIdx + 1], 10)
    : DEFAULT_BATCH_SIZE;
  return { dryRun, limit, batchSize };
}

// --- Normalisierungs-Helper ---

/**
 * Versucht einen DB-Record zu normalisieren.
 * Gibt null zurueck wenn der Record unvollstaendig oder nicht normalisierbar ist.
 */
function normalizeRecord(row: DbScanRow): ReturnType<typeof normalizeScan> | null {
  const raw = row.raw_scan_result;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).pages)) {
    return null;
  }

  // findings: Array aus DB oder leeres Array
  const findings = Array.isArray(row.findings) ? row.findings : [];

  // manual_checks: kann in raw_scan_result.manual_checks oder eigener Spalte sein
  const rawRecord = raw as Record<string, unknown>;
  const manualChecksFromRaw = Array.isArray(rawRecord.manual_checks) ? rawRecord.manual_checks : [];
  const manualChecksFromCol = Array.isArray(row.manual_checks) ? row.manual_checks : [];
  // Eigene Spalte hat Vorrang — mehr Evidence (agent_descriptions etc.)
  const manualChecks = manualChecksFromCol.length > 0 ? manualChecksFromCol : manualChecksFromRaw;

  try {
    return normalizeScan(
      raw as Parameters<typeof normalizeScan>[0],
      findings as Parameters<typeof normalizeScan>[1],
      manualChecks as Parameters<typeof normalizeScan>[2],
    );
  } catch (err) {
    return null;
  }
}

// --- Haupt-Loop ---

/** Einen Batch von IDs laden — nur IDs, kein JSONB */
async function fetchBatchIds(
  supabase: // eslint-disable-next-line @typescript-eslint/no-explicit-any
any,
  offset: number,
  batchSize: number,
): Promise<{ ids: string[]; error: string | null }> {
  const { data, error } = await supabase
    .from('accessibility_scans')
    .select('id')
    .is('normalized_bundle', null)
    .eq('status', 'completed')
    .order('scan_date', { ascending: false })
    .range(offset, offset + batchSize - 1);

  if (error) return { ids: [], error: error.message };
  return { ids: (data ?? []).map((r: { id: string }) => r.id), error: null };
}

/** Einzelnen Record mit JSONB-Spalten per ID laden */
async function fetchRecord(
  supabase: // eslint-disable-next-line @typescript-eslint/no-explicit-any
any,
  id: string,
): Promise<{ row: DbScanRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from('accessibility_scans')
    .select('id, domain, scan_date, raw_scan_result, findings, manual_checks')
    .eq('id', id)
    .single();

  if (error) return { row: null, error: error.message };
  return { row: data as DbScanRow, error: null };
}

async function main(): Promise<void> {
  const { dryRun, limit, batchSize } = parseBackfillArgs();

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      'Fehler: SUPABASE_URL und ein Supabase-Key muessen gesetzt sein.\n' +
      'Unterstuetzte Variablen: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_KEY, SUPABASE_KEY, SUPABASE_ANON_KEY',
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log(`\nPhase B Backfill — normalized_bundle${dryRun ? ' (DRY RUN)' : ''} (batch-size: ${batchSize})\n`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let offset = 0;
  let totalSeen = 0;

  // Paginierter Loop: erst IDs laden (leichtgewichtig), dann Record einzeln
  while (true) {
    const remaining = limit !== null ? limit - totalSeen : batchSize;
    if (remaining <= 0) break;

    const fetchSize = Math.min(batchSize, remaining);
    const { ids, error: idError } = await fetchBatchIds(supabase, offset, fetchSize);

    if (idError) {
      if (/normalized_bundle/i.test(idError)) {
        console.error(
          'Fehler: Spalte "normalized_bundle" existiert noch nicht in accessibility_scans.\n' +
          'Migration ausfuehren:\n' +
          '  ALTER TABLE public.accessibility_scans ADD COLUMN IF NOT EXISTS normalized_bundle JSONB DEFAULT NULL;\n',
        );
      } else {
        console.error(`Fehler beim Lesen der IDs: ${idError}`);
      }
      process.exit(1);
    }

    if (ids.length === 0) break; // keine weiteren Records

    totalSeen += ids.length;

    for (const id of ids) {
      const { row, error: rowError } = await fetchRecord(supabase, id);

      if (rowError || !row) {
        console.log(`  FAIL  [${id.substring(0, 8)}] — Lesefehler: ${rowError ?? 'leer'}`);
        failed++;
        continue;
      }

      const label = `[${row.id.substring(0, 8)}] ${row.domain} (${row.scan_date?.substring(0, 10) ?? 'unbekannt'})`;
      const bundle = normalizeRecord(row);

      if (!bundle) {
        console.log(`  SKIP  ${label} — raw_scan_result unvollstaendig oder Normalisierung fehlgeschlagen`);
        skipped++;
        continue;
      }

      const instanceCount = bundle.finding_instances.length;
      const candidateCount = bundle.automation_candidates.length;

      if (dryRun) {
        console.log(`  DRY   ${label} → ${instanceCount} instances, ${candidateCount} candidates`);
        processed++;
        continue;
      }

      const { error: updateError } = await supabase
        .from('accessibility_scans')
        .update({ normalized_bundle: bundle, updated_at: new Date().toISOString() })
        .eq('id', row.id);

      if (updateError) {
        console.log(`  FAIL  ${label} — ${updateError.message}`);
        failed++;
      } else {
        console.log(`  OK    ${label} → ${instanceCount} instances, ${candidateCount} candidates`);
        processed++;
      }
    }

    // Bei dry-run: offset vorruecken weil keine Updates → IDs bleiben erhalten
    // Bei echtem Run: offset bleibt bei 0, da verarbeitete Records normalized_bundle bekommen
    if (dryRun) {
      offset += ids.length;
    }

    if (ids.length < fetchSize) break; // letzte Seite erreicht
  }

  console.log(`\nErgebnis: ${processed} OK | ${skipped} uebersprungen | ${failed} fehlgeschlagen\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unerwarteter Fehler:', err);
  process.exit(1);
});
