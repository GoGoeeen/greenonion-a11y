-- Add missing columns to accessibility_scans table
-- These columns are required by scripts/scan.ts to store scan results

ALTER TABLE public.accessibility_scans
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS scan_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pages_scanned INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pages_scanned_urls TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS total_findings INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS critical_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS serious_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS moderate_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minor_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS findings JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS raw_scan_result JSONB DEFAULT '{}'::jsonb;

-- Also fix the status check constraint to include 'running'
-- (scan.ts sets status to 'running' when it starts)
ALTER TABLE public.accessibility_scans
  DROP CONSTRAINT IF EXISTS accessibility_scans_status_check;

ALTER TABLE public.accessibility_scans
  ADD CONSTRAINT accessibility_scans_status_check
  CHECK (status IN ('pending', 'running', 'processing', 'completed', 'failed'));

-- Reload schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
