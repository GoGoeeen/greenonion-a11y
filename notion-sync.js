/**
 * Notion Integration for A11y Findings
 *
 * Syncs scan issues to Notion "A11y Findings" database
 * and updates status after remediation.
 *
 * Usage:
 *   node notion-sync.js push <scan-result.json> <notion-db-id>
 *   node notion-sync.js update-fixed <remediation-result.json> <notion-db-id>
 */

const NOTION_VERSION = '2022-06-28';

class NotionClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://api.notion.com/v1';
  }

  async request(path, options = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion API ${res.status}: ${body.substring(0, 300)}`);
    }
    return res.json();
  }

  // Push issues to Findings DB
  async pushIssues(databaseId, issues, customerName) {
    let created = 0;
    for (const issue of issues) {
      try {
        await this.request('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties: {
              // Adapt property names to your actual Notion DB schema
              'Name': { title: [{ text: { content: `${issue.rule} — ${issue.pageUrl}` } }] },
              'Regel': { rich_text: [{ text: { content: issue.rule } }] },
              'Severity': { select: { name: issue.severity } },
              'Seite': { url: issue.pageUrl },
              'Selector': { rich_text: [{ text: { content: issue.selector?.substring(0, 200) || '' } }] },
              'Beschreibung': { rich_text: [{ text: { content: issue.description?.substring(0, 2000) || '' } }] },
              'Status': { select: { name: 'Open' } },
              'Kunde': { rich_text: [{ text: { content: customerName } }] },
            },
          }),
        });
        created++;
      } catch (err) {
        console.error(`  Failed to create issue: ${err.message}`);
      }
    }
    return created;
  }

  // Query findings by status
  async queryFindings(databaseId, filters = {}) {
    const filterConditions = [];
    if (filters.status) {
      filterConditions.push({
        property: 'Status',
        select: { equals: filters.status },
      });
    }
    if (filters.customer) {
      filterConditions.push({
        property: 'Kunde',
        rich_text: { equals: filters.customer },
      });
    }

    const body = {
      filter: filterConditions.length > 1
        ? { and: filterConditions }
        : filterConditions[0] || undefined,
    };

    return this.request(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // Update a finding's status
  async updateFindingStatus(pageId, status) {
    return this.request(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          'Status': { select: { name: status } },
        },
      }),
    });
  }
}

// --- Push scan results to Notion ---
async function pushToNotion(scanFile, databaseId, customerName) {
  const { readFileSync } = await import('fs');
  const token = process.env.NOTION_TOKEN;
  if (!token) { console.error('NOTION_TOKEN not set'); process.exit(1); }

  const client = new NotionClient(token);
  const scanResult = JSON.parse(readFileSync(scanFile, 'utf-8'));

  // Flatten issues with page context
  const allIssues = [];
  for (const page of scanResult.pages) {
    for (const issue of page.issues) {
      if (issue.rule === '_error') continue;
      for (const node of (issue.nodes || [{}])) {
        allIssues.push({
          rule: issue.rule,
          severity: issue.severity,
          description: issue.description,
          pageUrl: page.url,
          selector: node.selector,
        });
      }
    }
  }

  console.log(`📤 Pushing ${allIssues.length} issues to Notion...`);
  const created = await client.pushIssues(databaseId, allIssues, customerName);
  console.log(`✅ Created ${created}/${allIssues.length} findings in Notion`);
}

// --- Mark fixed issues in Notion ---
async function markFixed(remediationFile, databaseId) {
  const { readFileSync } = await import('fs');
  const token = process.env.NOTION_TOKEN;
  if (!token) { console.error('NOTION_TOKEN not set'); process.exit(1); }

  const client = new NotionClient(token);
  const remResult = JSON.parse(readFileSync(remediationFile, 'utf-8'));

  const fixedUrls = new Set(
    remResult.contentFixes
      .filter(f => f.status === 'fixed')
      .map(f => f.url)
  );

  // Query open findings
  const findings = await client.queryFindings(databaseId, { status: 'Open' });

  let updated = 0;
  for (const page of findings.results) {
    const url = page.properties['Seite']?.url;
    if (url && fixedUrls.has(url)) {
      await client.updateFindingStatus(page.id, 'Fixed');
      updated++;
    }
  }
  console.log(`✅ Marked ${updated} findings as Fixed`);
}

// --- CLI ---
const args = process.argv.slice(2);
const command = args[0];

if (command === 'push') {
  const [, scanFile, dbId, customerName] = args;
  if (!scanFile || !dbId) {
    console.log('Usage: node notion-sync.js push <scan.json> <notion-db-id> [customer-name]');
    process.exit(1);
  }
  await pushToNotion(scanFile, dbId, customerName || 'Kunde');
} else if (command === 'update-fixed') {
  const [, remFile, dbId] = args;
  if (!remFile || !dbId) {
    console.log('Usage: node notion-sync.js update-fixed <remediation.json> <notion-db-id>');
    process.exit(1);
  }
  await markFixed(remFile, dbId);
} else {
  console.log('Usage: node notion-sync.js <push|update-fixed> [options]');
  process.exit(1);
}
