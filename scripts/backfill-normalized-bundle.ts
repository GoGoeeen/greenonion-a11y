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

function parseBackfillArgs(): { dryRun: boolean; limit: number | null } {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx !== -1 && argv[limitIdx + 1] ? parseInt(argv[limitIdx + 1], 10) : null;
  return { dryRun, limit };
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

async function main(): Promise<void> {
  const { dryRun, limit } = parseBackfillArgs();

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

  console.log(`\nPhase B Backfill — normalized_bundle${dryRun ? ' (DRY RUN)' : ''}\n`);

  // Records lesen die noch kein normalized_bundle haben
  let query = supabase
    .from('accessibility_scans')
    .select('id, domain, scan_date, raw_scan_result, findings, manual_checks')
    .is('normalized_bundle', null)
    .eq('status', 'completed')
    .order('scan_date', { ascending: false });

  if (limit !== null) {
    query = query.limit(limit);
  }

  const { data: rows, error: fetchError } = await query;

  if (fetchError) {
    // Pruefe ob normalized_bundle-Spalte fehlt
    if (/normalized_bundle/i.test(String(fetchError.message))) {
      console.error(
        'Fehler: Spalte "normalized_bundle" existiert noch nicht in accessibility_scans.\n' +
        'Migration ausfuehren: supabase db push oder SQL direkt:\n' +
        '  ALTER TABLE public.accessibility_scans ADD COLUMN IF NOT EXISTS normalized_bundle JSONB DEFAULT NULL;\n',
      );
    } else {
      console.error(`Fehler beim Lesen der Records: ${fetchError.message}`);
    }
    process.exit(1);
  }

  const totalRows = rows?.length ?? 0;
  console.log(`  ${totalRows} Records ohne normalized_bundle gefunden.\n`);

  if (totalRows === 0) {
    console.log('  Nichts zu tun — alle completed Records haben bereits normalized_bundle.\n');
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of (rows as DbScanRow[])) {
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

  console.log(`\nErgebnis: ${processed} OK | ${skipped} uebersprungen | ${failed} fehlgeschlagen\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unerwarteter Fehler:', err);
  process.exit(1);
});
