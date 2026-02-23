import OpenAI from 'openai';
import type { ManualCheckDefinition } from './manual-checks.js';

type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

interface AgentNode {
  url: string;
  selector: string;
  html: string;
  failureSummary: string;
}

interface AgentRemediation {
  recommended_fix: string;
  explanation: string;
}

interface AgentIssue {
  rule: string;
  engine: 'llm-agent';
  severity: Severity;
  wcag: string;
  wcagTags: string[];
  wcag_criteria: string[];
  category: string;
  description: string;
  nodes: AgentNode[];
  remediation?: AgentRemediation;
}

interface CandidateNode {
  source: 'suspicious-alt-text' | 'incomplete';
  pageUrl: string;
  issueRule: string;
  issueDescription: string;
  selector: string;
  html: string;
  failureSummary: string;
}

interface ManualCheckEvidenceEntry {
  id: string;
  rule: string;
  category: string;
  wcag: string;
  task: string;
  status: 'Pass' | 'Fail' | 'Needs Human Review';
  status_label: string;
  description: string;
  remediation?: AgentRemediation;
  nodes: Array<{ url: string; selector: string; html: string }>;
  agent_descriptions: string[];
}

interface CandidateIssue {
  source: 'issues' | 'incomplete';
  url: string;
  rule: string;
  description: string;
  wcag_criteria: string[];
  nodes: Array<{ selector: string; html: string; failureSummary: string }>;
}

interface CandidateProof {
  id: string;
  url: string;
  rule: string;
  wcag_criteria: string[];
  selector: string;
  html: string;
  failureSummary: string;
  source: 'issues' | 'incomplete';
}

function buildIssueJsonSchema(manualChecks: ManualCheckDefinition[]) {
  const manualCheckIds = manualChecks.map((m) => m.id);
  const categories = [...new Set(manualChecks.map((m) => m.category))];
  const wcagValues = [...new Set(manualChecks.map((m) => m.wcag))];

  return {
    name: 'llm_agent_issues',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        evaluation_results: {
          type: 'object',
          additionalProperties: false,
          properties: {
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  manual_check_id: { type: 'string', enum: manualCheckIds },
                  category: { type: 'string', enum: categories },
                  wcag_criteria: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 1,
                    items: { type: 'string', enum: wcagValues },
                  },
                  engine: { type: 'string', const: 'llm-agent' },
                  severity: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor'] },
                  description: { type: 'string' },
                  remediation: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      recommended_fix: { type: 'string' },
                      explanation: { type: 'string' },
                    },
                    required: ['recommended_fix', 'explanation'],
                  },
                  nodes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        url: { type: 'string' },
                        selector: { type: 'string' },
                        html: { type: 'string' },
                        failureSummary: { type: 'string' },
                      },
                      required: ['url', 'selector', 'html', 'failureSummary'],
                    },
                  },
                },
                required: ['manual_check_id', 'category', 'wcag_criteria', 'engine', 'severity', 'description', 'nodes'],
              },
            },
          },
          required: ['issues'],
        },
      },
      required: ['evaluation_results'],
    },
  } as const;
}

function isSeverity(value: string): value is Severity {
  return value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor';
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function normalizeNode(input: unknown): AgentNode | null {
  if (!input || typeof input !== 'object') return null;
  const node = input as Record<string, unknown>;
  return {
    url: toText(node.url),
    selector: toText(node.selector),
    html: toText(node.html),
    failureSummary: toText(node.failureSummary),
  };
}

function normalizeRemediation(input: unknown): AgentRemediation | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const recommended_fix = toText(raw.recommended_fix).trim();
  const explanation = toText(raw.explanation).trim();
  if (!recommended_fix || !explanation) return undefined;
  return { recommended_fix, explanation };
}

function wcagToTag(wcag: string): string {
  return `wcag${wcag.replace(/\./g, '')}`;
}

