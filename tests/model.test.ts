import { describe, expect, it } from 'vitest';
import { normalizeModel } from '../src/core/model/normalize';
import { computeStats } from '../src/core/model/stats';
import { validateModel } from '../src/core/model/validate';
import { purchaseRaw, tangledRaw } from './fixtures/models';

const codes = (raw: unknown): string[] => validateModel(normalizeModel(raw).model).issues.map((i) => i.code);

describe('normalizeModel', () => {
  it('accepts aliased fields, type names and lanes referenced by name', () => {
    const { model, repairs } = normalizeModel({
      process: {
        title: 'Refund',
        steps: [
          { key: 'A', kind: 'Start', label: 'Refund requested', role: 'Agent' },
          { key: 'B', nodeType: 'USER_TASK', title: 'Check order', actor: 'Agent', tools: 'CRM; ERP' },
          { key: 'C', type: 'decision', text: 'Eligible?', performer: 'Agent' },
          { key: 'D', type: 'Service Task', name: 'Refund payment', swimlane: 'Finance' },
          { key: 'E', type: 'end', name: 'Refund paid', lane: 'Finance' },
          { key: 'F', type: 'end', name: 'Refund denied', lane: 'Agent' },
        ],
        edges: [
          { source: 'A', target: 'B' },
          { src: 'B', dst: 'C' },
          { sourceRef: 'C', targetRef: 'D', condition: 'Yes' },
          { from: 'C', to: 'F', name: 'No' },
          { from: 'Refund payment', to: 'E' },
        ],
      },
    });
    expect(model.name).toBe('Refund');
    expect(model.lanes.map((l) => l.name)).toEqual(['Agent', 'Finance']);
    expect(model.nodes.map((n) => n.type)).toEqual(['startEvent', 'userTask', 'exclusiveGateway', 'serviceTask', 'endEvent', 'endEvent']);
    expect(model.nodes[1].systems).toEqual(['CRM', 'ERP']);
    expect(model.flows).toHaveLength(5);
    expect(model.flows[2].label).toBe('Yes');
    expect(repairs.filter((r) => r.code === 'laneCreated')).toHaveLength(2);
    expect(validateModel(model).counts.error).toBe(0);
  });

  it('adds missing start and end events and drops dangling flows', () => {
    const { model, repairs } = normalizeModel({
      lanes: ['Ops'],
      nodes: [
        { id: 'a', type: 'task', name: 'Do A', lane: 'Ops' },
        { id: 'b', type: 'task', name: 'Do B', lane: 'Ops' },
      ],
      flows: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'ghost' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'a' },
      ],
    });
    expect(model.nodes.map((n) => n.type)).toEqual(['task', 'task', 'startEvent', 'endEvent']);
    expect(model.flows).toHaveLength(3);
    expect(repairs.map((r) => r.code).sort()).toEqual(['duplicateFlowRemoved', 'endAdded', 'flowDropped', 'selfLoopRemoved', 'startAdded']);
    expect(validateModel(model).counts.error).toBe(0);
  });

  it('names generated events in the model language', () => {
    const { model } = normalizeModel({
      language: 'pt-BR',
      nodes: [{ id: 'a', type: 'task', name: 'Conferir nota', lane: 'Fiscal' }],
    });
    expect(model.nodes.filter((n) => n.type !== 'task').map((n) => n.name)).toEqual(['Início', 'Fim']);
  });

  it('removes gateways that neither split nor merge and bridges their flows', () => {
    const { model } = normalizeModel({
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L' },
        { id: 'g', type: 'exclusiveGateway', lane: 'L' },
        { id: 't', type: 'task', name: 'T', lane: 'L' },
        { id: 'e', type: 'endEvent', lane: 'L' },
      ],
      flows: [
        { from: 's', to: 'g' },
        { from: 'g', to: 't', label: 'always' },
        { from: 't', to: 'e' },
      ],
    });
    expect(model.nodes.map((n) => n.id)).toEqual(['s', 't', 'e']);
    expect(model.flows).toContainEqual(expect.objectContaining({ from: 's', to: 't', label: 'always' }));
  });

  it('fixes events used in the wrong place and invalid event kinds', () => {
    const { model } = normalizeModel({
      nodes: [
        { id: 's', type: 'startEvent', eventKind: 'error', lane: 'L' },
        { id: 'w', type: 'intermediateCatchEvent', lane: 'L', name: 'Milestone' },
        { id: 'x', type: 'endEvent', eventKind: 'timer', lane: 'L' },
        { id: 't', type: 'task', name: 'T', lane: 'L' },
        { id: 'b', type: 'boundaryEvent', attachedTo: 'nowhere', lane: 'L', name: 'Lost' },
        { id: 'e', type: 'endEvent', lane: 'L' },
      ],
      flows: [
        { from: 's', to: 'w' },
        { from: 'w', to: 'x' },
        { from: 'x', to: 't' },
        { from: 't', to: 'e' },
        { from: 'b', to: 'e' },
      ],
    });
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    expect(byId.get('s')?.eventKind).toBe('none');
    expect(byId.get('w')?.type).toBe('intermediateThrowEvent');
    expect(byId.get('x')?.type).toBe('intermediateThrowEvent');
    // A boundary event without a host becomes a start of its own path.
    expect(byId.get('b')?.type).toBe('startEvent');
    expect(validateModel(model).counts.error).toBe(0);
  });

  it('keeps only message flows between a step and an external party', () => {
    const { model, repairs } = normalizeModel({
      ...purchaseRaw,
      externals: [...purchaseRaw.externals, { id: 'bank', name: 'Bank' }],
      messageFlows: [...purchaseRaw.messageFlows, { from: 't1', to: 't2' }, { from: 'sup', to: 'g1' }],
    });
    expect(model.messageFlows).toHaveLength(3);
    expect(model.externals.map((e) => e.name)).toEqual(['Supplier']);
    expect(repairs.filter((r) => r.code === 'messageFlowDropped')).toHaveLength(2);
    expect(repairs).toContainEqual({ code: 'externalRemoved', params: { name: 'Bank' } });
  });

  it('produces XML-safe unique ids', () => {
    const { model } = normalizeModel({
      nodes: [
        { id: '1 start', type: 'startEvent', lane: 'A B' },
        { id: '1 start', type: 'task', name: 'X', lane: 'A B' },
        { id: 'fim#', type: 'endEvent', lane: 'A B' },
      ],
      flows: [{ from: '1 start', to: 'fim#' }],
    });
    const ids = [...model.nodes.map((n) => n.id), ...model.lanes.map((l) => l.id), ...model.flows.map((f) => f.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_][\w.-]*$/);
  });

  it('survives garbage', () => {
    for (const input of [null, 42, 'text', [], { nodes: 'nope' }, { nodes: [null, 3, {}] }]) {
      const { model } = normalizeModel(input);
      expect(model.nodes).toHaveLength(0);
    }
  });
});

