import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const htmlPath = resolve('Gesamtbericht_v2_online-investieren.html');
const html = readFileSync(htmlPath, 'utf-8');
const outFile = 'Gesamtbericht_v2_Barrierefreiheit_online-investieren_2026-02-16.pdf';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.pdf({
  path: outFile,
  format: 'A4',
  printBackground: true,
  margin: { top: '15mm', bottom: '15mm', left: '10mm', right: '10mm' },
});
await browser.close();
console.log('PDF erstellt: ' + outFile);
