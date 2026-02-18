-- Automatischer GitHub-Action-Trigger bei neuem Scan mit status='pending'
-- Nutzt pg_net um die Edge Function on-scan-inserted aufzurufen

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.trigger_scan_webhook()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM net.http_post(
      url := 'https://vghixeurkagwfohkvhzf.supabase.co/functions/v1/on-scan-inserted',
      body := jsonb_build_object(
        'scan_id', NEW.id,
        'client_id', NEW.client_id,
        'domain', NEW.domain
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json'
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_scan_inserted ON public.accessibility_scans;

CREATE TRIGGER on_scan_inserted
  AFTER INSERT ON public.accessibility_scans
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_scan_webhook();