function sanitizeIssues(
  payload: unknown,
  manualChecks: ManualCheckDefinition[],
  sourceByNodeKey: Map<string, CandidateNode['source']>,
): AgentIssue[] {
  if (!Array.isArray(payload)) return [];

  const checksById = new Map(manualChecks.map((m) => [m.id, m]));
  const issues: AgentIssue[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const manualCheckId = toText(raw.manual_check_id);
    const categoryRaw = toText(raw.category);
    const wcagCriteriaRaw = Array.isArray(raw.wcag_criteria) ? raw.wcag_criteria : [];
    const wcagRaw = toText(wcagCriteriaRaw[0]);
    const severityRaw = toText(raw.severity);
    const remediation = normalizeRemediation(raw.remediation);
    const check = checksById.get(manualCheckId);
    if (!check) continue;
    if (check.category !== categoryRaw || check.wcag !== wcagRaw) continue;
    const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : [];
    const nodes = nodesRaw
      .map(normalizeNode)
      .filter((n): n is AgentNode => n !== null);

    if (!isSeverity(severityRaw) || nodes.length === 0) continue;

    const hasInvalidSource = nodes.some((node) => {
      const source = sourceByNodeKey.get(`${node.url}||${node.selector}||${node.html}`);
      if (!source) return true;
      return !check.appliesTo.includes(source);
    });
    if (hasInvalidSource) continue;

    issues.push({
      rule: check.rule,
      engine: 'llm-agent',
      severity: severityRaw,
      wcag: check.wcag,
      wcagTags: [wcagToTag(check.wcag)],
      wcag_criteria: [check.wcag],
      category: check.category,
      description: toText(raw.description) || 'LLM-basierte semantische Pruefung.',
      nodes,
      remediation,
    });
  }
  return issues;
}

function extractIssuesArray(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const evaluationResults = root.evaluation_results;
  if (!evaluationResults || typeof evaluationResults !== 'object') return [];

  const typedResults = evaluationResults as Record<string, unknown>;
  return Array.isArray(typedResults.issues) ? typedResults.issues : [];
}

function extractWcagCriteria(tags: string[]): string[] {
  const criteria: string[] = [];
  for (const tag of tags) {
    const match = tag.match(/^wcag(\d)(\d)(\d+)$/);
    if (match) criteria.push(`${match[1]}.${match[2]}.${match[3]}`);
  }
  return criteria;
}

function getIssueWcagCriteria(issue: Record<string, unknown>): string[] {
  const fromTyped = Array.isArray(issue.wcag_criteria)
    ? (issue.wcag_criteria as unknown[]).map((v) => toText(v).trim()).filter(Boolean)
    : [];
  if (fromTyped.length > 0) return fromTyped;

  const fromTags = extractWcagCriteria(Array.isArray(issue.wcagTags) ? (issue.wcagTags as string[]) : []);
  if (fromTags.length > 0) return fromTags;
  const wcag = toText(issue.wcag).trim();
  if (!wcag) return [];
  return wcag.split('/').map((s) => s.trim()).filter(Boolean);
}

function collectAllIssues(rawResult: any): CandidateIssue[] {
  const pages = Array.isArray(rawResult?.pages) ? rawResult.pages : [];
  const all: CandidateIssue[] = [];

  for (const page of pages) {
    const pageUrl = toText(page?.url);
    const fromIssues = Array.isArray(page?.issues) ? page.issues : [];
    const fromIncomplete = Array.isArray(page?.incomplete) ? page.incomplete : [];

    const pushIssue = (source: 'issues' | 'incomplete', issue: any) => {
      if (!issue || typeof issue !== 'object') return;
      const typed = issue as Record<string, unknown>;
      const rule = toText(typed.rule).trim();
      const description = toText(typed.description).trim() || toText(typed.help).trim();
      const wcag_criteria = getIssueWcagCriteria(typed);
      const rawNodes = Array.isArray(typed.nodes) ? typed.nodes : [];
      const nodes = rawNodes
        .map((node) => {
          if (!node || typeof node !== 'object') return null;
          const n = node as Record<string, unknown>;
          const selector = toText(n.selector);
          const html = toText(n.html); // keep placeholders like ##...## untouched
          const failureSummary = toText(n.failureSummary);
          if (!selector || !html) return null;
          return { selector, html, failureSummary };
        })
        .filter((node): node is { selector: string; html: string; failureSummary: string } => node !== null);

      all.push({
        source,
        url: pageUrl,
        rule,
        description,
        wcag_criteria,
        nodes,
      });
    };

    for (const issue of fromIssues) pushIssue('issues', issue);
    for (const issue of fromIncomplete) pushIssue('incomplete', issue);
  }

  return all;
}

