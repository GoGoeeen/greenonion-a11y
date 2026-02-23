import { createServer } from 'http';
import { scan } from '../scanner.js';

const PORT = 4174;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const EXPECTED_RULES = [
  'focus-visible',
  'heading-hierarchy',
  'html-lang',
  'reduced-motion',
  'text-spacing-override',
  'page-title-unique',
  'suspicious-alt-text',
  'orphaned-label',
  'justified-text',
  'redundant-link',
  'keyboard-trap',
  'reflow-320px',
];

function pageHtml(pageId) {
  return `<!doctype html>
<html lang="deutsch">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Scanner Fixture Title</title>
    <style>
      body { font-family: sans-serif; margin: 16px; }
      .no-focus,
      .no-focus:focus {
        outline: none !important;
        box-shadow: none !important;
        border: 1px solid #444;
        background: #eee;
        color: #111;
        text-decoration: none;
      }
      .justified { text-align: justify; max-width: 520px; }
      .clip {
        overflow: hidden;
        height: 22px;
        width: 280px;
        border: 1px solid #ccc;
      }
      .too-wide {
        width: 760px;
        border: 1px solid #999;
        white-space: nowrap;
      }
      .spin {
        display: inline-block;
        animation: spin 1.2s linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <h1>Fixture ${pageId}</h1>
    <h3>Heading jump</h3>

    <button class="no-focus" tabindex="5">No focus ring</button>
    <input tabindex="6" value="Tab Order Test" />
    <a href="/tab-test" tabindex="7">Tab Test Link</a>

    <p class="justified">
      Dieser Absatz ist absichtlich lang genug und verwendet Blocksatz, damit der
      Check fuer justified text verlässlich ausgeloest wird.
    </p>

    <div class="clip">
      Dieser Text ist absichtlich laenger als der Container und wird mit overflow
      hidden abgeschnitten, sobald Text Spacing aktiv ist.
    </div>

    <div class="too-wide">XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX</div>

    <div class="spin">Loading</div>

    <img src="/assets/hero.jpg" alt="hero.jpg" width="120" height="80" />

    <label for="missing-field-id">E-Mail</label>
    <input id="existing-field-id" type="email" />

    <a href="/ziel">Mehr erfahren</a><a href="/ziel">Mehr erfahren</a>

    <p>Privacy Policy</p>
  </body>
</html>`;
}

function startServer() {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/page-a</loc></url>
  <url><loc>${BASE_URL}/page-b</loc></url>
</urlset>`;

  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    if (req.url === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(sitemap);
      return;
    }

    if (req.url === '/page-a') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml('A'));
      return;
    }

    if (req.url === '/page-b') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml('B'));
      return;
    }

    if (req.url === '/assets/hero.jpg' || req.url === '/ziel' || req.url === '/tab-test') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(302, { Location: '/page-a' });
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  try {
    const result = await scan({ url: BASE_URL, maxPages: 2 });
    const foundRules = new Set(result.pages.flatMap(p => p.issues.map(i => i.rule)));

    const missing = EXPECTED_RULES.filter(rule => !foundRules.has(rule));
    if (missing.length > 0) {
      console.error(`Missing expected custom rules: ${missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log('All custom checks verification passed.');
    console.log(`Detected custom rules: ${EXPECTED_RULES.join(', ')}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error(`Verification failed: ${err.message}`);
  process.exit(1);
});
