import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';

// --- Score Color ---
function scoreColor(score) {
  if (score < 50) return '#dc2626';  // red
  if (score <= 80) return '#f59e0b'; // yellow
  return '#16a34a';                   // green
}

function scoreLabel(score) {
  if (score < 50) return 'Kritisch';
  if (score <= 80) return 'Verbesserungsbedürftig';
  return 'Gut';
}

// --- Top violations extraction ---
function getTopViolations(scanResult, limit = 5) {
  const violationMap = new Map();

  for (const page of scanResult.pages) {
    for (const issue of page.issues) {
      if (issue.rule === '_error') continue;
      const key = issue.rule;
      if (!violationMap.has(key)) {
        violationMap.set(key, {
          rule: issue.rule,
          severity: issue.severity,
          description: issue.description,
          help: issue.help,
          helpUrl: issue.helpUrl,
          wcagTags: issue.wcagTags || [],
          affectedPages: 0,
          totalNodes: 0,
          examples: [],
        });
      }
      const v = violationMap.get(key);
      v.affectedPages++;
      v.totalNodes += issue.nodes?.length || 0;
      if (v.examples.length < 2 && issue.nodes?.[0]) {
        v.examples.push({
          page: page.url,
          selector: issue.nodes[0].selector,
          html: issue.nodes[0].html?.substring(0, 200),
        });
      }
    }
  }

  const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return [...violationMap.values()]
    .sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4) || b.totalNodes - a.totalNodes)
    .slice(0, limit);
}

// --- Severity Badge ---
function severityBadge(severity) {
  const colors = {
    critical: '#dc2626',
    serious: '#ea580c',
    moderate: '#f59e0b',
    minor: '#6b7280',
  };
  const labels = {
    critical: 'Kritisch',
    serious: 'Schwerwiegend',
    moderate: 'Mittel',
    minor: 'Gering',
  };
  return `<span style="background:${colors[severity] || '#6b7280'};color:white;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">${labels[severity] || severity}</span>`;
}

