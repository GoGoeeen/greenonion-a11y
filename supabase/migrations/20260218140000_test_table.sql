CREATE TABLE IF NOT EXISTS public.test_scans (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.test_scans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for anon" ON public.test_scans
FOR ALL USING (true) WITH CHECK (true);
