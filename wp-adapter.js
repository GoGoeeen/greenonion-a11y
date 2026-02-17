import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

// --- WordPress REST API Client ---
class WPClient {
  constructor({ wpUrl, username, appPassword }) {
    this.baseUrl = wpUrl.replace(/\/$/, '');
    this.apiBase = `${this.baseUrl}/wp-json/wp/v2`;
    this.auth = 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
  }

  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.apiBase}${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': this.auth,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WP API ${res.status}: ${body.substring(0, 300)}`);
    }
    return res.json();
  }

  // Fetch all items with pagination
  async fetchAll(endpoint, params = {}) {
    const items = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const query = new URLSearchParams({ ...params, per_page: perPage, page }).toString();
      try {
        const batch = await this.request(`${endpoint}?${query}`);
        items.push(...batch);
        if (batch.length < perPage) break;
        page++;
      } catch {
        break;
      }
    }
    return items;
  }

  async getPages() {
    return this.fetchAll('/pages', { status: 'publish' });
  }

  async getPosts() {
    return this.fetchAll('/posts', { status: 'publish' });
  }

  async getMedia() {
    return this.fetchAll('/media');
  }

  async updatePage(id, data) {
    return this.request(`/pages/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async updatePost(id, data) {
    return this.request(`/posts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async updateMedia(id, data) {
    return this.request(`/media/${id}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createPage(data) {
    return this.request('/pages', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Inject CSS via Customizer (requires customize_changeset capability)
  async getCustomCSS() {
    try {
      const settings = await this.request(
        `${this.baseUrl}/wp-json/wp/v2/settings`
      );
      return settings;
    } catch {
      return null;
    }
  }
}

// --- Claude Code WCAG Fix Pipeline ---
async function fixContentWithClaude(htmlContent, issues) {
  const issuesJson = JSON.stringify(issues.map(i => ({
    rule: i.rule,
    severity: i.severity,
    description: i.description,
    help: i.help,
    nodes: i.nodes?.map(n => ({ selector: n.selector, html: n.html?.substring(0, 300) })),
  })));

  const prompt = `Fix these WCAG 2.1 AA issues in this WordPress content:

Issues: ${issuesJson}

Content: ${htmlContent}

Rules:
- Fix contrast by adjusting inline styles or adding CSS classes
- Add alt attributes to images (generate meaningful descriptions based on context)
- Add aria-labels to interactive elements
- Fix heading hierarchy (h1→h2→h3, no skips)
- Add for/id pairing to form labels
- Preserve all Gutenberg block comments (<!-- wp:xxx -->)
- Do NOT change layout structure or remove any content
- Return ONLY the fixed HTML, no explanations`;

  try {
    const result = execSync(
      `claude --print -p ${JSON.stringify(prompt)}`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
    );
    // Strip markdown code fences if Claude wraps the response
    return result.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
  } catch (err) {
    console.error(`  Claude fix failed: ${err.message}`);
    return null;
  }
}

// --- Match scan issues to WP content ---
function matchIssuesToContent(scanPages, wpContent) {
  const matches = [];

  for (const wp of wpContent) {
    const wpUrl = wp.link;
    const scanPage = scanPages.find(sp => {
      const spNorm = sp.url.replace(/\/$/, '');
      const wpNorm = wpUrl.replace(/\/$/, '');
      return spNorm === wpNorm;
    });

    if (scanPage && scanPage.issues.length > 0) {
      matches.push({
        wpId: wp.id,
        wpType: wp.type || 'page',
        wpUrl: wp.link,
        wpTitle: wp.title?.rendered || 'Untitled',
        content: wp.content?.rendered || '',
        issues: scanPage.issues.filter(i => i.rule !== '_error'),
      });
    }
  }

  return matches;
}

// --- Alt-Text fixer for media ---
async function fixMediaAltTexts(client, scanResult) {
  const media = await client.getMedia();
  const fixed = [];

  for (const item of media) {
    if (item.alt_text && item.alt_text.trim() !== '') continue;
    // Only fix images
    if (!item.mime_type?.startsWith('image/')) continue;

    const filename = item.source_url?.split('/').pop() || 'image';
    const caption = item.caption?.rendered?.replace(/<[^>]*>/g, '') || '';
    const title = item.title?.rendered || '';

    // Generate alt text from available context
    const altText = caption || title || `Bild: ${filename.replace(/[-_]/g, ' ').replace(/\.\w+$/, '')}`;

    try {
      await client.updateMedia(item.id, { alt_text: altText });
      fixed.push({ id: item.id, filename, altText });
      console.log(`  Fixed alt-text for media #${item.id}: "${altText}"`);
    } catch (err) {
      console.error(`  Failed to fix media #${item.id}: ${err.message}`);
    }
  }
  return fixed;
}

// --- Main Remediation Flow ---
export async function remediate({ wpUrl, username, appPassword, scanResultFile, dryRun = false }) {
  console.log(`\n🔧 WordPress Remediation: ${wpUrl}`);
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const client = new WPClient({ wpUrl, username, appPassword });
  const scanResult = JSON.parse(readFileSync(scanResultFile, 'utf-8'));

  // Step 1: Fetch all WP content
  console.log('📥 Fetching WordPress content...');
  const [pages, posts] = await Promise.all([
    client.getPages(),
    client.getPosts(),
  ]);
  console.log(`  ${pages.length} pages, ${posts.length} posts`);

  // Step 2: Match scan issues to WP content
  const allContent = [...pages, ...posts];
  const matches = matchIssuesToContent(scanResult.pages, allContent);
  console.log(`  ${matches.length} pages with fixable issues\n`);

  // Step 3: Fix each matched page
  const results = [];
  for (const match of matches) {
    console.log(`🔧 Fixing: ${match.wpTitle} (${match.issues.length} issues)`);

    const fixedContent = await fixContentWithClaude(match.content, match.issues);
    if (!fixedContent) {
      results.push({ ...match, status: 'claude_error' });
      continue;
    }

    if (fixedContent === match.content) {
      console.log('  No changes needed');
      results.push({ ...match, status: 'no_changes' });
      continue;
    }

    if (dryRun) {
      console.log('  [DRY RUN] Would update content');
      results.push({ ...match, status: 'dry_run', fixedContent });
    } else {
      try {
        const updateFn = match.wpType === 'post' ? 'updatePost' : 'updatePage';
        await client[updateFn](match.wpId, { content: fixedContent });
        console.log('  ✅ Content updated');
        results.push({ ...match, status: 'fixed', fixedContent });
      } catch (err) {
        console.error(`  ❌ Update failed: ${err.message}`);
        results.push({ ...match, status: 'update_error', error: err.message });
      }
    }
  }

  // Step 4: Fix media alt texts
  console.log('\n🖼️  Fixing media alt-texts...');
  const mediaFixes = dryRun ? [] : await fixMediaAltTexts(client, scanResult);

  // Step 5: Summary
  const summary = {
    wpUrl,
    scanFile: scanResultFile,
    remediatedAt: new Date().toISOString(),
    dryRun,
    contentFixes: results.map(r => ({
      wpId: r.wpId,
      title: r.wpTitle,
      url: r.wpUrl,
      issueCount: r.issues.length,
      status: r.status,
    })),
    mediaFixes,
    stats: {
      totalMatched: matches.length,
      fixed: results.filter(r => r.status === 'fixed').length,
      errors: results.filter(r => r.status.includes('error')).length,
      noChanges: results.filter(r => r.status === 'no_changes').length,
      mediaFixed: mediaFixes.length,
    },
  };

  console.log('\n📊 Summary:');
  console.log(`  Fixed: ${summary.stats.fixed}/${summary.stats.totalMatched} pages`);
  console.log(`  Errors: ${summary.stats.errors}`);
  console.log(`  Media alt-texts fixed: ${summary.stats.mediaFixed}`);

  return summary;
}

// --- Accessibility Statement Generator ---
export async function createAccessibilityStatement({ wpUrl, username, appPassword, scanResult, customerName }) {
  const client = new WPClient({ wpUrl, username, appPassword });
  const date = new Date().toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const content = `<!-- wp:paragraph -->
<p>Die ${customerName} ist bemüht, ihren Webauftritt im Einklang mit dem Barrierefreiheitsstärkungsgesetz (BFSG) bzw. dem Barrierefreiheitsgesetz (BaFG) barrierefrei zugänglich zu machen.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Stand der Konformität</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Dieser Webauftritt ist teilweise konform mit der WCAG 2.1 Level AA. Der aktuelle Compliance-Score beträgt <strong>${scanResult.score}/100</strong> (Stand: ${date}).</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Nicht barrierefreie Inhalte</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Die nachfolgend aufgeführten Inhalte sind aus folgenden Gründen noch nicht barrierefrei:</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul>
<li>Einzelne Bilder verfügen noch nicht über ausreichende Alternativtexte</li>
<li>Kontrastverhältnisse entsprechen teilweise noch nicht den Mindestanforderungen</li>
<li>Die Überschriftenhierarchie ist auf einzelnen Seiten noch nicht durchgehend korrekt</li>
</ul>
<!-- /wp:list -->

<!-- wp:heading {"level":2} -->
<h2>Erstellung dieser Erklärung</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Diese Erklärung wurde am ${date} erstellt. Grundlage der Bewertung ist eine automatisierte Prüfung mittels axe-core (WCAG 2.1 AA Regelset) sowie eine manuelle Überprüfung mit dem Screenreader NVDA.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2>Feedback und Kontakt</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Wenn Sie Barrieren auf unserer Website feststellen, kontaktieren Sie uns bitte. Wir werden versuchen, die Mängel zu beheben und Ihnen die gewünschten Informationen in barrierefreier Form zur Verfügung zu stellen.</p>
<!-- /wp:paragraph -->`;

  const page = await client.createPage({
    title: 'Barrierefreiheitserklärung',
    content,
    status: 'draft', // Start as draft for review
  });

  console.log(`📝 Accessibility statement created as draft: ${page.link}`);
  return page;
}

// --- CLI ---
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node wp-adapter.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  fix       --wp-url <url> --user <user> --pass <appPassword> --scan <scan.json> [--dry-run]');
  console.log('  statement --wp-url <url> --user <user> --pass <appPassword> --scan <scan.json> --customer <name>');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const command = args[0];
const wpUrl = getArg('--wp-url');
const username = getArg('--user');
const appPassword = getArg('--pass');
const scanFile = getArg('--scan');
const dryRun = args.includes('--dry-run');
const customerName = getArg('--customer');

if (!wpUrl || !username || !appPassword) {
  console.error('Error: --wp-url, --user, and --pass are required');
  process.exit(1);
}

if (command === 'fix') {
  if (!scanFile) { console.error('Error: --scan is required'); process.exit(1); }
  const result = await remediate({ wpUrl, username, appPassword, scanResultFile: scanFile, dryRun });
  const outFile = `remediation_${Date.now()}.json`;
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`\n📁 Results saved to: ${outFile}`);
} else if (command === 'statement') {
  if (!scanFile || !customerName) {
    console.error('Error: --scan and --customer are required');
    process.exit(1);
  }
  const scanResult = JSON.parse(readFileSync(scanFile, 'utf-8'));
  await createAccessibilityStatement({ wpUrl, username, appPassword, scanResult, customerName });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
