/**
 * Manueller Scan-Trigger — ruft die scan-accessibility Edge Function auf,
 * identisch zum Webapp-Trigger via flow.greenonion.services.
 *
 * Usage: npx tsx scripts/manual-trigger.ts
 *
 * Benoetigte .env-Variablen:
 *   SUPABASE_URL         — Supabase Projekt-URL
 *   SUPABASE_ANON_KEY    — Supabase Anon Key
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Scan-Daten
const CLIENT_ID = 'f73319a3-0cb2-42fb-bfc3-3593e0fb0947';
const DOMAIN    = 'www.tauernspakaprun.com';
const MAX_PAGES = 5;
const SCAN_TYPE: 'quick' | 'full' = 'full';

async function triggerScan() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.error('❌ SUPABASE_URL oder SUPABASE_ANON_KEY fehlt in .env');
        process.exit(1);
    }

    const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/scan-accessibility`;

    console.log(`🚀 Triggere Scan via Edge Function...`);
    console.log(`   Domain:    ${DOMAIN}`);
    console.log(`   Client ID: ${CLIENT_ID}`);
    console.log(`   Typ:       ${SCAN_TYPE}, max ${MAX_PAGES} Seiten`);
    console.log(`   Endpoint:  ${edgeFunctionUrl}`);

    const response = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
            clientId: CLIENT_ID,
            domain:   DOMAIN,
            max_pages: MAX_PAGES,
            scan_type: SCAN_TYPE,
        }),
    });

    const data = await response.json() as { success?: boolean; scanId?: string; shareLink?: string; error?: string };

    if (response.ok && data.success) {
        console.log(`✅ Scan gestartet (scan_id: ${data.scanId})`);
        console.log(`   Status prüfen: https://flow.greenonion.services`);
        if (data?.shareLink) {
          console.log('\n🔗 Kunden-Link:');
          console.log('   ' + data.shareLink);
        }
    } else {
        console.error(`❌ Trigger fehlgeschlagen (${response.status}):`, data.error ?? JSON.stringify(data));
    }
}

triggerScan().catch(console.error);
