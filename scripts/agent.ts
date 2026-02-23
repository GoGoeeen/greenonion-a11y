import OpenAI from 'openai';
import type { ManualCheckDefinition } from './manual-checks.js';

type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

interface AgentNode {
  selector: string;
  html: string;
  failureSummary: string;
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
                  nodes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        selector: { type: 'string' },
                        html: { type: 'string' },
                        failureSummary: { type: 'string' },
                      },
                      required: ['selector', 'html', 'failureSummary'],
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
    selector: toText(node.selector),
    html: toText(node.html),
    failureSummary: toText(node.failureSummary),
  };
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
    const check = checksById.get(manualCheckId);
    if (!check) continue;
    if (check.category !== categoryRaw || check.wcag !== wcagRaw) continue;
    const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : [];
    const nodes = nodesRaw
      .map(normalizeNode)
      .filter((n): n is AgentNode => n !== null);

    if (!isSeverity(severityRaw) || nodes.length === 0) continue;

    const hasInvalidSource = nodes.some((node) => {
      const source = sourceByNodeKey.get(`${node.selector}||${node.html}`);
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
  nodes: CandidateNode[],
  manualChecks: ManualCheckDefinition[],
): Promise<AgentIssue[] | null> {
  const payload = nodes.slice(0, 120);
  const sourceByNodeKey = new Map<string, CandidateNode['source']>();
  for (const node of payload) {
    sourceByNodeKey.set(`${node.selector}||${node.html}`, node.source);
  }
  const manualChecksForPrompt = manualChecks.map((check) => ({
    id: check.id,
    rule: check.rule,
    category: check.category,
    wcag_criteria: [check.wcag],
    appliesTo: check.appliesTo,
    label: check.label,
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
            'Pruefe source je Kandidat: source=suspicious-alt-text darf nur Checks mit appliesTo containing suspicious-alt-text nutzen.',
            'source=incomplete darf nur Checks mit appliesTo containing incomplete nutzen.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            pageUrl,
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

  for (const page of rawResult.pages) {
    try {
      const pageIssues = Array.isArray(page?.issues) ? page.issues : [];
      const pageIncomplete = Array.isArray(page?.incomplete) ? page.incomplete : [];

      const suspicious = pageIssues.filter(
        (issue: any) => issue && issue.rule === 'suspicious-alt-text',
      );

      const candidateNodes: CandidateNode[] = [];

      for (const issue of suspicious) {
        const nodes = Array.isArray(issue?.nodes) ? issue.nodes : [];
        for (const node of nodes) {
          candidateNodes.push({
            source: 'suspicious-alt-text',
            pageUrl: toText(page?.url),
            issueRule: toText(issue?.rule),
            issueDescription: toText(issue?.description),
            selector: toText(node?.selector),
            html: toText(node?.html),
            failureSummary: toText(node?.failureSummary),
          });
        }
      }

      for (const issue of pageIncomplete) {
        const nodes = Array.isArray(issue?.nodes) ? issue.nodes : [];
        for (const node of nodes) {
          candidateNodes.push({
            source: 'incomplete',
            pageUrl: toText(page?.url),
            issueRule: toText(issue?.rule),
            issueDescription: toText(issue?.description),
            selector: toText(node?.selector),
            html: toText(node?.html),
            failureSummary: toText(node?.failureSummary),
          });
        }
      }

      if (candidateNodes.length === 0) {
        continue;
      }

      const llmIssues = await evaluatePageNodes(client, toText(page?.url), candidateNodes, manualChecks);
      if (llmIssues === null) {
        continue;
      }

      if (!Array.isArray(page.issues)) {
        page.issues = [];
      }
      page.issues.push(...llmIssues);
    } catch (err) {
      console.warn(`LLM agent evaluation skipped for page "${toText(page?.url)}": ${(err as Error).message}`);
    }
  }

  return rawResult;
}
