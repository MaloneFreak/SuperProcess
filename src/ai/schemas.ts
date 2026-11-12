/**
 * JSON Schemas for the two structured answers the AI gives.
 *
 * They stay inside the subset every provider's strict mode accepts: every
 * property is required, no object allows extra properties, and there are no
 * numeric or length constraints.
 */
import { EVENT_KINDS, LOOP_KINDS, NODE_TYPES } from '../core/model/types';
import { HORIZONS, LEVELS, SEVERITIES } from '../core/report/types';
import type { JsonSchema } from './types';

type Props = Record<string, JsonSchema>;

const object = (properties: Props): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const string = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const strings = (description?: string): JsonSchema => ({
  type: 'array',
  items: { type: 'string' },
  ...(description ? { description } : {}),
});
const array = (items: JsonSchema, description?: string): JsonSchema => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
});
const choice = (values: readonly string[], description?: string): JsonSchema => ({
  type: 'string',
  enum: [...values],
  ...(description ? { description } : {}),
});

export const PROCESS_SCHEMA: JsonSchema = object({
  name: string('Name of the process.'),
  summary: string('Two to four sentences: what triggers the process, the main path, the outcomes.'),
  language: string('BCP-47 code of the language used for names and descriptions.'),
  pool: string('Organisation or unit that owns the process.'),
  lanes: array(object({ id: string(), name: string('Role, team, department or system.') })),
  nodes: array(
    object({
      id: string(),
      type: choice(NODE_TYPES),
      name: string('Label shown on the diagram.'),
      lane: string('Id of the lane that performs this node.'),
      eventKind: choice(EVENT_KINDS, 'For events; "none" otherwise.'),
      attachedTo: string('Boundary events: id of the activity it is attached to; "" otherwise.'),
      interrupting: { type: 'boolean', description: 'Boundary events: false if the activity continues.' },
      loop: choice(LOOP_KINDS),
      description: string('What happens in this step.'),
      systems: strings('Applications and tools used.'),
      inputs: strings('Documents and data consumed.'),
      outputs: strings('Documents and data produced.'),
      duration: string('Processing or waiting time as stated in the sources.'),
      issues: strings('Problems mentioned for this step.'),
    }),
  ),
  flows: array(
    object({
      from: string('Id of the source node.'),
      to: string('Id of the target node.'),
      label: string('Condition, for flows leaving a gateway.'),
      isDefault: { type: 'boolean' },
    }),
  ),
  externals: array(object({ id: string(), name: string() }), 'Outside parties that only exchange messages.'),
  messageFlows: array(
    object({ from: string('Node id or external id.'), to: string('Node id or external id.'), label: string('What is sent.') }),
  ),
  assumptions: strings(),
  openQuestions: strings(),
});

export const REPORT_SCHEMA: JsonSchema = object({
  title: string(),
  executiveSummary: string('The conclusions a decision maker needs, in three to six sentences.'),
  score: object({
    value: { type: 'integer', description: '0 to 100.' },
    label: string('Two or three words that characterise the score.'),
    rationale: string(),
  }),
  dimensions: array(object({ name: string(), score: { type: 'integer', description: '0 to 100.' }, comment: string() })),
  metrics: array(
    object({ label: string(), value: string(), note: string('Basis of the figure; say so if it is an estimate.') }),
    'Key figures relevant to this angle.',
  ),
  findings: array(
    object({
      id: string('F1, F2, …'),
      title: string(),
      severity: choice(SEVERITIES),
      category: string(),
      steps: strings('Ids of the process nodes concerned.'),
      description: string(),
      evidence: string('Quote or reference from the sources or the model.'),
      impact: string(),
      recommendation: string(),
    }),
  ),
  sections: array(
    object({
      heading: string(),
      body: string('Plain text; lines starting with "- " are bullet points.'),
      table: object({ columns: strings(), rows: array(strings()) }),
    }),
  ),
  actions: array(
    object({
      title: string(),
      description: string(),
      priority: choice(LEVELS),
      effort: choice(LEVELS),
      impact: choice(LEVELS),
      horizon: choice(HORIZONS),
      findings: strings('Ids of the findings this action addresses.'),
    }),
  ),
  openQuestions: strings(),
  limitations: string(),
});
