-- share_token: zufälliger UUID als sicherer Link-Parameter für Kunden-Reports
ALTER TABLE public.accessibility_scans
  ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT;

UPDATE public.accessibility_scans
  SET share_token = gen_random_uuid()::TEXT
  WHERE share_token IS NULL;

ALTER TABLE public.accessibility_scans
  ALTER COLUMN share_token SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accessibility_scans_share_token
  ON public.accessibility_scans(share_token);
