CREATE TABLE public.accessibility_scans (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID, -- TODO: Add REFERENCES public.clients(id) back when clients table is confirmed
    domain TEXT NOT NULL,
    scanned_at TIMESTAMPTZ DEFAULT now(),
    results JSONB DEFAULT '{}'::jsonb,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT
);

CREATE INDEX idx_accessibility_scans_client_id ON public.accessibility_scans(client_id);
CREATE INDEX idx_accessibility_scans_status ON public.accessibility_scans(status);

ALTER TABLE public.accessibility_scans ENABLE ROW LEVEL SECURITY;

-- Allow everything for now to debug (but rely on Service Key in function)
CREATE POLICY "Enable all for all users" ON public.accessibility_scans
FOR ALL USING (true) WITH CHECK (true);
