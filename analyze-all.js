import { readFileSync } from 'fs';

const pub = JSON.parse(readFileSync('scan_hauptlizenz-raith.online-investieren.at_1771274003911.json', 'utf-8'));
const verm = JSON.parse(readFileSync('scan_hauptlizenz-raith.online-investieren.at_1771274247142.json', 'utf-8'));
const inv = JSON.parse(readFileSync('scan_hauptlizenz-raith.online-investieren.at_1771274283673.json', 'utf-8'));

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  SCANNER v2.0 — GESAMTERGEBNIS ALLE 3 SCANS        ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log();

const scans = [
  { name: 'Oeffentlich (24 Seiten)', data: pub },
  { name: 'Vermittler (4 Seiten)', data: verm },
  { name: 'Investor (4 Seiten)', data: inv },
];

let grandTotal = 0;
let grandReview = 0;
let grandPages = 0;

for (const s of scans) {
  console.log(`--- ${s.name} ---`);
  console.log(`  Violations: ${s.data.totalIssues}`);
  console.log(`  Needs Review: ${s.data.totalNeedsReview}`);
  console.log(`  Engines: axe:${s.data.engineBreakdown.axe} htmlcs:${s.data.engineBreakdown.htmlcs} custom:${s.data.engineBreakdown.custom}`);
  grandTotal += s.data.totalIssues;
  grandReview += s.data.totalNeedsReview;
  grandPages += s.data.pagesScanned;
}

console.log();
console.log('=== GESAMT ===');
console.log(`Seiten: ${grandPages}`);
console.log(`Violations: ${grandTotal}`);
console.log(`Needs Review: ${grandReview}`);
console.log();

// Combined rule breakdown
const ruleMap = {};
for (const s of scans) {
  for (const p of s.data.pages) {
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
}

console.log('=== TOP 30 VIOLATIONS (alle Scans) ===');
Object.values(ruleMap)
  .sort((a, b) => b.nodes - a.nodes)
  .slice(0, 30)
  .forEach((r, i) => {
    const wcagStr = r.wcag ? ` [WCAG ${r.wcag}]` : '';
    console.log(`${String(i + 1).padStart(2)}. [${r.engine.padEnd(8)}] ${r.rule.padEnd(35)} ${r.severity.padEnd(10)} ${String(r.nodes).padStart(5)} nodes  ${r.pages} pages${wcagStr}`);
  });

console.log();
console.log('=== CUSTOM CHECKS DETAIL ===');
Object.values(ruleMap)
  .filter((r) => r.engine === 'custom')
  .sort((a, b) => b.nodes - a.nodes)
  .forEach((r) => {
    console.log(`  ${r.rule} (WCAG ${r.wcag}, ${r.severity})`);
    console.log(`    ${r.nodes} nodes on ${r.pages} pages`);
    console.log(`    ${r.desc}`);
    console.log();
  });

console.log('=== NEEDS REVIEW DETAIL ===');
const incMap = {};
for (const s of scans) {
  for (const p of s.data.pages) {
    for (const iss of p.incomplete || []) {
      if (!incMap[iss.rule]) {
        incMap[iss.rule] = { rule: iss.rule, severity: iss.severity, nodes: 0, pages: 0 };
      }
      incMap[iss.rule].nodes += iss.nodes?.length || 1;
      incMap[iss.rule].pages++;
    }
  }
}
Object.values(incMap)
  .sort((a, b) => b.nodes - a.nodes)
  .forEach((r) => {
    console.log(`  ${r.rule} (${r.severity}): ${r.nodes} nodes on ${r.pages} pages`);
  });

console.log();
console.log('=== WORST 15 PAGES (alle Scans) ===');
const allPages = [];
for (const s of scans) {
  for (const p of s.data.pages) {
    allPages.push({ ...p, scan: s.name });
  }
}
allPages
  .sort((a, b) => b.issueCount - a.issueCount)
  .slice(0, 15)
  .forEach((p, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${p.scan}] ${p.url}`);
    console.log(`    ${p.issueCount} violations, ${p.incompleteCount} review`);
  });

// v1 vs v2 comparison
console.log();
console.log('=== V1.0 vs V2.0 VERGLEICH ===');
let totalAxeOnly = 0;
for (const s of scans) {
  for (const p of s.data.pages) {
    totalAxeOnly += p.issues.filter(i => i.engine === 'axe-core').reduce((sum, i) => sum + (i.nodes?.length || 1), 0);
  }
}
console.log(`Scanner v1.0 (axe-core only):  ${totalAxeOnly} violations`);
console.log(`Scanner v2.0 (3 engines):      ${grandTotal} violations`);
console.log(`Mehrerkennung:                 +${grandTotal - totalAxeOnly} (+${Math.round((grandTotal - totalAxeOnly) / totalAxeOnly * 100)}%)`);
console.log(`Needs Review (neu):            +${grandReview}`);
console.log(`Gesamt erkannte Probleme:      ${grandTotal + grandReview}`);
