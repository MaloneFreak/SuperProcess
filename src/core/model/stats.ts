/**
 * Deterministic process facts, computed from the model rather than asked of
 * the AI, so the numbers shown in the app and in reports are always exact.
 */
import { indexFlows, isActivity, isEvent, isGateway, type ProcessModel } from './types';

export interface ProcessStats {
  activities: number;
  events: number;
  gateways: number;
  lanes: number;
  externals: number;
  flows: number;
  /** Sequence flows that cross from one lane to another. */
  handoffs: number;
  /** Gateways where the path depends on a condition or an event. */
  decisions: number;
  parallelSplits: number;
  /** Flows that lead back to an earlier step (rework or repetition). */
  loops: number;
  /** Activities performed by people (user and manual tasks, untyped tasks). */
  humanSteps: number;
  /** Activities performed by systems (service, script, business-rule tasks). */
  automatedSteps: number;
  messageExchanges: number;
  stepsWithIssues: number;
  systems: string[];
  documents: string[];
}

function unique(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Ids of flows that close a cycle, found by depth-first search from the start
 * events. A boundary event counts as reachable from the activity it sits on.
 */
export function findBackFlows(model: ProcessModel): Set<string> {
  const { outgoing } = indexFlows(model);
  // Steps reachable from each node: [target id, flow id or null for an attachment].
  const next = new Map<string, [string, string | null][]>();
  for (const node of model.nodes) {
    next.set(node.id, (outgoing.get(node.id) ?? []).map((flow) => [flow.to, flow.id]));
  }
  for (const node of model.nodes) {
    if (node.type === 'boundaryEvent' && next.has(node.attachedTo)) next.get(node.attachedTo)!.push([node.id, null]);
  }

  const state = new Map<string, 0 | 1 | 2>(); // 0 = unseen, 1 = on stack, 2 = done
  const back = new Set<string>();
  const roots = [
    ...model.nodes.filter((n) => n.type === 'startEvent'),
    ...model.nodes.filter((n) => n.type !== 'startEvent' && n.type !== 'boundaryEvent'),
    ...model.nodes.filter((n) => n.type === 'boundaryEvent'),
  ];
  for (const root of roots) {
    if (state.get(root.id)) continue;
    const stack: { id: string; index: number }[] = [{ id: root.id, index: 0 }];
    state.set(root.id, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = next.get(frame.id) ?? [];
      if (frame.index >= edges.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const [target, flowId] = edges[frame.index++];
      const seen = state.get(target) ?? 0;
      if (seen === 1) {
        if (flowId) back.add(flowId);
      } else if (seen === 0) {
        state.set(target, 1);
        stack.push({ id: target, index: 0 });
      }
    }
  }
  return back;
}

export function computeStats(model: ProcessModel): ProcessStats {
  const { outgoing, byId } = indexFlows(model);
  const activities = model.nodes.filter((n) => isActivity(n.type));
  const laneOf = (id: string): string => {
    const node = byId.get(id);
    return node ? node.lane : '';
  };
  const splits = model.nodes.filter((n) => isGateway(n.type) && (outgoing.get(n.id)?.length ?? 0) > 1);
  const automated = new Set(['serviceTask', 'scriptTask', 'businessRuleTask']);

  return {
    activities: activities.length,
    events: model.nodes.filter((n) => isEvent(n.type)).length,
    gateways: model.nodes.filter((n) => isGateway(n.type)).length,
    lanes: model.lanes.length,
    externals: model.externals.length,
    flows: model.flows.length,
    handoffs: model.flows.filter((f) => laneOf(f.from) !== laneOf(f.to)).length,
    decisions: splits.filter((n) => n.type !== 'parallelGateway').length,
    parallelSplits: splits.filter((n) => n.type === 'parallelGateway').length,
    loops: findBackFlows(model).size,
    humanSteps: activities.filter((n) => !automated.has(n.type) && n.type !== 'subProcess' && n.type !== 'callActivity')
      .length,
    automatedSteps: activities.filter((n) => automated.has(n.type)).length,
    messageExchanges: model.messageFlows.length,
    stepsWithIssues: model.nodes.filter((n) => n.issues.length > 0).length,
    systems: unique(model.nodes.flatMap((n) => n.systems)),
    documents: unique(model.nodes.flatMap((n) => [...n.inputs, ...n.outputs])),
  };
}
