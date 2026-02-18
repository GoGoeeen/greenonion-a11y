CREATE OR REPLACE FUNCTION create_accessibility_scan(
  p_client_id UUID,
  p_domain TEXT
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.accessibility_scans (client_id, domain, status, scanned_at, results)
  VALUES (p_client_id, p_domain, 'pending', now(), '{}'::jsonb)
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
