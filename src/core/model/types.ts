/**
 * The SuperProcess process model.
 *
 * This is the single source of truth for a mapped process. The AI produces it,
 * the normaliser repairs it, the validator scores it against BPMN 2.0 rules,
 * the layout engine positions it and every exporter (Visio, BPMN XML, draw.io,
 * SVG, PNG, PDF) renders it.
 *
 * It is deliberately a flat structure with no optional fields: that shape is
 * the one language models (including small local ones) reproduce most reliably,
 * and it satisfies the strict JSON-schema modes of every provider.
 */

export const NODE_TYPES = [
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
  'task',
  'userTask',
  'manualTask',
  'serviceTask',
  'scriptTask',
  'businessRuleTask',
  'sendTask',
  'receiveTask',
  'subProcess',
  'callActivity',
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EVENT_KINDS = [
  'none',
  'message',
  'timer',
  'error',
  'escalation',
  'conditional',
  'signal',
  'terminate',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const LOOP_KINDS = ['none', 'loop', 'parallel', 'sequential'] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];

/** A swimlane: a role, team, department or system that performs work. */
export interface Lane {
  id: string;
  name: string;
}

export interface ProcessNode {
  id: string;
  type: NodeType;
  /** Label shown on the diagram. */
  name: string;
  /** Id of the lane that performs this node. */
  lane: string;
  /** Trigger/result for events; `none` for everything else. */
  eventKind: EventKind;
  /** Boundary events only: id of the activity the event is attached to. */
  attachedTo: string;
  /** Boundary events only: whether the event cancels its activity. */
  interrupting: boolean;
  /** Activity marker: standard loop or multi-instance. */
  loop: LoopKind;
  /** What happens in this step, as described by the source material. */
  description: string;
  /** Applications and tools used in this step. */
  systems: string[];
  /** Documents and data consumed. */
  inputs: string[];
  /** Documents and data produced. */
  outputs: string[];
  /** Processing or waiting time, as stated in the source ("2 days"). */
  duration: string;
  /** Pain points mentioned in the source for this step. */
  issues: string[];
}

/** A sequence flow. */
export interface Flow {
  id: string;
  from: string;
  to: string;
  /** Condition label, e.g. "Yes" / "Above 5,000". */
  label: string;
  /** Marks the default branch of an exclusive or inclusive gateway. */
  isDefault: boolean;
}

/** An external party drawn as a collapsed ("black box") pool. */
export interface ExternalParticipant {
  id: string;
  name: string;
}

/** A message exchanged between a node of the process and an external party. */
export interface MessageFlow {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface ProcessModel {
  /** Process name, e.g. "Purchase request approval". */
  name: string;
  /** Two to four sentences: trigger, main path, outcome. */
  summary: string;
  /** BCP-47 code of the language used for names and descriptions. */
  language: string;
  /** Name of the organisation or unit that owns the process (the pool). */
  pool: string;
  lanes: Lane[];
  nodes: ProcessNode[];
  flows: Flow[];
  externals: ExternalParticipant[];
  messageFlows: MessageFlow[];
  /** Assumptions the analyst made where the source was ambiguous or silent. */
  assumptions: string[];
  /** Questions to validate with the process owners. */
  openQuestions: string[];
}

const EVENT_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
]);

const GATEWAY_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
]);

export function isEvent(type: NodeType): boolean {
  return EVENT_TYPES.has(type);
}

export function isGateway(type: NodeType): boolean {
  return GATEWAY_TYPES.has(type);
}

export function isActivity(type: NodeType): boolean {
  return !EVENT_TYPES.has(type) && !GATEWAY_TYPES.has(type);
}

export function emptyModel(): ProcessModel {
  return {
    name: '',
    summary: '',
    language: 'en',
    pool: '',
    lanes: [],
    nodes: [],
    flows: [],
    externals: [],
    messageFlows: [],
    assumptions: [],
    openQuestions: [],
  };
}

/** Incoming/outgoing sequence-flow index, built once and shared. */
export interface FlowIndex {
  incoming: Map<string, Flow[]>;
  outgoing: Map<string, Flow[]>;
  byId: Map<string, ProcessNode>;
}

export function indexFlows(model: ProcessModel): FlowIndex {
  const incoming = new Map<string, Flow[]>();
  const outgoing = new Map<string, Flow[]>();
  const byId = new Map<string, ProcessNode>();
  for (const node of model.nodes) {
    byId.set(node.id, node);
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const flow of model.flows) {
    outgoing.get(flow.from)?.push(flow);
    incoming.get(flow.to)?.push(flow);
  }
  return { incoming, outgoing, byId };
}
