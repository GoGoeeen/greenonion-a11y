-- max_pages Spalte hinzufügen und DB-Trigger aktualisieren

ALTER TABLE public.accessibility_scans
  ADD COLUMN IF NOT EXISTS max_pages INTEGER DEFAULT 20;

-- Trigger-Function aktualisieren: max_pages an Edge Function weitergeben
CREATE OR REPLACE FUNCTION public.trigger_scan_webhook()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM net.http_post(
      url := 'https://vghixeurkagwfohkvhzf.supabase.co/functions/v1/on-scan-inserted',
      body := jsonb_build_object(
        'scan_id', NEW.id,
        'client_id', NEW.client_id,
        'domain', NEW.domain,
        'max_pages', COALESCE(NEW.max_pages, 20)
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json'
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

NOTIFY pgrst, 'reload schema';