// Filters candidates by WCAG and keeps a compact representative set.
// Max 3 nodes per (rule,url) group.
export function findRelevantCandidates(allIssues: CandidateIssue[], wcagId: string): CandidateProof[] {
  const filtered = allIssues.filter((issue) => issue.wcag_criteria.includes(wcagId));
  const groupCounts = new Map<string, number>();
  const candidates: CandidateProof[] = [];
  let counter = 1;

  for (const issue of filtered) {
    const groupKey = `${issue.rule}||${issue.url}`;
    const current = groupCounts.get(groupKey) || 0;
    if (current >= 3) continue;

    for (const node of issue.nodes) {
      const used = groupCounts.get(groupKey) || 0;
      if (used >= 3) break;

      candidates.push({
        id: `${wcagId.replace(/\./g, '_')}_${counter++}`,
        url: issue.url,
        rule: issue.rule,
        wcag_criteria: issue.wcag_criteria,
        selector: node.selector,
        html: node.html, // keep ##...## placeholders unchanged
        failureSummary: node.failureSummary,
        source: issue.source,
      });

      groupCounts.set(groupKey, used + 1);
    }
  }

  return candidates;
}

function buildDecisionSchema(manualCheckId: string, candidateIds: string[]) {
  return {
    name: 'manual_check_decision',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: {
          type: 'object',
          additionalProperties: false,
          properties: {
            manual_check_id: { type: 'string', enum: [manualCheckId] },
            status: { type: 'string', enum: ['Pass', 'Fail', 'Needs Human Review'] },
            explanation: { type: 'string' },
            agent_descriptions: {
              type: 'array',
              items: { type: 'string' },
            },
            evidence_candidate_ids: {
              type: 'array',
              items: { type: 'string', enum: candidateIds },
            },
            remediation: {
              type: 'object',
              additionalProperties: false,
              properties: {
                recommended_fix: { type: 'string' },
                explanation: { type: 'string' },
              },
              required: ['recommended_fix', 'explanation'],
            },
          },
          required: ['manual_check_id', 'status', 'explanation', 'agent_descriptions', 'evidence_candidate_ids'],
        },
      },
      required: ['decision'],
    },
  } as const;
}

async function evaluateManualCheckDecision(
  client: OpenAI,
  pageContext: { urls: string[]; titles: string[] },
  check: ManualCheckDefinition,
  candidates: CandidateProof[],
): Promise<{
  status: 'Pass' | 'Fail' | 'Needs Human Review';
  explanation: string;
  agent_descriptions: string[];
  evidence_candidate_ids: string[];
  remediation?: AgentRemediation;
} | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: buildDecisionSchema(check.id, candidates.map((c) => c.id)),
      },
      messages: [
        {
          role: 'system',
          content: [
            'Du bist ein Accessibility-Reviewer fuer semantische Checks.',
            'Entscheide ausschliesslich anhand der uebergebenen Kandidaten: bestaetigen sie den Verdacht fuer den Check?',
            'Falls keine Kandidaten/Beweise geliefert werden UND die automatische Vorpruefung keine Fehler meldet, schlage einen "Pass" vor, sofern keine offensichtliche manuelle Sichtpruefung (wie bei komplexen Multimedia-Inhalten) zwingend erforderlich ist.',
            'Du bist verpflichtet, zu jedem Fail oder Needs-Review-Status mindestens 1-3 konkrete Code-Beispiele (Nodes) aus dem Scan-Input mitzuliefern.',
            'Nutze bei Bildern den Kontext aus check.task, URL, Seitentitel, issueDescription und HTML-Snippet fuer semantisch passende Alt-Texte.',
            'Wenn du einen eindeutigen Verstoß (Fail) feststellst, der technisch loesbar ist (z.B. fehlende Alt-Texte, falsche ARIA-Attribute, fehlende Labels), generiere im Feld recommended_fix den fertigen Korrektur-Code.',
            'WICHTIG: Bewahre Platzhalter wie ##...## exakt unveraendert im vorgeschlagenen HTML.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            check: {
              id: check.id,
              rule: check.rule,
              wcag: check.wcag,
              category: check.category,
              task: check.task || check.label || check.rule,
            },
            pageContext,
            candidates,
          }),
        },
      ],
    }, { signal: controller.signal });

    const jsonString = extractJsonStringFromCompletion(completion);
    if (!jsonString) return null;
    const parsed = JSON.parse(jsonString) as Record<string, unknown>;
    const decision = (parsed.decision || {}) as Record<string, unknown>;

    const status = toText(decision.status) as 'Pass' | 'Fail' | 'Needs Human Review';
    if (!['Pass', 'Fail', 'Needs Human Review'].includes(status)) return null;

    const evidence_candidate_ids = Array.isArray(decision.evidence_candidate_ids)
      ? decision.evidence_candidate_ids.map((id) => toText(id)).filter(Boolean)
      : [];
    const agent_descriptions = Array.isArray(decision.agent_descriptions)
      ? decision.agent_descriptions.map((text) => toText(text)).filter(Boolean)
      : [];

    return {
      status,
      explanation: toText(decision.explanation) || 'Keine Erklaerung geliefert.',
      agent_descriptions,
      evidence_candidate_ids,
      remediation: normalizeRemediation(decision.remediation),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonStringFromCompletion(completion: unknown): string | null {
  if (!completion || typeof completion !== 'object') return null;

  const typed = completion as Record<string, unknown>;
  const choices = typed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const firstChoice = choices[0] as Record<string, unknown>;
  const message = firstChoice.message as Record<string, unknown> | undefined;
  if (!message) return null;

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string') return p.text;
    }
  }

  return null;
}

