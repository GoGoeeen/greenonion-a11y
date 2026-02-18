-- Clean up test data and restore foreign key for accessibility_scans
-- First, delete any test records that don't have a valid customer reference
-- (especially the dummy ID 00000000-0000-0000-0000-000000000000)
DELETE FROM public.accessibility_scans
WHERE client_id NOT IN (SELECT id FROM public.clients);

-- Now add the foreign key constraint
ALTER TABLE public.accessibility_scans
ADD CONSTRAINT accessibility_scans_client_id_fkey
FOREIGN KEY (client_id)
REFERENCES public.clients(id)
ON DELETE CASCADE;

-- Reload schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
