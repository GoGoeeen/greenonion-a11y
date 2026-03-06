-- Change default max_pages to 10
ALTER TABLE public.accessibility_scans
  ALTER COLUMN max_pages SET DEFAULT 10;

-- Update Trigger-Function to use 10 as fallback
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
        'max_pages', COALESCE(NEW.max_pages, 10)
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
