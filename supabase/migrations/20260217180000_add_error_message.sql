-- Fuegt error_message Spalte hinzu (fehlt in der aktuellen DB)
ALTER TABLE accessibility_scans ADD COLUMN IF NOT EXISTS error_message TEXT;
