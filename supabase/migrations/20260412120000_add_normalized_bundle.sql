-- Phase B: normalized_bundle Spalte fuer strukturierten Automation-Layer-Export
-- Speichert das vollstaendige NormalizedScanBundle (finding_instances, automation_candidates,
-- executive_summary) als JSONB parallel zum bestehenden raw_scan_result.

ALTER TABLE public.accessibility_scans
  ADD COLUMN IF NOT EXISTS normalized_bundle JSONB DEFAULT NULL;

-- GIN-Index fuer effiziente JSON-Queries (finding_instances, automation_candidates)
CREATE INDEX IF NOT EXISTS idx_accessibility_scans_normalized_bundle
  ON public.accessibility_scans USING GIN (normalized_bundle)
  WHERE normalized_bundle IS NOT NULL;

-- Schema-Cache neu laden
NOTIFY pgrst, 'reload schema';
