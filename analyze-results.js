import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('scan_hauptlizenz-raith.online-investieren.at_1771274003911.json', 'utf-8'));

console.log('========================================');
console.log('  SCANNER v2.0 — ERGEBNISSE');
console.log('========================================');
console.log('Seiten gescannt:', data.pagesScanned);
console.log('Violations:', data.totalIssues);
console.log('Needs Review:', data.totalNeedsReview);
console.log('Score:', data.score + '/100');
console.log();

console.log('=== ENGINE BREAKDOWN ===');
console.log('axe-core:  ', data.engineBreakdown.axe, 'Regeln');
console.log('HTMLCS:    ', data.engineBreakdown.htmlcs, 'unique Funde');
console.log('Custom:    ', data.engineBreakdown.custom, 'Checks');
console.log();

// All rules across all engines
const ruleMap = {};
for (const p of data.pages) {
  for (const iss of p.issues) {
    const key = iss.engine + '::' + iss.rule;
    if (!ruleMap[key]) {
      ruleMap[key] = {
        engine: iss.engine,
        rule: iss.rule,
        severity: iss.severity,
        wcag: iss.wcag || '',
        nodes: 0,
        pages: 0,
        desc: (iss.description || '').substring(0, 100),
      };
    }
    ruleMap[key].nodes += iss.nodes?.length || 1;
    ruleMap[key].pages++;
  }
}

console.log('=== TOP VIOLATIONS BY NODE COUNT ===');
Object.values(ruleMap)
  .sort((a, b) => b.nodes - a.nodes)
  .slice(0, 25)
  .forEach((r, i) => {
    console.log(`${i + 1}. [${r.engine}] ${r.rule} (${r.severity}) — ${r.nodes} nodes on ${r.pages} pages`);
    if (r.wcag) console.log(`   WCAG: ${r.wcag}`);
  });
console.log();

console.log('=== CUSTOM CHECKS SUMMARY ===');
Object.values(ruleMap)
  .filter((r) => r.engine === 'custom')
  .sort((a, b) => b.nodes - a.nodes)
  .forEach((r) => {
    console.log(`  ${r.rule} (WCAG ${r.wcag}, ${r.severity}): ${r.nodes} nodes on ${r.pages} pages`);
    console.log(`    ${r.desc}`);
  });
console.log();

console.log('=== NEEDS REVIEW (INCOMPLETE) ===');
const incMap = {};
for (const p of data.pages) {
  for (const iss of p.incomplete || []) {
    if (!incMap[iss.rule]) {
      incMap[iss.rule] = { rule: iss.rule, severity: iss.severity, nodes: 0, pages: 0 };
    }
    incMap[iss.rule].nodes += iss.nodes?.length || 1;
    incMap[iss.rule].pages++;
  }
}
Object.values(incMap)
  .sort((a, b) => b.nodes - a.nodes)
  .forEach((r) => {
    console.log(`  ${r.rule} (${r.severity}): ${r.nodes} nodes on ${r.pages} pages`);
  });
console.log();

console.log('=== WORST PAGES ===');
[...data.pages]
  .sort((a, b) => b.issueCount - a.issueCount)
  .slice(0, 10)
  .forEach((p, i) => {
    console.log(`${i + 1}. ${p.url}`);
    console.log(`   ${p.issueCount} violations, ${p.incompleteCount} review (axe:${p.engineStats.axe} htmlcs:${p.engineStats.htmlcs} custom:${p.engineStats.custom})`);
  });

// Comparison v1 vs v2
console.log();
console.log('=== V1 vs V2 VERGLEICH ===');
const v1AxeOnly = data.pages.reduce((sum, p) => sum + p.issues.filter(i => i.engine === 'axe-core').reduce((s, i) => s + (i.nodes?.length || 1), 0), 0);
const v2Total = data.totalIssues;
console.log(`axe-core allein: ${v1AxeOnly} violations`);
console.log(`v2.0 gesamt:     ${v2Total} violations`);
console.log(`Steigerung:      +${v2Total - v1AxeOnly} (+${Math.round((v2Total - v1AxeOnly) / v1AxeOnly * 100)}%)`);
