/**
 * BPMN 2.0 quality check.
 *
 * Errors are violations of the BPMN specification (the diagram would be
 * rejected or misread by a BPMN engine or modeller). Warnings are violations
 * of widely used modelling conventions (Bruce Silver's "Method and Style",
 * the Camunda best practices, bpmnlint). Infos are suggestions.
 *
 * Messages are returned as codes plus parameters so the UI can translate them.
 */
import { indexFlows, isActivity, isEvent, isGateway, type ProcessModel, type ProcessNode } from './types';

export type Severity = 'error' | 'warning' | 'info';

export type RuleCode =
  | 'noStartEvent'
  | 'noEndEvent'
  | 'startHasIncoming'
  | 'endHasOutgoing'
  | 'noIncoming'
  | 'noOutgoing'
  | 'unreachable'
  | 'cannotReachEnd'
  | 'eventGatewayTargets'
  | 'boundaryNoOutgoing'
  | 'superfluousGateway'
  | 'gatewayMixed'
  | 'splitFlowsUnlabeled'
  | 'splitUnnamed'
  | 'implicitSplit'
  | 'implicitMerge'
  | 'unnamedActivity'
  | 'unnamedEvent'
  | 'longName'
  | 'duplicateName'
  | 'multipleStarts'
  | 'parallelFlowLabeled'
  | 'multipleDefaults'
  | 'largeDiagram'
  | 'messageTaskWithoutMessage';

export interface ValidationIssue {
  code: RuleCode;
  severity: Severity;
  /** Ids of the nodes the issue refers to (may be empty for process-level issues). */
  nodeIds: string[];
  params: Record<string, string | number>;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** 0–100; 100 means no findings at all. */
  score: number;
  counts: Record<Severity, number>;
  /** Number of distinct rules that were evaluated. */
  rulesChecked: number;
}

const SEVERITY: Record<RuleCode, Severity> = {
  noStartEvent: 'error',
  noEndEvent: 'error',
  startHasIncoming: 'error',
  endHasOutgoing: 'error',
  noIncoming: 'error',
  noOutgoing: 'error',
  unreachable: 'error',
  cannotReachEnd: 'error',
  eventGatewayTargets: 'error',
  boundaryNoOutgoing: 'error',
  superfluousGateway: 'warning',
  gatewayMixed: 'warning',
  splitFlowsUnlabeled: 'warning',
  splitUnnamed: 'warning',
  implicitSplit: 'warning',
  unnamedActivity: 'warning',
  multipleDefaults: 'warning',
  messageTaskWithoutMessage: 'info',
  implicitMerge: 'info',
  unnamedEvent: 'info',
  longName: 'info',
  duplicateName: 'info',
  multipleStarts: 'info',
  parallelFlowLabeled: 'info',
  largeDiagram: 'info',
};

const PENALTY: Record<Severity, number> = { error: 12, warning: 4, info: 1 };

const MAX_NAME_LENGTH = 60;
const LARGE_DIAGRAM_NODES = 50;

function reach(starts: string[], next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const target of next(id)) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

