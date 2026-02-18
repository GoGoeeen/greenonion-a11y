-- Add missing columns to accessibility_scans table
ALTER TABLE public.accessibility_scans ADD COLUMN IF NOT EXISTS results JSONB;
ALTER TABLE public.accessibility_scans ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Drop potentially conflicting column (if present from previous attempts)
ALTER TABLE public.accessibility_scans DROP COLUMN IF EXISTS results_old;
