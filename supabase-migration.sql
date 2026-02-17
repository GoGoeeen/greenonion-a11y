-- GreenOnion A11y Compliance Factory — Supabase Schema
-- Run this after creating the Supabase project

-- Customers
CREATE TABLE customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  wp_url TEXT,
  wp_user TEXT,
  credentials_vault_key TEXT,
  contact_name TEXT,
  contact_email TEXT,
  status TEXT DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'paused', 'completed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Scans
CREATE TABLE scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  scan_type TEXT DEFAULT 'full' CHECK (scan_type IN ('full', 'rescan', 'delta')),
  pages_scanned INT DEFAULT 0,
  total_issues INT DEFAULT 0,
  score INT DEFAULT 0,
  report_url TEXT,
  scan_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Issues
CREATE TABLE issues (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id) ON DELETE CASCADE,
  wcag_rule TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('critical', 'serious', 'moderate', 'minor')),
  selector TEXT,
  page_url TEXT NOT NULL,
  description TEXT,
  help TEXT,
  help_url TEXT,
  html_snippet TEXT,
  auto_fixable BOOLEAN DEFAULT false,
  fix_level TEXT CHECK (fix_level IN ('auto', 'semi-auto', 'manual')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'fixing', 'fixed', 'wont_fix', 'false_positive')),
  fixed_at TIMESTAMPTZ,
  notion_page_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Remediation Jobs
CREATE TABLE remediation_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id),
  trigger_mode TEXT DEFAULT 'manual' CHECK (trigger_mode IN ('manual', 'webhook', 'cron')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  pages_fixed INT DEFAULT 0,
  pages_failed INT DEFAULT 0,
  media_fixed INT DEFAULT 0,
  diff_summary JSONB,
  score_before INT,
  score_after INT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_issues_customer ON issues(customer_id);
CREATE INDEX idx_issues_scan ON issues(scan_id);
CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_severity ON issues(severity);
CREATE INDEX idx_scans_customer ON scans(customer_id);
CREATE INDEX idx_jobs_customer ON remediation_jobs(customer_id);

-- RLS Policies (enable after setting up auth)
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE remediation_jobs ENABLE ROW LEVEL SECURITY;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
