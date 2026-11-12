/**
 * Turns whatever a language model returned into a well-formed ProcessModel.
 *
 * Models (especially small local ones) drift from the requested schema in
 * predictable ways: aliased field names, type names in a different case,
 * lanes referenced by name instead of id, dangling flows, a missing end
 * event. Rejecting such output would waste a long generation, so this module
 * accepts it leniently and repairs it deterministically. Every repair is
 * reported so the UI can show what was changed.
 */
import {
  EVENT_KINDS,
  LOOP_KINDS,
  isActivity,
  isEvent,
  isGateway,
  type EventKind,
  type ExternalParticipant,
  type Flow,
  type Lane,
  type LoopKind,
  type MessageFlow,
  type NodeType,
  type ProcessModel,
  type ProcessNode,
} from './types';

export interface Repair {
  code:
    | 'laneCreated'
    | 'nodeLaneDefaulted'
    | 'flowDropped'
    | 'duplicateFlowRemoved'
    | 'selfLoopRemoved'
    | 'gatewayRemoved'
    | 'startAdded'
    | 'endAdded'
    | 'typeCoerced'
    | 'boundaryDetached'
    | 'nodeRemoved'
    | 'emptyLaneRemoved'
    | 'messageFlowDropped'
    | 'externalRemoved';
  params: Record<string, string>;
}

export interface NormalizeResult {
  model: ProcessModel;
  repairs: Repair[];
}

type Raw = Record<string, unknown>;

const TYPE_ALIASES: Record<string, NodeType> = {
  start: 'startEvent',
  startevent: 'startEvent',
  startnode: 'startEvent',
  end: 'endEvent',
  endevent: 'endEvent',
  endnode: 'endEvent',
  finish: 'endEvent',
  intermediatecatchevent: 'intermediateCatchEvent',
  intermediatecatch: 'intermediateCatchEvent',
  catchevent: 'intermediateCatchEvent',
  intermediateevent: 'intermediateCatchEvent',
  timerevent: 'intermediateCatchEvent',
  messageevent: 'intermediateCatchEvent',
  waitevent: 'intermediateCatchEvent',
  intermediatethrowevent: 'intermediateThrowEvent',
  intermediatethrow: 'intermediateThrowEvent',
  throwevent: 'intermediateThrowEvent',
  boundaryevent: 'boundaryEvent',
  boundary: 'boundaryEvent',
  task: 'task',
  abstracttask: 'task',
  activity: 'task',
  action: 'task',
  step: 'task',
  process: 'task',
  usertask: 'userTask',
  humantask: 'userTask',
  manualtask: 'manualTask',
  servicetask: 'serviceTask',
  automatedtask: 'serviceTask',
  systemtask: 'serviceTask',
  scripttask: 'scriptTask',
  businessruletask: 'businessRuleTask',
  ruletask: 'businessRuleTask',
  decisiontask: 'businessRuleTask',
  sendtask: 'sendTask',
  receivetask: 'receiveTask',
  subprocess: 'subProcess',
  embeddedsubprocess: 'subProcess',
  collapsedsubprocess: 'subProcess',
  callactivity: 'callActivity',
  exclusivegateway: 'exclusiveGateway',
  exclusive: 'exclusiveGateway',
  xor: 'exclusiveGateway',
  xorgateway: 'exclusiveGateway',
  decision: 'exclusiveGateway',
  gateway: 'exclusiveGateway',
  parallelgateway: 'parallelGateway',
  parallel: 'parallelGateway',
  and: 'parallelGateway',
  andgateway: 'parallelGateway',
  fork: 'parallelGateway',
  join: 'parallelGateway',
  inclusivegateway: 'inclusiveGateway',
  inclusive: 'inclusiveGateway',
  or: 'inclusiveGateway',
  orgateway: 'inclusiveGateway',
  eventbasedgateway: 'eventBasedGateway',
  eventgateway: 'eventBasedGateway',
  eventbased: 'eventBasedGateway',
};

const EVENT_KIND_ALIASES: Record<string, EventKind> = {
  '': 'none',
  none: 'none',
  general: 'none',
  blank: 'none',
  plain: 'none',
  default: 'none',
  message: 'message',
  msg: 'message',
  mail: 'message',
  email: 'message',
  timer: 'timer',
  time: 'timer',
  delay: 'timer',
  wait: 'timer',
  deadline: 'timer',
  error: 'error',
  exception: 'error',
  failure: 'error',
  escalation: 'escalation',
  escalate: 'escalation',
  conditional: 'conditional',
  condition: 'conditional',
  rule: 'conditional',
  signal: 'signal',
  terminate: 'terminate',
  termination: 'terminate',
};