// --- HTML Template ---
function generateHTML(scanResult, customerName) {
  const score = scanResult.score;
  const topViolations = getTopViolations(scanResult);
  const scanDate = new Date(scanResult.scannedAt).toLocaleDateString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const violationsHTML = topViolations.map((v, i) => `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>${i + 1}. ${v.help || v.rule}</strong>
        ${severityBadge(v.severity)}
      </div>
      <p style="color:#4b5563;margin:4px 0">${v.description}</p>
      <div style="font-size:13px;color:#6b7280">
        ${v.affectedPages} Seite(n) betroffen &middot; ${v.totalNodes} Element(e)
        ${v.wcagTags.length ? ` &middot; ${v.wcagTags.join(', ')}` : ''}
      </div>
      ${v.examples.length ? `
        <div style="margin-top:8px;padding:8px;background:#f9fafb;border-radius:4px;font-size:12px;font-family:monospace;overflow:hidden">
          <div style="color:#6b7280">Beispiel: ${v.examples[0].page}</div>
          <div style="color:#374151;margin-top:4px">${escapeHtml(v.examples[0].html || v.examples[0].selector)}</div>
        </div>
      ` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1f2937; line-height: 1.6; }
    .page { padding: 48px; max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; padding-bottom: 20px; border-bottom: 3px solid #16a34a; }
    .logo { font-size: 24px; font-weight: 800; color: #16a34a; }
    .logo span { color: #1f2937; }
    .meta { text-align: right; font-size: 13px; color: #6b7280; }
    .score-box { text-align: center; padding: 32px; margin-bottom: 32px; border-radius: 12px; background: #f9fafb; }
    .score-number { font-size: 72px; font-weight: 800; }
    .score-label { font-size: 18px; margin-top: 4px; }
    h2 { font-size: 20px; margin: 32px 0 16px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; }
    .legal-box { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .legal-box h3 { color: #92400e; margin-bottom: 8px; }
    .steps-box { background: #f0fdf4; border: 1px solid #16a34a; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .steps-box h3 { color: #166534; margin-bottom: 8px; }
    .steps-box ol { padding-left: 20px; }
    .steps-box li { margin-bottom: 6px; }
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; text-align: center; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .summary-card { background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center; }
    .summary-card .num { font-size: 28px; font-weight: 700; }
    .summary-card .label { font-size: 13px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="logo">Green<span>Onion</span></div>
      <div class="meta">
        <strong>Barrierefreiheits-Prüfbericht</strong><br>
        ${customerName}<br>
        ${scanDate}
      </div>
    </div>

    <div class="score-box">
      <div class="score-number" style="color:${scoreColor(score)}">${score}</div>
      <div class="score-label" style="color:${scoreColor(score)}">${scoreLabel(score)}</div>
      <div style="font-size:14px;color:#6b7280;margin-top:8px">WCAG 2.1 AA Compliance Score (0–100)</div>
    </div>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="num">${scanResult.pagesScanned}</div>
        <div class="label">Seiten geprüft</div>
      </div>
      <div class="summary-card">
        <div class="num">${scanResult.totalIssues}</div>
        <div class="label">Barrieren gefunden</div>
      </div>
      <div class="summary-card">
        <div class="num">${topViolations.filter(v => v.severity === 'critical' || v.severity === 'serious').length}</div>
        <div class="label">Kritische Regeln</div>
      </div>
    </div>

    <h2>Top ${topViolations.length} Verstöße</h2>
    ${violationsHTML}

    <div class="legal-box">
      <h3>Was bedeutet das? — Rechtliche Einordnung</h3>
      <p>Das <strong>Barrierefreiheitsstärkungsgesetz (BFSG)</strong>, die deutsche Umsetzung des European Accessibility Act (EAA), trat am <strong>28. Juni 2025</strong> in Kraft.</p>
      <p style="margin-top:8px">Unternehmen, die digitale Produkte und Dienstleistungen anbieten, müssen die Anforderungen der <strong>WCAG 2.1 Level AA</strong> erfüllen. Bei Verstößen drohen:</p>
      <ul style="margin-top:8px;padding-left:20px">
        <li>Bußgelder bis zu <strong>100.000 €</strong></li>
        <li>Vertriebsverbote für nicht-konforme Produkte</li>
        <li>Abmahnrisiko durch Verbraucherschutzverbände</li>
      </ul>
      <p style="margin-top:8px">In <strong>Österreich</strong> gilt das <strong>Barrierefreiheitsgesetz (BaFG)</strong> seit Juni 2025 mit Strafrahmen bis <strong>80.000 €</strong>.</p>
    </div>

    <div class="steps-box">
      <h3>Empfohlene nächste Schritte</h3>
      <ol>
        <li><strong>Kritische Verstöße sofort beheben</strong> — Fehlende Alt-Texte, Kontrast-Probleme, fehlende Formular-Labels</li>
        <li><strong>Schwerwiegende Verstöße priorisiert angehen</strong> — Heading-Hierarchie, ARIA-Attribute, Tastaturnavigation</li>
        <li><strong>Automatisierte Remediation</strong> — GreenOnion kann ca. 60–70% der Verstöße automatisch beheben</li>
        <li><strong>Manueller NVDA-Test</strong> — Screenreader-Prüfung für die verbleibenden 30–40%</li>
        <li><strong>Barrierefreiheitserklärung</strong> veröffentlichen (gesetzlich vorgeschrieben)</li>
        <li><strong>Regelmäßiges Monitoring</strong> einrichten — Neue Inhalte können neue Barrieren erzeugen</li>
      </ol>
    </div>

    <div class="footer">
      GreenOnion FlexCo &middot; Barrierefreiheits-Prüfbericht &middot; Erstellt am ${scanDate}<br>
      Dieser Bericht wurde automatisch generiert auf Basis eines axe-core WCAG 2.1 AA Scans.
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- PDF Generation ---
export async function generateReport({ scanResult, customerName, outputPath }) {
  const html = generateHTML(scanResult, customerName);

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  });
  await browser.close();

  console.log(`📄 Report saved to: ${outputPath}`);
  return outputPath;
}

// --- CLI ---
const __isCLI = process.argv[1] &&
  (process.argv[1].endsWith('report.js') || process.argv[1].endsWith('report'));
if (__isCLI) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node report.js <scan-result.json> [customer-name] [output.pdf]');
    console.log('Example: node report.js scan_example.com_1234.json "Musterfirma GmbH" report.pdf');
    process.exit(1);
  }

  const scanFile = args[0];
  const customerName = args[1] || 'Kunde';
  const outputPath = args[2] || scanFile.replace('.json', '_report.pdf');

  const scanResult = JSON.parse(readFileSync(scanFile, 'utf-8'));
  await generateReport({ scanResult, customerName, outputPath });
}
