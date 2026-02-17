/**
 * Referenz-Code: Scan per GitHub Actions API triggern
 *
 * Zeigt, wie die Admin-App (oder ein anderer Service) einen Accessibility-Scan
 * ueber die GitHub API als workflow_dispatch ausloesen kann.
 *
 * Voraussetzungen:
 * - GitHub Personal Access Token mit `repo` und `actions` Scope
 * - Repository: GoGoeeen/greenonion-a11y
 *
 * NICHT fuer Produktion deployen — nur als Implementierungsreferenz.
 */

interface TriggerScanParams {
  domain: string;
  clientId: string;
  scanId: string;
  maxPages?: number;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REPO_OWNER = 'GoGoeeen';
const REPO_NAME = 'greenonion-a11y';

/**
 * Loest einen Accessibility-Scan per GitHub Actions aus.
 */
async function triggerScan(params: TriggerScanParams): Promise<boolean> {
  const { domain, clientId, scanId, maxPages = 5 } = params;

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
          domain,
          client_id: clientId,
          scan_id: scanId,
          max_pages: String(maxPages),
        },
      }),
    },
  );

  if (response.status === 204) {
    console.log(`Scan getriggert fuer ${domain} (Scan ID: ${scanId})`);
    return true;
  }

  const body = await response.text();
  console.error(`Trigger fehlgeschlagen (${response.status}): ${body}`);
  return false;
}

// --- Beispiel-Aufruf ---
// triggerScan({
//   domain: 'example.com',
//   clientId: '00000000-0000-0000-0000-000000000001',
//   scanId: '00000000-0000-0000-0000-000000000002',
//   maxPages: 5,
// });

export { triggerScan };
