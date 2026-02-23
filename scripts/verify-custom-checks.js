import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scan } from '../scanner.js';

const FIXTURE_PATH = join(process.cwd(), 'tests', 'fixtures', 'custom-checks.html');
const EXPECTED_RULES = [
  'suspicious-alt-text',
  'orphaned-label',
  'justified-text',
  'redundant-link',
];

function startFixtureServer() {
  const fixtureHtml = readFileSync(FIXTURE_PATH, 'utf-8');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:4173/</loc></url>
</urlset>`;

  const server = createServer((req, res) => {
    if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
      return;
    }

    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(sitemap);
      return;
    }

    if (req.url === '/assets/hero.jpg' || req.url === '/ziel') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(4173, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startFixtureServer();
  try {
    const result = await scan({ url: 'http://127.0.0.1:4173', maxPages: 1 });
    const rules = new Set(result.pages.flatMap(p => p.issues.map(i => i.rule)));

    const missing = EXPECTED_RULES.filter(rule => !rules.has(rule));
    if (missing.length > 0) {
      console.error(`Missing expected rules: ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log('Custom check verification passed.');
    console.log(`Detected rules: ${EXPECTED_RULES.join(', ')}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error(`Verification failed: ${err.message}`);
  process.exit(1);
});
