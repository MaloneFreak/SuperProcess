/**
 * BPMN 2.0 XML writer (semantic model + diagram interchange).
 *
 * The file opens in any BPMN tool: Camunda Modeler, bpmn.io, Bizagi, Signavio,
 * ARIS and others. Positions come from the layout engine, so the diagram
 * looks the same there as in SuperProcess.
 */
import type { DiagramLayout, TextBlock } from '../layout/layout';
import { indexFlows, isActivity, isGateway, type EventKind, type ProcessModel, type ProcessNode } from '../model/types';
import { escapeXml } from '../render/svg';

const EVENT_DEFINITION: Record<EventKind, string | null> = {
  none: null,
  message: 'messageEventDefinition',
  timer: 'timerEventDefinition',
  error: 'errorEventDefinition',
  escalation: 'escalationEventDefinition',
  conditional: 'conditionalEventDefinition',
  signal: 'signalEventDefinition',
  terminate: 'terminateEventDefinition',
};

// Ids created by the writer carry this prefix so they cannot collide with model ids.
const P = 'sp_';

const n = (value: number): string => String(Math.round(value * 100) / 100);

function attrs(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
}

/** Step details that have no BPMN element of their own travel as documentation. */
export function nodeDocumentation(node: ProcessNode): string {
  const lines: string[] = [];
  if (node.description) lines.push(node.description);
  if (node.systems.length > 0) lines.push(`Systems: ${node.systems.join(', ')}`);
  if (node.inputs.length > 0) lines.push(`Inputs: ${node.inputs.join(', ')}`);
  if (node.outputs.length > 0) lines.push(`Outputs: ${node.outputs.join(', ')}`);
  if (node.duration) lines.push(`Duration: ${node.duration}`);
  if (node.issues.length > 0) lines.push(`Issues: ${node.issues.join('; ')}`);
  return lines.join('\n');
}

function labelBounds(label: TextBlock | null): string {
  if (!label) return '';
  const x = label.anchor === 'middle' ? label.x - label.width / 2 : label.anchor === 'end' ? label.x - label.width : label.x;
  return `<bpmndi:BPMNLabel><dc:Bounds x="${n(x)}" y="${n(label.y)}" width="${n(label.width)}" height="${n(label.height)}"/></bpmndi:BPMNLabel>`;
}