const LOOP_ALIASES: Record<string, LoopKind> = {
  '': 'none',
  none: 'none',
  false: 'none',
  loop: 'loop',
  standard: 'loop',
  standardloop: 'loop',
  true: 'loop',
  parallel: 'parallel',
  multiinstance: 'parallel',
  multiinstanceparallel: 'parallel',
  parallelmultiinstance: 'parallel',
  sequential: 'sequential',
  multiinstancesequential: 'sequential',
  sequentialmultiinstance: 'sequential',
};

/** Event kinds BPMN permits for each event type (top-level process). */
const ALLOWED_KINDS: Partial<Record<NodeType, EventKind[]>> = {
  startEvent: ['none', 'message', 'timer', 'conditional', 'signal'],
  endEvent: ['none', 'message', 'error', 'escalation', 'signal', 'terminate'],
  intermediateCatchEvent: ['message', 'timer', 'conditional', 'signal'],
  intermediateThrowEvent: ['none', 'message', 'escalation', 'signal'],
  boundaryEvent: ['message', 'timer', 'error', 'escalation', 'conditional', 'signal'],
};

const DEFAULT_NAMES: Record<string, { start: string; end: string; lane: string }> = {
  en: { start: 'Start', end: 'End', lane: 'Process' },
  pt: { start: 'Início', end: 'Fim', lane: 'Processo' },
  es: { start: 'Inicio', end: 'Fin', lane: 'Proceso' },
  fr: { start: 'Début', end: 'Fin', lane: 'Processus' },
  de: { start: 'Start', end: 'Ende', lane: 'Prozess' },
  it: { start: 'Inizio', end: 'Fine', lane: 'Processo' },
  nl: { start: 'Start', end: 'Einde', lane: 'Proces' },
};

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function pick(raw: Raw, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function textList(value: unknown): string[] {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.includes(';') ? value.split(';') : [value];
  else return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const entry = isRecord(item) ? text(pick(item, 'name', 'label', 'text', 'title')) : text(item);
    const key = entry.toLowerCase();
    if (entry && !seen.has(key) && !/^(n\/?a|none|null|-|—)$/i.test(entry)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

class IdRegistry {
  private readonly used = new Set<string>();

  /** Returns a unique, XML-safe (NCName) id derived from `raw`. */
  claim(raw: string, prefix: string): string {
    let base = raw.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z_]+/, '');
    if (!base) base = prefix;
    let id = base;
    let counter = 2;
    while (this.used.has(id)) id = `${base}_${counter++}`;
    this.used.add(id);
    return id;
  }
}

function coerceEventKind(type: NodeType, kind: EventKind, name: string): { type: NodeType; kind: EventKind } {
  if (!isEvent(type)) return { type, kind: 'none' };
  if (type === 'intermediateCatchEvent' && kind === 'none') {
    // A catch event must wait for something; an untyped one is a milestone.
    return { type: 'intermediateThrowEvent', kind: 'none' };
  }
  if (type === 'intermediateThrowEvent' && (kind === 'timer' || kind === 'conditional')) {
    return { type: 'intermediateCatchEvent', kind };
  }
  if (type === 'boundaryEvent' && kind === 'none') {
    return { type, kind: /\d/.test(name) ? 'timer' : 'error' };
  }
  const allowed = ALLOWED_KINDS[type] ?? ['none'];
  return { type, kind: allowed.includes(kind) ? kind : allowed[0] };
}

function unwrap(raw: unknown): Raw {
  if (!isRecord(raw)) return {};
  for (const key of ['process', 'model', 'bpmn', 'result', 'data']) {
    const inner = raw[key];
    if (isRecord(inner) && (Array.isArray(inner.nodes) || Array.isArray(inner.steps))) return inner;
  }
  return raw;
}

export function normalizeModel(input: unknown): NormalizeResult {
  const raw = unwrap(input);
  const repairs: Repair[] = [];
  const ids = new IdRegistry();

  const language = text(pick(raw, 'language', 'lang', 'locale')) || 'en';
  const names = DEFAULT_NAMES[language.slice(0, 2).toLowerCase()] ?? DEFAULT_NAMES.en;
  const name = text(pick(raw, 'name', 'title', 'processName'));

  // ── Lanes ───────────────────────────────────────────────────────────────
  const lanes: Lane[] = [];
  const laneByRef = new Map<string, string>();
  const addLane = (rawId: string, laneName: string): string => {
    const id = ids.claim(rawId || `lane_${lanes.length + 1}`, 'lane');
    lanes.push({ id, name: laneName || rawId || names.lane });
    if (rawId) laneByRef.set(rawId.toLowerCase(), id);
    if (laneName) laneByRef.set(laneName.toLowerCase(), id);
    return id;
  };
  for (const entry of list(pick(raw, 'lanes', 'swimlanes', 'roles'))) {
    if (isRecord(entry)) {
      const rawId = text(pick(entry, 'id', 'key'));
      const laneName = text(pick(entry, 'name', 'label', 'title', 'role'));
      if (rawId || laneName) addLane(rawId, laneName);
    } else {
      const laneName = text(entry);
      if (laneName && !laneByRef.has(laneName.toLowerCase())) addLane('', laneName);
    }
  }

  const resolveLane = (ref: string, nodeLabel: string): string => {
    const hit = laneByRef.get(ref.toLowerCase());
    if (hit) return hit;
    if (ref) {
      repairs.push({ code: 'laneCreated', params: { name: ref } });
      return addLane('', ref);
    }
    if (lanes.length === 0) addLane('', text(pick(raw, 'pool', 'participant', 'organization')) || names.lane);
    else repairs.push({ code: 'nodeLaneDefaulted', params: { node: nodeLabel } });
    return lanes[0].id;
  };

  // ── Nodes ───────────────────────────────────────────────────────────────
  let nodes: ProcessNode[] = [];
  const nodeByRef = new Map<string, string>();
  for (const entry of list(pick(raw, 'nodes', 'steps', 'elements', 'flowNodes'))) {
    if (!isRecord(entry)) continue;
    const rawId = text(pick(entry, 'id', 'key'));
    const rawType = text(pick(entry, 'type', 'nodeType', 'bpmnType', 'kind'));
    const nodeName = text(pick(entry, 'name', 'label', 'title', 'text'));
    if (!rawId && !nodeName && !rawType) continue;

    let type: NodeType = TYPE_ALIASES[squash(rawType)] ?? 'task';
    let kind: EventKind =
      EVENT_KIND_ALIASES[squash(text(pick(entry, 'eventKind', 'eventType', 'eventDefinition', 'trigger')))] ?? 'none';
    // "timerEvent"/"messageEvent" style type names carry the kind in the type.
    if (kind === 'none') {
      const squashed = squash(rawType);
      for (const candidate of EVENT_KINDS) {
        if (candidate !== 'none' && squashed.startsWith(candidate) && squashed.includes('event')) kind = candidate;
      }
    }
    const coerced = coerceEventKind(type, kind, nodeName);
    if (coerced.type !== type) {
      repairs.push({ code: 'typeCoerced', params: { node: nodeName || rawId, from: type, to: coerced.type } });
    }
    type = coerced.type;
    kind = coerced.kind;

    const id = ids.claim(rawId || `n${nodes.length + 1}`, 'n');
    if (rawId && !nodeByRef.has(rawId.toLowerCase())) nodeByRef.set(rawId.toLowerCase(), id);
    if (nodeName && !nodeByRef.has(nodeName.toLowerCase())) nodeByRef.set(nodeName.toLowerCase(), id);

    const loop = LOOP_ALIASES[squash(text(pick(entry, 'loop', 'loopType', 'multiInstance')))] ?? 'none';
    nodes.push({
      id,
      type,
      name: nodeName,
      lane: resolveLane(
        text(pick(entry, 'lane', 'laneId', 'role', 'actor', 'performer', 'owner', 'swimlane')),
        nodeName || id,
      ),
      eventKind: kind,
      attachedTo: text(pick(entry, 'attachedTo', 'attachedToRef', 'host')),
      interrupting: bool(pick(entry, 'interrupting', 'cancelActivity'), true),
      loop: isActivity(type) && LOOP_KINDS.includes(loop) ? loop : 'none',
      description: text(pick(entry, 'description', 'documentation', 'details', 'desc')),
      systems: textList(pick(entry, 'systems', 'system', 'applications', 'tools')),
      inputs: textList(pick(entry, 'inputs', 'input')),
      outputs: textList(pick(entry, 'outputs', 'output')),
      duration: text(pick(entry, 'duration', 'time', 'cycleTime')),
      issues: textList(pick(entry, 'issues', 'painPoints', 'problems')),
    });
  }

  const resolveNode = (ref: unknown): string | undefined => nodeByRef.get(text(ref).toLowerCase());
  const nodeById = (): Map<string, ProcessNode> => new Map(nodes.map((n) => [n.id, n]));
  const label = (id: string): string => nodeById().get(id)?.name || id;

  // ── Sequence flows ──────────────────────────────────────────────────────
  let flows: Flow[] = [];
  for (const entry of list(pick(raw, 'flows', 'sequenceFlows', 'edges', 'connections', 'transitions'))) {
    if (!isRecord(entry)) continue;
    const fromRef = pick(entry, 'from', 'source', 'sourceRef', 'src');
    const toRef = pick(entry, 'to', 'target', 'targetRef', 'dst');
    const from = resolveNode(fromRef);
    const to = resolveNode(toRef);
    if (!from || !to) {
      repairs.push({ code: 'flowDropped', params: { from: text(fromRef), to: text(toRef) } });
      continue;
    }
    flows.push({
      id: ids.claim(text(pick(entry, 'id')) || `f${flows.length + 1}`, 'f'),
      from,
      to,
      label: text(pick(entry, 'label', 'name', 'condition')),
      isDefault: bool(pick(entry, 'isDefault', 'default'), false),
    });
  }

  // ── Boundary events ─────────────────────────────────────────────────────
  {
    const byId = nodeById();
    for (const node of nodes) {
      if (node.type !== 'boundaryEvent') {
        node.attachedTo = '';
        node.interrupting = true;
        continue;
      }
      const hostId = resolveNode(node.attachedTo);
      const host = hostId ? byId.get(hostId) : undefined;
      if (host && isActivity(host.type)) {
        node.attachedTo = host.id;
        node.lane = host.lane;
        if (node.eventKind === 'error') node.interrupting = true;
      } else {
        // No valid host: keep the information as a regular catch event.
        repairs.push({ code: 'boundaryDetached', params: { node: node.name || node.id } });
        node.type = 'intermediateCatchEvent';
        node.attachedTo = '';
        node.interrupting = true;
        if (!ALLOWED_KINDS.intermediateCatchEvent!.includes(node.eventKind)) node.eventKind = 'timer';
      }
    }
    const hostOf = new Map(nodes.filter((n) => n.type === 'boundaryEvent').map((n) => [n.id, n.attachedTo]));
    flows = flows.filter((flow) => {
      // Nothing flows into a boundary event, and one that points straight back
      // at its own activity is a self-loop.
      if (!hostOf.has(flow.to) && hostOf.get(flow.from) !== flow.to) return true;
      repairs.push({ code: 'flowDropped', params: { from: label(flow.from), to: label(flow.to) } });
      return false;
    });
  }

  // ── Self loops and duplicates ───────────────────────────────────────────
  const dedupe = (): void => {
    const seen = new Set<string>();
    flows = flows.filter((flow) => {
      if (flow.from === flow.to) {
        repairs.push({ code: 'selfLoopRemoved', params: { node: label(flow.from) } });
        return false;
      }
      const key = `${flow.from}\u0000${flow.to}`;
      if (seen.has(key)) {
        repairs.push({ code: 'duplicateFlowRemoved', params: { from: label(flow.from), to: label(flow.to) } });
        return false;
      }
      seen.add(key);
      return true;
    });
  };
  dedupe();

  const degree = (): { incoming: Map<string, Flow[]>; outgoing: Map<string, Flow[]> } => {
    const incoming = new Map<string, Flow[]>(nodes.map((n) => [n.id, []]));
    const outgoing = new Map<string, Flow[]>(nodes.map((n) => [n.id, []]));
    for (const flow of flows) {
      outgoing.get(flow.from)?.push(flow);
      incoming.get(flow.to)?.push(flow);
    }
    return { incoming, outgoing };
  };

  // ── Events used in the wrong position ───────────────────────────────────
  {
    const { incoming, outgoing } = degree();
    for (const node of nodes) {
      const ins = incoming.get(node.id)!.length;
      const outs = outgoing.get(node.id)!.length;
      let next: NodeType | undefined;
      if (node.type === 'startEvent' && ins > 0) {
        next = node.eventKind === 'none' ? 'intermediateThrowEvent' : 'intermediateCatchEvent';
      } else if (node.type === 'endEvent' && outs > 0) {
        next = 'intermediateThrowEvent';
      }
      if (next) {
        repairs.push({ code: 'typeCoerced', params: { node: node.name || node.id, from: node.type, to: next } });
        const coerced = coerceEventKind(next, node.eventKind, node.name);
        node.type = coerced.type;
        node.eventKind = coerced.kind;
      }
    }
  }

  // ── Gateways that neither split nor merge ───────────────────────────────
  for (let pass = 0; pass < 10; pass++) {
    const { incoming, outgoing } = degree();
    const useless = nodes.find(
      (n) => isGateway(n.type) && incoming.get(n.id)!.length <= 1 && outgoing.get(n.id)!.length <= 1,
    );
    if (!useless) break;
    const [inFlow] = incoming.get(useless.id)!;
    const [outFlow] = outgoing.get(useless.id)!;
    repairs.push({ code: 'gatewayRemoved', params: { node: useless.name || useless.id } });
    flows = flows.filter((f) => f.from !== useless.id && f.to !== useless.id);
    if (inFlow && outFlow) {
      flows.push({
        id: inFlow.id,
        from: inFlow.from,
        to: outFlow.to,
        label: inFlow.label || outFlow.label,
        isDefault: inFlow.isDefault,
      });
    }
    nodes = nodes.filter((n) => n.id !== useless.id);
    dedupe();
  }

  // ── Loose ends: every path starts at a start event and ends at an end event
  {
    let { incoming, outgoing } = degree();
    const isolatedEvents = new Set(
      nodes
        .filter(
          (n) =>
            isEvent(n.type) &&
            n.type !== 'boundaryEvent' &&
            incoming.get(n.id)!.length === 0 &&
            outgoing.get(n.id)!.length === 0,
        )
        .map((n) => n.id),
    );
    const deadBoundary = new Set(
      nodes.filter((n) => n.type === 'boundaryEvent' && outgoing.get(n.id)!.length === 0).map((n) => n.id),
    );
    for (const node of nodes) {
      if (isolatedEvents.has(node.id) || deadBoundary.has(node.id)) {
        repairs.push({ code: 'nodeRemoved', params: { node: node.name || node.id } });
      }
    }
    nodes = nodes.filter((n) => !isolatedEvents.has(n.id) && !deadBoundary.has(n.id));
    ({ incoming, outgoing } = degree());

    const added: ProcessNode[] = [];
    const blank = (id: string, type: NodeType, nodeName: string, lane: string): ProcessNode => ({
      id,
      type,
      name: nodeName,
      lane,
      eventKind: 'none',
      attachedTo: '',
      interrupting: true,
      loop: 'none',
      description: '',
      systems: [],
      inputs: [],
      outputs: [],
      duration: '',
      issues: [],
    });

    for (const node of nodes) {
      if (node.type === 'boundaryEvent') continue;
      if (incoming.get(node.id)!.length === 0 && node.type !== 'startEvent') {
        if (node.type === 'intermediateCatchEvent') {
          repairs.push({ code: 'typeCoerced', params: { node: node.name || node.id, from: node.type, to: 'startEvent' } });
          node.type = 'startEvent';
          node.eventKind = coerceEventKind('startEvent', node.eventKind, node.name).kind;
        } else {
          const start = blank(ids.claim('start_auto', 'start'), 'startEvent', names.start, node.lane);
          added.push(start);
          flows.push({ id: ids.claim('f_start_auto', 'f'), from: start.id, to: node.id, label: '', isDefault: false });
          repairs.push({ code: 'startAdded', params: { node: node.name || node.id } });
        }
      }
      if (outgoing.get(node.id)!.length === 0 && node.type !== 'endEvent') {
        if (node.type === 'intermediateThrowEvent') {
          repairs.push({ code: 'typeCoerced', params: { node: node.name || node.id, from: node.type, to: 'endEvent' } });
          node.type = 'endEvent';
          node.eventKind = coerceEventKind('endEvent', node.eventKind, node.name).kind;
        } else {
          const end = blank(ids.claim('end_auto', 'end'), 'endEvent', names.end, node.lane);
          added.push(end);
          flows.push({ id: ids.claim('f_end_auto', 'f'), from: node.id, to: end.id, label: '', isDefault: false });
          repairs.push({ code: 'endAdded', params: { node: node.name || node.id } });
        }
      }
    }
    nodes.push(...added);
  }

  // ── Default-flow markers ────────────────────────────────────────────────
  {
    const byId = nodeById();
    const hasDefault = new Set<string>();
    for (const flow of flows) {
      if (!flow.isDefault) continue;
      const source = byId.get(flow.from)!;
      const allowed =
        source.type === 'exclusiveGateway' || source.type === 'inclusiveGateway' || isActivity(source.type);
      if (!allowed || hasDefault.has(flow.from)) flow.isDefault = false;
      else hasDefault.add(flow.from);
    }
  }

  // ── External participants and message flows ─────────────────────────────
  const externalsAll: ExternalParticipant[] = [];
  const externalByRef = new Map<string, string>();
  for (const entry of list(pick(raw, 'externals', 'externalParticipants', 'blackBoxPools'))) {
    const rawId = isRecord(entry) ? text(pick(entry, 'id', 'key')) : '';
    const extName = isRecord(entry) ? text(pick(entry, 'name', 'label', 'title')) : text(entry);
    if (!rawId && !extName) continue;
    const id = ids.claim(rawId || `ext_${externalsAll.length + 1}`, 'ext');
    externalsAll.push({ id, name: extName || rawId });
    if (rawId) externalByRef.set(rawId.toLowerCase(), id);
    if (extName) externalByRef.set(extName.toLowerCase(), id);
  }
  const messageFlows: MessageFlow[] = [];
  {
    const byId = nodeById();
    const seen = new Set<string>();
    for (const entry of list(pick(raw, 'messageFlows', 'messages'))) {
      if (!isRecord(entry)) continue;
      const fromRef = text(pick(entry, 'from', 'source', 'sourceRef'));
      const toRef = text(pick(entry, 'to', 'target', 'targetRef'));
      // Externals win over nodes when a reference is ambiguous.
      const fromExt = externalByRef.get(fromRef.toLowerCase());
      const toExt = externalByRef.get(toRef.toLowerCase());
      const fromNode = fromExt ? undefined : resolveNode(fromRef);
      const toNode = toExt ? undefined : resolveNode(toRef);
      const nodeId = fromNode ?? toNode;
      const node = nodeId ? byId.get(nodeId) : undefined;
      const valid =
        ((fromExt && toNode) || (fromNode && toExt)) && node && !isGateway(node.type) && node.type !== 'boundaryEvent';
      const key = `${fromExt ?? fromNode}\u0000${toExt ?? toNode}`;
      if (!valid || seen.has(key)) {
        repairs.push({ code: 'messageFlowDropped', params: { from: fromRef, to: toRef } });
        continue;
      }
      seen.add(key);
      messageFlows.push({
        id: ids.claim(text(pick(entry, 'id')) || `m${messageFlows.length + 1}`, 'm'),
        from: (fromExt ?? fromNode)!,
        to: (toExt ?? toNode)!,
        label: text(pick(entry, 'label', 'name', 'message')),
      });
    }
  }
  const usedExternals = new Set(messageFlows.flatMap((m) => [m.from, m.to]));
  const externals = externalsAll.filter((ext) => {
    if (usedExternals.has(ext.id)) return true;
    repairs.push({ code: 'externalRemoved', params: { name: ext.name } });
    return false;
  });

  // ── Lanes that ended up empty ───────────────────────────────────────────
  const usedLanes = new Set(nodes.map((n) => n.lane));
  const keptLanes = lanes.filter((lane) => {
    if (usedLanes.has(lane.id)) return true;
    repairs.push({ code: 'emptyLaneRemoved', params: { name: lane.name } });
    return false;
  });

  const model: ProcessModel = {
    name,
    summary: text(pick(raw, 'summary', 'description', 'overview')),
    language,
    pool: text(pick(raw, 'pool', 'participant', 'organization', 'organisation')),
    lanes: keptLanes,
    nodes,
    flows,
    externals,
    messageFlows,
    assumptions: textList(pick(raw, 'assumptions')),
    openQuestions: textList(pick(raw, 'openQuestions', 'questions', 'open_questions')),
  };
  return { model, repairs };
}
