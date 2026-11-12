/**
 * Reads a BPMN 2.0 XML file into a compact description of its pools, lanes,
 * nodes and flows. The description is handed to the AI, which keeps the
 * structure while fixing rule violations and enriching it from transcripts.
 */
import { child, children, clean, descendants, parseXml } from './xml';

export interface BpmnSketchNode {
  id: string;
  type: string;
  name: string;
  lane: string;
  eventKind?: string;
  attachedTo?: string;
  interrupting?: boolean;
  loop?: string;
  documentation?: string;
}

export interface BpmnSketch {
  format: 'bpmn';
  pools: {
    name: string;
    blackBox: boolean;
    lanes: { id: string; name: string }[];
    nodes: BpmnSketchNode[];
    flows: { from: string; to: string; label?: string; isDefault?: boolean }[];
  }[];
  messageFlows: { from: string; to: string; label?: string }[];
  notes: string[];
}

const NODE_NAMES = new Set([
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
  'transaction',
  'adHocSubProcess',
  'callActivity',
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
]);

export function importBpmn(source: string): BpmnSketch {
  const doc = parseXml(source);
  const root = doc.documentElement;
  if (root.localName !== 'definitions') throw new Error('Not a BPMN 2.0 file: <definitions> element not found.');

  const sketch: BpmnSketch = { format: 'bpmn', pools: [], messageFlows: [], notes: [] };
  const participants = descendants(root, 'participant');
  const poolNameByProcess = new Map<string, string>();
  for (const participant of participants) {
    const ref = participant.getAttribute('processRef');
    const name = clean(participant.getAttribute('name'));
    if (ref) poolNameByProcess.set(ref, name);
    else sketch.pools.push({ name: name || participant.getAttribute('id') || '', blackBox: true, lanes: [], nodes: [], flows: [] });
  }
  // Message flows may point at a participant: refer to it by name.
  const participantName = new Map(
    participants.map((p) => [p.getAttribute('id') ?? '', clean(p.getAttribute('name')) || p.getAttribute('id') || '']),
  );

  for (const process of children(root, 'process')) {
    const id = process.getAttribute('id') ?? '';
    const pool: BpmnSketch['pools'][number] = {
      name: poolNameByProcess.get(id) || clean(process.getAttribute('name')) || id,
      blackBox: false,
      lanes: [],
      nodes: [],
      flows: [],
    };

    const laneOf = new Map<string, string>();
    const readLanes = (parent: Element, prefix: string): void => {
      for (const laneSet of [...children(parent, 'laneSet'), ...children(parent, 'childLaneSet')]) {
        for (const lane of children(laneSet, 'lane')) {
          const laneId = lane.getAttribute('id') ?? '';
          const name = prefix + (clean(lane.getAttribute('name')) || laneId);
          const nested = children(lane, 'childLaneSet').length > 0;
          if (!nested) pool.lanes.push({ id: laneId, name });
          for (const ref of children(lane, 'flowNodeRef')) laneOf.set(clean(ref.textContent), laneId);
          readLanes(lane, `${name} / `);
        }
      }
    };
    readLanes(process, '');

    const defaults = new Set<string>();
    const readNodes = (parent: Element): void => {
      for (const element of children(parent)) {
        const type = element.localName;
        if (type === 'textAnnotation') {
          const note = clean(child(element, 'text')?.textContent);
          if (note) sketch.notes.push(note);
        } else if (NODE_NAMES.has(type)) {
          const nodeId = element.getAttribute('id') ?? '';
          const definition = children(element).find((c) => c.localName.endsWith('EventDefinition'));
          const multi = child(element, 'multiInstanceLoopCharacteristics');
          const node: BpmnSketchNode = {
            id: nodeId,
            type: type === 'transaction' || type === 'adHocSubProcess' ? 'subProcess' : type === 'complexGateway' ? 'inclusiveGateway' : type,
            name: clean(element.getAttribute('name')),
            lane: laneOf.get(nodeId) ?? '',
          };
          if (definition) node.eventKind = definition.localName.replace('EventDefinition', '');
          if (type === 'boundaryEvent') {
            node.attachedTo = element.getAttribute('attachedToRef') ?? '';
            node.interrupting = element.getAttribute('cancelActivity') !== 'false';
          }
          if (multi) node.loop = multi.getAttribute('isSequential') === 'true' ? 'sequential' : 'parallel';
          else if (child(element, 'standardLoopCharacteristics')) node.loop = 'loop';
          const documentation = clean(child(element, 'documentation')?.textContent);
          if (documentation) node.documentation = documentation;
          const defaultFlow = element.getAttribute('default');
          if (defaultFlow) defaults.add(defaultFlow);
          pool.nodes.push(node);
        }
      }
    };
    // Default flows are declared on their gateway, so nodes are read before flows.
    readNodes(process);
    for (const element of children(process, 'sequenceFlow')) {
      pool.flows.push({
        from: element.getAttribute('sourceRef') ?? '',
        to: element.getAttribute('targetRef') ?? '',
        label: clean(element.getAttribute('name')) || undefined,
        isDefault: defaults.has(element.getAttribute('id') ?? '') || undefined,
      });
    }
    sketch.pools.push(pool);
  }

  for (const message of descendants(root, 'messageFlow')) {
    const from = message.getAttribute('sourceRef') ?? '';
    const to = message.getAttribute('targetRef') ?? '';
    sketch.messageFlows.push({
      from: participantName.get(from) ?? from,
      to: participantName.get(to) ?? to,
      label: clean(message.getAttribute('name')) || undefined,
    });
  }

  if (sketch.pools.every((pool) => pool.nodes.length === 0)) {
    throw new Error('The BPMN file contains no process steps.');
  }
  return sketch;
}