describe('validateModel', () => {
  it('passes the well-formed samples', () => {
    for (const raw of [purchaseRaw, tangledRaw]) {
      const result = validateModel(normalizeModel(raw).model);
      expect(result.counts.error, JSON.stringify(result.issues)).toBe(0);
      expect(result.score).toBeGreaterThanOrEqual(85);
    }
  });

  it('flags modelling mistakes', () => {
    const raw = {
      lanes: ['L'],
      nodes: [
        { id: 's', type: 'startEvent', name: 'Go', lane: 'L' },
        { id: 't', type: 'task', name: 'Work', lane: 'L' },
        { id: 'u', type: 'task', name: '', lane: 'L' },
        { id: 'v', type: 'task', name: 'Other', lane: 'L' },
        { id: 'g', type: 'exclusiveGateway', name: '', lane: 'L' },
        { id: 'p', type: 'parallelGateway', lane: 'L' },
        { id: 'e', type: 'endEvent', name: 'Done', lane: 'L' },
      ],
      flows: [
        { from: 's', to: 't' },
        { from: 't', to: 'u' },
        { from: 't', to: 'v' },
        { from: 'u', to: 'g' },
        { from: 'v', to: 'g' },
        { from: 'g', to: 'p' },
        { from: 'g', to: 'e' },
        { from: 'p', to: 'e', label: 'x' },
        { from: 'p', to: 't', label: 'y' },
      ],
    };
    expect(codes(raw)).toEqual(
      expect.arrayContaining(['implicitSplit', 'unnamedActivity', 'gatewayMixed', 'splitFlowsUnlabeled', 'splitUnnamed', 'parallelFlowLabeled', 'implicitMerge']),
    );
  });

  it('detects parts that can never finish', () => {
    const raw = {
      lanes: ['L'],
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L', name: 'Go' },
        { id: 'a', type: 'task', name: 'A', lane: 'L' },
        { id: 'b', type: 'task', name: 'B', lane: 'L' },
        { id: 'g', type: 'exclusiveGateway', name: 'Q?', lane: 'L' },
        { id: 'e', type: 'endEvent', lane: 'L', name: 'End' },
      ],
      flows: [
        { from: 's', to: 'g' },
        { from: 'g', to: 'e', label: 'yes' },
        { from: 'g', to: 'a', label: 'no' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(codes(raw)).toContain('cannotReachEnd');
  });
});

describe('computeStats', () => {
  it('counts the facts of the purchase process', () => {
    const stats = computeStats(normalizeModel(purchaseRaw).model);
    expect(stats).toMatchObject({
      activities: 10,
      gateways: 5,
      lanes: 4,
      externals: 1,
      decisions: 2,
      parallelSplits: 1,
      loops: 2,
      automatedSteps: 1,
      messageExchanges: 3,
      stepsWithIssues: 1,
    });
    expect(stats.systems).toEqual(['E-mail', 'ERP', 'Spreadsheet']);
    expect(stats.handoffs).toBeGreaterThan(4);
  });
});