export function validateModel(model: ProcessModel): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (code: RuleCode, nodes: ProcessNode[], params: Record<string, string | number> = {}): void => {
    issues.push({ code, severity: SEVERITY[code], nodeIds: nodes.map((n) => n.id), params });
  };
  const label = (node: ProcessNode): string => node.name || node.id;

  const { incoming, outgoing, byId } = indexFlows(model);
  const boundaryOf = new Map<string, ProcessNode[]>();
  for (const node of model.nodes) {
    if (node.type === 'boundaryEvent' && node.attachedTo) {
      const list = boundaryOf.get(node.attachedTo) ?? [];
      list.push(node);
      boundaryOf.set(node.attachedTo, list);
    }
  }

  const starts = model.nodes.filter((n) => n.type === 'startEvent');
  const ends = model.nodes.filter((n) => n.type === 'endEvent');
  if (starts.length === 0) add('noStartEvent', []);
  if (ends.length === 0) add('noEndEvent', []);
  if (starts.filter((n) => n.eventKind === 'none').length > 1) add('multipleStarts', starts);

  // Token flow also continues from an activity into its boundary events.
  const successors = (id: string): string[] => [
    ...(outgoing.get(id) ?? []).map((f) => f.to),
    ...(boundaryOf.get(id) ?? []).map((b) => b.id),
  ];
  const predecessors = (id: string): string[] => {
    const node = byId.get(id);
    const viaHost = node?.type === 'boundaryEvent' && node.attachedTo ? [node.attachedTo] : [];
    return [...(incoming.get(id) ?? []).map((f) => f.from), ...viaHost];
  };
  const reachable = reach(starts.map((n) => n.id), successors);
  const canFinish = reach(ends.map((n) => n.id), predecessors);

  const namesSeen = new Map<string, ProcessNode>();

  for (const node of model.nodes) {
    const ins = incoming.get(node.id) ?? [];
    const outs = outgoing.get(node.id) ?? [];
    const isBoundary = node.type === 'boundaryEvent';

    if (node.type === 'startEvent' && ins.length > 0) add('startHasIncoming', [node], { node: label(node) });
    if (node.type === 'endEvent' && outs.length > 0) add('endHasOutgoing', [node], { node: label(node) });

    if (isBoundary) {
      if (outs.length === 0) add('boundaryNoOutgoing', [node], { node: label(node) });
    } else {
      if (ins.length === 0 && node.type !== 'startEvent') add('noIncoming', [node], { node: label(node) });
      if (outs.length === 0 && node.type !== 'endEvent') add('noOutgoing', [node], { node: label(node) });
    }

    if (starts.length > 0 && ins.length > 0 && !reachable.has(node.id)) add('unreachable', [node], { node: label(node) });
    if (ends.length > 0 && outs.length > 0 && !canFinish.has(node.id)) add('cannotReachEnd', [node], { node: label(node) });

    if (isGateway(node.type)) {
      if (ins.length <= 1 && outs.length <= 1) add('superfluousGateway', [node], { node: label(node) });
      if (ins.length > 1 && outs.length > 1) add('gatewayMixed', [node], { node: label(node) });

      const splits = outs.length > 1;
      if (splits && (node.type === 'exclusiveGateway' || node.type === 'inclusiveGateway')) {
        const unlabeled = outs.filter((f) => !f.label && !f.isDefault);
        // One unlabeled branch is acceptable when it is the only "otherwise" path.
        if (unlabeled.length > 1 || (unlabeled.length === 1 && !outs.some((f) => f.label))) {
          add('splitFlowsUnlabeled', [node], { node: label(node), count: unlabeled.length });
        }
        if (!node.name) add('splitUnnamed', [node]);
        if (outs.filter((f) => f.isDefault).length > 1) add('multipleDefaults', [node], { node: label(node) });
      }
      if (splits && node.type === 'parallelGateway' && outs.some((f) => f.label)) {
        add('parallelFlowLabeled', [node], { node: label(node) });
      }
      if (node.type === 'eventBasedGateway') {
        const bad = outs
          .map((f) => byId.get(f.to))
          .filter((t): t is ProcessNode => !!t && t.type !== 'intermediateCatchEvent' && t.type !== 'receiveTask');
        if (bad.length > 0) add('eventGatewayTargets', [node, ...bad], { node: label(node) });
      }
    }

    if (isActivity(node.type)) {
      if (!node.name) add('unnamedActivity', [node]);
      if (outs.length > 1) add('implicitSplit', [node], { node: label(node) });
      if (ins.length > 1) add('implicitMerge', [node], { node: label(node) });
      if (node.name) {
        const key = `${node.lane}\u0000${node.name.toLowerCase()}`;
        const twin = namesSeen.get(key);
        if (twin) add('duplicateName', [twin, node], { node: node.name });
        else namesSeen.set(key, node);
      }
      if (
        (node.type === 'sendTask' || node.type === 'receiveTask') &&
        model.externals.length > 0 &&
        !model.messageFlows.some((m) => m.from === node.id || m.to === node.id)
      ) {
        add('messageTaskWithoutMessage', [node], { node: label(node) });
      }
    }

    if (isEvent(node.type) && !node.name && !isBoundary) add('unnamedEvent', [node]);
    if (node.name.length > MAX_NAME_LENGTH) add('longName', [node], { node: label(node), max: MAX_NAME_LENGTH });
  }

  if (model.nodes.length > LARGE_DIAGRAM_NODES) add('largeDiagram', [], { count: model.nodes.length });

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let penalty = 0;
  for (const issue of issues) {
    counts[issue.severity]++;
    penalty += PENALTY[issue.severity];
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    issues,
    score: Math.max(0, 100 - penalty),
    counts,
    rulesChecked: Object.keys(SEVERITY).length,
  };
}