async function evaluatePageNodes(
  client: OpenAI,
  pageUrl: string,
  pageTitle: string,
  nodes: CandidateNode[],
  manualChecks: ManualCheckDefinition[],
): Promise<AgentIssue[] | null> {
  const payload = nodes.slice(0, 120);
  const sourceByNodeKey = new Map<string, CandidateNode['source']>();
  for (const node of payload) {
    sourceByNodeKey.set(`${node.pageUrl}||${node.selector}||${node.html}`, node.source);
  }
  const manualChecksForPrompt = manualChecks.map((check) => ({
    id: check.id,
    rule: check.rule,
    category: check.category,
    wcag_criteria: [check.wcag],
    appliesTo: check.appliesTo,
    task: check.task || check.label || check.rule,
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: buildIssueJsonSchema(manualChecks),
      },
      messages: [
        {
          role: 'system',
          content: [
            'Du bist ein Accessibility-Reviewer fuer semantische Checks.',
            'Analysiere nur die gelieferten HTML-Snippets.',
            'Gib NUR JSON zurueck, exakt nach dem Schema.',
            'Erzeuge nur Issues, wenn ein konkretes Problem vorliegt.',
            'Setze engine immer auf "llm-agent".',
            'Ordne jedes Issue exakt einem manual_check_id aus manualChecks zu.',
            'category und wcag_criteria muessen exakt zum ausgewaehlten manual_check_id passen.',
            'Jeder Node muss url, selector, html und failureSummary enthalten.',
            'Uebernimm fuer url immer die betroffene Seiten-URL des Kandidaten.',
            'Liefere pro Issue die kritischsten 1-3 Beispiel-Nodes, keine redundanten Duplikate.',
            'Du bist verpflichtet, zu jedem Fail oder Needs-Review-Status mindestens 1-3 konkrete Code-Beispiele (Nodes) aus dem Scan-Input mitzuliefern.',
            'Wenn du einen eindeutigen Verstoß (Fail) feststellst, der technisch loesbar ist (z.B. fehlende Alt-Texte, falsche ARIA-Attribute, fehlende Labels), generiere im Feld recommended_fix den fertigen Korrektur-Code.',
            'Nutze bei Bildern den Kontext aus pageUrl, pageTitle, issueDescription und HTML-Snippet, um den semantisch passendsten Alt-Text vorzuschlagen.',
            'Pruefe source je Kandidat: source=suspicious-alt-text darf nur Checks mit appliesTo containing suspicious-alt-text nutzen.',
            'source=incomplete darf nur Checks mit appliesTo containing incomplete nutzen.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            pageUrl,
            pageTitle,
            task: 'Pruefe verdaechtige Alt-Texte und manuell zu pruefende Axe-Checks semantisch.',
            manualChecks: manualChecksForPrompt,
            candidates: payload,
          }),
        },
      ],
    }, { signal: controller.signal });

    const jsonString = extractJsonStringFromCompletion(completion);
    if (!jsonString) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      return null;
    }

    const issuesPayload = extractIssuesArray(parsed);
    return sanitizeIssues(issuesPayload, manualChecks, sourceByNodeKey);
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAgentEvaluation(
  rawResult: any,
  openaiApiKey: string,
  manualChecks: ManualCheckDefinition[],
) {
  if (
    !rawResult ||
    !Array.isArray(rawResult.pages) ||
    !openaiApiKey ||
    !Array.isArray(manualChecks) ||
    manualChecks.length === 0
  ) {
    return rawResult;
  }

  const client = new OpenAI({ apiKey: openaiApiKey });
  const allIssues = collectAllIssues(rawResult);
  const pageContext = {
    urls: Array.from(new Set(allIssues.map((issue) => issue.url).filter(Boolean))).slice(0, 20),
    titles: (Array.isArray(rawResult?.pages) ? rawResult.pages : [])
      .map((p: any) => toText(p?.title))
      .filter(Boolean)
      .slice(0, 20),
  };

  const results: ManualCheckEvidenceEntry[] = [];
  const QUALITATIVE_REVIEW_WCAG = new Set(['1.1.1', '1.3.1']);

  for (const check of manualChecks) {
    if (check.autoPassIfEmpty === true) {
      continue;
    }
    const task = check.task || check.label || check.rule;
    const wcagCandidates = findRelevantCandidates(allIssues, check.wcag);
    const ruleCandidates = allIssues
      .filter((issue) => issue.rule === check.rule)
      .flatMap((issue) =>
        issue.nodes.slice(0, 3).map((node, idx) => ({
          id: `${check.id}_rule_${idx + 1}`,
          url: issue.url,
          rule: issue.rule,
          wcag_criteria: issue.wcag_criteria,
          selector: node.selector,
          html: node.html,
          failureSummary: node.failureSummary,
          source: issue.source,
        })),
      );
    const candidateMap = new Map<string, CandidateProof>();
    for (const cand of [...wcagCandidates, ...ruleCandidates]) {
      const key = `${cand.url}||${cand.selector}||${cand.html}`;
      if (!candidateMap.has(key)) candidateMap.set(key, cand);
      if (candidateMap.size >= 30) break;
    }
    const candidates = [...candidateMap.values()];

    if (candidates.length === 0) {
      const isQualitative = QUALITATIVE_REVIEW_WCAG.has(check.wcag);
      results.push({
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag: check.wcag,
        task,
        status: isQualitative ? 'Needs Human Review' : 'Pass',
        status_label: isQualitative
          ? 'Needs Human Review'
          : 'Auto-Pass (Keine technischen Verstöße gefunden)',
        description: isQualitative
          ? 'Keine ausreichenden technischen Belege; qualitative Sichtpruefung empfohlen.'
          : 'Keine relevanten technischen Verstoesse in der automatisierten Vorpruefung gefunden.',
        agent_descriptions: ['Die automatisierte Prüfung hat keine relevanten Verstöße für dieses Kriterium identifiziert. Eine manuelle Stichprobe ist optional.'],
        nodes: [],
      });
      continue;
    }

    const decision = await evaluateManualCheckDecision(client, pageContext, check, candidates);
    if (!decision) {
      results.push({
        id: check.id,
        rule: check.rule,
        category: check.category,
        wcag: check.wcag,
        task,
        status: 'Needs Human Review',
        status_label: 'Needs Human Review',
        description: 'Agent-Entscheidung nicht verifizierbar.',
        agent_descriptions: ['Agent konnte keine valide Entscheidung fuer diesen Check liefern.'],
        nodes: candidates.slice(0, 3).map((c) => ({ url: c.url, selector: c.selector, html: c.html })),
      });
      continue;
    }

    const chosen = candidates.filter((c) => decision.evidence_candidate_ids.includes(c.id));
    const evidence = (chosen.length > 0 ? chosen : candidates.slice(0, 3)).slice(0, 3);
    const statusLabel = decision.status === 'Pass'
      ? 'Verified by AI - Pass'
      : decision.status;

    results.push({
      id: check.id,
      rule: check.rule,
      category: check.category,
      wcag: check.wcag,
      task,
      status: decision.status,
      status_label: statusLabel,
      description: decision.explanation,
      remediation: decision.remediation,
      agent_descriptions: decision.agent_descriptions,
      nodes: evidence.map((c) => ({ url: c.url, selector: c.selector, html: c.html })),
    });
  }

  rawResult.manual_checks = results;

  return rawResult;
}