export function exportBpmn(model: ProcessModel, layout: DiagramLayout): string {
  const { incoming, outgoing } = indexFlows(model);
  const out: string[] = [];
  const processId = `${P}Process`;
  const collaborationId = `${P}Collaboration`;
  const poolId = `${P}Participant`;

  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"' +
      ' xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"' +
      ' xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"' +
      ' xmlns:di="http://www.omg.org/spec/DD/20100524/DI"' +
      ` id="${P}Definitions" targetNamespace="https://github.com/MaloneFreak/SuperProcess"` +
      ' exporter="SuperProcess" exporterVersion="0.1.0">',
  );

  // ── Collaboration: the process pool, black-box pools, message flows ─────
  out.push(`<bpmn:collaboration id="${collaborationId}">`);
  out.push(`<bpmn:participant${attrs({ id: poolId, name: model.pool || model.name, processRef: processId })}/>`);
  for (const ext of model.externals) out.push(`<bpmn:participant${attrs({ id: ext.id, name: ext.name })}/>`);
  for (const message of model.messageFlows) {
    out.push(
      `<bpmn:messageFlow${attrs({ id: message.id, name: message.label, sourceRef: message.from, targetRef: message.to })}/>`,
    );
  }
  out.push('</bpmn:collaboration>');

  // ── Process ─────────────────────────────────────────────────────────────
  out.push(`<bpmn:process${attrs({ id: processId, name: model.name, isExecutable: 'false' })}>`);
  if (model.summary) out.push(`<bpmn:documentation>${escapeXml(model.summary)}</bpmn:documentation>`);

  out.push(`<bpmn:laneSet id="${P}LaneSet">`);
  for (const lane of model.lanes) {
    out.push(`<bpmn:lane${attrs({ id: lane.id, name: lane.name })}>`);
    for (const node of model.nodes) {
      if (node.lane === lane.id) out.push(`<bpmn:flowNodeRef>${escapeXml(node.id)}</bpmn:flowNodeRef>`);
    }
    out.push('</bpmn:lane>');
  }
  out.push('</bpmn:laneSet>');

  for (const node of model.nodes) {
    const outs = outgoing.get(node.id) ?? [];
    const defaultFlow = isGateway(node.type) || isActivity(node.type) ? outs.find((f) => f.isDefault)?.id : undefined;
    const boundary = node.type === 'boundaryEvent';
    out.push(
      `<bpmn:${node.type}${attrs({
        id: node.id,
        name: node.name,
        default: defaultFlow,
        attachedToRef: boundary ? node.attachedTo : undefined,
        cancelActivity: boundary && !node.interrupting ? 'false' : undefined,
      })}>`,
    );
    const documentation = nodeDocumentation(node);
    if (documentation) out.push(`<bpmn:documentation>${escapeXml(documentation)}</bpmn:documentation>`);
    for (const flow of incoming.get(node.id) ?? []) out.push(`<bpmn:incoming>${escapeXml(flow.id)}</bpmn:incoming>`);
    for (const flow of outs) out.push(`<bpmn:outgoing>${escapeXml(flow.id)}</bpmn:outgoing>`);
    const definition = EVENT_DEFINITION[node.eventKind];
    if (definition) out.push(`<bpmn:${definition} id="${P}def_${escapeXml(node.id)}"/>`);
    if (node.loop === 'loop') out.push('<bpmn:standardLoopCharacteristics/>');
    if (node.loop === 'parallel') out.push('<bpmn:multiInstanceLoopCharacteristics/>');
    if (node.loop === 'sequential') out.push('<bpmn:multiInstanceLoopCharacteristics isSequential="true"/>');
    out.push(`</bpmn:${node.type}>`);
  }
  for (const flow of model.flows) {
    out.push(`<bpmn:sequenceFlow${attrs({ id: flow.id, name: flow.label, sourceRef: flow.from, targetRef: flow.to })}/>`);
  }
  out.push('</bpmn:process>');

  // ── Diagram interchange ─────────────────────────────────────────────────
  const bounds = (box: { x: number; y: number; width: number; height: number }): string =>
    `<dc:Bounds x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}"/>`;

  out.push(`<bpmndi:BPMNDiagram id="${P}Diagram">`);
  out.push(`<bpmndi:BPMNPlane id="${P}Plane" bpmnElement="${collaborationId}">`);
  out.push(`<bpmndi:BPMNShape id="${P}di_pool" bpmnElement="${poolId}" isHorizontal="true">${bounds(layout.pool)}</bpmndi:BPMNShape>`);
  for (const lane of layout.lanes) {
    out.push(
      `<bpmndi:BPMNShape${attrs({ id: `${P}di_${lane.id}`, bpmnElement: lane.id, isHorizontal: 'true' })}>${bounds(lane)}</bpmndi:BPMNShape>`,
    );
  }
  for (const ext of layout.externals) {
    out.push(
      `<bpmndi:BPMNShape${attrs({ id: `${P}di_${ext.id}`, bpmnElement: ext.id, isHorizontal: 'true' })}>${bounds(ext)}</bpmndi:BPMNShape>`,
    );
  }
  for (const node of model.nodes) {
    const box = layout.nodes[node.id];
    if (!box) continue;
    out.push(
      `<bpmndi:BPMNShape${attrs({
        id: `${P}di_${node.id}`,
        bpmnElement: node.id,
        isMarkerVisible: node.type === 'exclusiveGateway' ? 'true' : undefined,
        isExpanded: node.type === 'subProcess' ? 'false' : undefined,
      })}>${bounds(box)}${isActivity(node.type) ? '' : labelBounds(box.label)}</bpmndi:BPMNShape>`,
    );
  }
  for (const edge of layout.edges) {
    const waypoints = edge.points.map((p) => `<di:waypoint x="${n(p.x)}" y="${n(p.y)}"/>`).join('');
    out.push(
      `<bpmndi:BPMNEdge${attrs({ id: `${P}di_${edge.id}`, bpmnElement: edge.id })}>${waypoints}${labelBounds(edge.label)}</bpmndi:BPMNEdge>`,
    );
  }
  out.push('</bpmndi:BPMNPlane>');
  out.push('</bpmndi:BPMNDiagram>');
  out.push('</bpmn:definitions>');
  return out.join('\n');
}
