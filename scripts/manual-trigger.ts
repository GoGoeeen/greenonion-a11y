/**
 * Manueller GitHub Action Trigger für einen bestehenden pending Scan
 * Usage: npx ts-node scripts/manual-trigger.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REPO_OWNER = 'GoGoeeen';
const REPO_NAME = 'greenonion-a11y';

// Scan-Daten aus Supabase
const SCAN_ID = '7ac0a63a-9bb9-4b4d-b95b-28d0b6ec68d3';
const CLIENT_ID = 'f73319a3-0cb2-42fb-bfc3-3593e0fb0947';
const DOMAIN = 'www.tauernspakaprun.com';

async function triggerScan() {
    if (!GITHUB_TOKEN) {
        console.error('❌ GITHUB_TOKEN nicht gesetzt in .env');
        process.exit(1);
    }

    console.log(`🚀 Triggere GitHub Action für ${DOMAIN}...`);
    console.log(`   Scan ID: ${SCAN_ID}`);
    console.log(`   Client ID: ${CLIENT_ID}`);

    const response = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/scan.yml/dispatches`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ref: 'main',
                inputs: {
                    domain: DOMAIN,
                    client_id: CLIENT_ID,
                    scan_id: SCAN_ID,
                    max_pages: '5',
                },
            }),
        }
    );

    if (response.status === 204) {
        console.log('✅ GitHub Action erfolgreich getriggert (204)');
        console.log('   Prüfe: https://github.com/GoGoeeen/greenonion-a11y/actions');
    } else {
        const body = await response.text();
        console.error(`❌ Trigger fehlgeschlagen (${response.status}): ${body}`);

        if (response.status === 401) {
            console.error('   → GITHUB_TOKEN ist ungültig oder abgelaufen!');
        } else if (response.status === 404) {
            console.error('   → Workflow-Datei nicht gefunden oder Branch "main" existiert nicht');
        } else if (response.status === 422) {
            console.error('   → Ungültige Inputs oder Workflow nicht auf "main" Branch');
        }
    }
}

triggerScan().catch(console.error);
