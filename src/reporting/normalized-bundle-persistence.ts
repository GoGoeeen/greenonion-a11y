import type { NormalizedScanBundle } from './types.js';

export interface RawResultForBundleGuard {
  pagesScanned?: number;
  pages?: unknown[];
}

export interface BundleRequirementOptions {
  isLocal: boolean;
  scanType: 'quick' | 'full';
  rawResult: RawResultForBundleGuard | null | undefined;
}

export interface BundleVerificationResult {
  ok: boolean;
  reason?: string;
}

export function isBundleRequiredForScan(options: BundleRequirementOptions): boolean {
  if (options.isLocal || options.scanType !== 'full') {
    return false;
  }

  const rawResult = options.rawResult;
  if (!rawResult || typeof rawResult !== 'object') {
    return false;
  }

  const pages = Array.isArray(rawResult.pages) ? rawResult.pages : [];
  const pagesScanned = rawResult.pagesScanned;
  return Number.isInteger(pagesScanned) && pagesScanned > 0 && pages.length === pagesScanned;
}

export function assertBundleReadyForPersistence(
  normalizedBundle: NormalizedScanBundle | null,
  options: BundleRequirementOptions & { scanId?: string },
): void {
  if (!isBundleRequiredForScan(options)) {
    return;
  }

  if (!normalizedBundle) {
    const scanLabel = options.scanId ? ` fuer Scan ${options.scanId}` : '';
    throw new Error(
      `Normalized bundle fehlt${scanLabel}, obwohl ein vollstaendiger Full-Scan fuer Supabase vorliegt. ` +
      'Der Scan wird nicht als completed gespeichert.',
    );
  }
}

export function verifyPersistedNormalizedBundle(
  expectedBundle: NormalizedScanBundle | null | undefined,
  persistedBundle: unknown,
): BundleVerificationResult {
  if (!expectedBundle) {
    return { ok: true };
  }

  if (!persistedBundle || typeof persistedBundle !== 'object') {
    return { ok: false, reason: 'normalized_bundle missing after save' };
  }

  const persisted = persistedBundle as Partial<NormalizedScanBundle>;
  const expectedFindingInstances = expectedBundle.finding_instances.length;
  const expectedAutomationCandidates = expectedBundle.automation_candidates.length;
  const persistedFindingInstances = Array.isArray(persisted.finding_instances) ? persisted.finding_instances.length : null;
  const persistedAutomationCandidates = Array.isArray(persisted.automation_candidates) ? persisted.automation_candidates.length : null;

  if (persistedFindingInstances !== expectedFindingInstances) {
    return {
      ok: false,
      reason:
        `normalized_bundle finding_instances mismatch ` +
        `(expected ${expectedFindingInstances}, got ${String(persistedFindingInstances)})`,
    };
  }

  if (persistedAutomationCandidates !== expectedAutomationCandidates) {
    return {
      ok: false,
      reason:
        `normalized_bundle automation_candidates mismatch ` +
        `(expected ${expectedAutomationCandidates}, got ${String(persistedAutomationCandidates)})`,
    };
  }

  const expectedScanId = expectedBundle.meta.scan_id;
  const persistedScanId = persisted.meta?.scan_id;
  if (expectedScanId && persistedScanId !== expectedScanId) {
    return {
      ok: false,
      reason: `normalized_bundle meta.scan_id mismatch (expected ${expectedScanId}, got ${String(persistedScanId)})`,
    };
  }

  const expectedJsonLength = JSON.stringify(expectedBundle).length;
  const persistedJsonLength = JSON.stringify(persistedBundle).length;
  if (persistedJsonLength < expectedJsonLength) {
    return {
      ok: false,
      reason: `normalized_bundle truncated (expected len>=${expectedJsonLength}, got ${persistedJsonLength})`,
    };
  }

  return { ok: true };
}
