/**
 * Exportiert das NormalizedScanBundle als JSON-Datei.
 *
 * Schreibt parallel zum bestehenden Output-Format.
 * Erstellt das Zielverzeichnis automatisch falls noetig.
 */

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { NormalizedScanBundle } from './types.js';

/**
 * Schreibt den normalisierten Bundle als formatiertes JSON.
 *
 * @param bundle - Das normalisierte Scan-Bundle
 * @param outputPath - Vollstaendiger Zielpfad (z.B. 'output/scan_example_com_normalized.json')
 */
export async function exportNormalizedBundle(
  bundle: NormalizedScanBundle,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(bundle, null, 2), 'utf-8');
}
