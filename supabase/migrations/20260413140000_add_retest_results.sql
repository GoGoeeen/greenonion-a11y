-- Phase E: NVDA-Retest-Ergebnisse pro Scan speichern
--
-- Speichert das RetestReport-Objekt aus scripts/retest-nvda.ts.
-- Struktur: { generated_at, source_file, domain, runner, total_candidates,
--             passed, failed, skipped, errors, results[] }
--
-- Wird via npm run retest:nvda -- --scan-id <uuid> befuellt.

ALTER TABLE accessibility_scans
  ADD COLUMN IF NOT EXISTS retest_results JSONB;

COMMENT ON COLUMN accessibility_scans.retest_results IS
  'NVDA-Retest-Ergebnisse (RetestReport). Befuellt via retest-nvda.ts --scan-id.';
