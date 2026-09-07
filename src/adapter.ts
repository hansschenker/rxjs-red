import { parseExpressionDocument, type JsonValue } from '@rxjs-rsl/synchronous-evaluator-adapter';
import { stringify, parseDocument, visit, isMap } from 'yaml';
import { PROFILE, invariant, assertJson, validateGraph, type EditorNode, type Graph, type GraphNode, type Layout, type Operation } from './model.js';

export const EDITOR_TYPES: Record<string, Operation> = {
  'rsl-map': 'map', 'rsl-filter': 'filter', 'rsl-scan': 'scan', 'rsl-take': 'take',
  'rsl-delay': 'delay', 'rsl-debounce-time': 'debounceTime', 'rsl-switch-map': 'switchMap',
  'rsl-combine-latest': 'combineLatest', 'rsl-share-replay': 'shareReplay', 'rsl-sink': 'sink',
};
const FIELDS: Record<Operation, readonly string[]> = {
  values: ['values', 'periodMs', 'valueType'], interval: ['periodMs', 'count'],
  map: ['expression', 'valueType'], filter: ['expression'], scan: ['expression', 'seed', 'valueType'],
  take: ['count'], delay: ['durationMs'], debounceTime: ['durationMs'],
  switchMap: ['worker', 'expression', 'durationMs', 'valueType'], combineLatest: [], shareReplay: [], sink: [],
};
const NUMERIC = new Set(['periodMs', 'count', 'durationMs']);
const layoutOf = (node: EditorNode): Layout => ({ x: Number(node.x ?? 200), y: Number(node.y ?? 100), name: node.name ?? '' });

export function fromNodeRed(raw: unknown, flowId?: string): Graph {
  invariant(Array.isArray(raw), 'Node-RED export must be an array');
  const all = raw as EditorNode[];
  invariant(all.every(n => n && typeof n.id === 'string' && typeof n.type === 'string'), 'Invalid Node-RED node');
  invariant(new Set(all.map(n => n.id)).size === all.length, 'Duplicate Node-RED IDs');
  const tabs = all.filter(n => n.type === 'tab');
  const tab = flowId ? tabs.find(n => n.id === flowId) : tabs.length === 1 ? tabs[0] : undefined;
  invariant(tab && !tab.disabled, 'Choose one enabled flow tab');
  const members = all.filter(n => n.z === tab.id);
  invariant(members.every(n => !n.d && (n.type === 'comment' || n.type === 'group' || n.type === 'rsl-source' || n.type === 'rsl-input' || n.type in EDITOR_TYPES)), 'The selected tab must contain enabled RSL nodes only (comments/groups are allowed)');
  const live = members.filter(n => n.type !== 'comment' && n.type !== 'group');
  const byId = new Map(live.map(n => [n.id, n]));
  const incoming = new Map<string, EditorNode[]>();
  for (const node of live) {
    invariant(Array.isArray(node.wires) && node.wires.length <= 1, node.id + ': only one output is supported');
    if (node.type === 'rsl-sink') invariant(node.wires.flat().length === 0, 'A Sink cannot have outputs');
    for (const id of node.wires.flat()) {
      invariant(byId.has(id), node.id + ': wire leaves the RSL graph');
      incoming.set(id, [...(incoming.get(id) ?? []), node]);
    }
  }
  const nodeLayouts: Record<string, Layout> = {};
  const inputLayouts: Record<string, Layout & { id: string }> = {};
  const usedInputs = new Set<string>();
  const nodes: GraphNode[] = live.filter(n => n.type !== 'rsl-input').map(node => {
    const operation: Operation = node.type === 'rsl-source' ? node.sourceKind as Operation : EDITOR_TYPES[node.type]!;
    invariant(operation in FIELDS && (node.type !== 'rsl-source' || operation === 'values' || operation === 'interval'), 'Invalid source kind');
    const upstream = incoming.get(node.id) ?? [];
    const inputs = upstream.map(source => {
      if (operation === 'combineLatest') {
        invariant(source.type === 'rsl-input', node.id + ': connect each stream through a named RSL Input node');
        const feeds = incoming.get(source.id) ?? [];
        invariant(feeds.length === 1 && feeds[0]!.type !== 'rsl-input', source.id + ': needs exactly one stream');
        invariant(source.wires?.flat().length === 1, source.id + ': input adapter must feed exactly one combineLatest');
        const name = String(source.port ?? '');
        inputLayouts[node.id + '/' + name] = { ...layoutOf(source), id: source.id };
        usedInputs.add(source.id);
        return { name, from: feeds[0]!.id };
      }
      invariant(source.type !== 'rsl-input', 'RSL Input adapters feed combineLatest only');
      return { name: 'input', from: source.id };
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const parameters: Record<string, JsonValue> = {};
    for (const key of FIELDS[operation]) {
      let value = node[key];
      if (key === 'seed' || key === 'values') {
        if (typeof value === 'string') value = JSON.parse(value);
      } else if (NUMERIC.has(key)) {
        value = key === 'count' && operation === 'interval' && (value === '' || value == null) ? null : Number(value);
      }
      invariant(value !== undefined, node.id + ': missing ' + key);
      assertJson(value);
      parameters[key] = value;
    }
    nodeLayouts[node.id] = layoutOf(node);
    return { id: node.id, role: operation === 'values' || operation === 'interval' ? 'Source' : operation === 'sink' ? 'Sink' : 'Pipeline', operation, inputs, parameters };
  });
  invariant(live.filter(n => n.type === 'rsl-input').every(n => usedInputs.has(n.id)), 'Unused RSL Input adapter');
  return validateGraph({ profile: PROFILE, id: tab.id, name: tab.label ?? 'RSL flow', clock: { id: 'rsl-clock', unit: 'ms' }, nodes, editor: { nodes: nodeLayouts, inputs: inputLayouts } });
}

export function toNodeRed(input: unknown): EditorNode[] {
  const graph = validateGraph(input);
  const output: EditorNode[] = [{ id: graph.id, type: 'tab', label: graph.name, disabled: false, info: 'RSL graph. Open the RSL sidebar to run or export.' }];
  const usedIds = new Set([graph.id, ...graph.nodes.map(n => n.id)]);
  invariant(usedIds.size === graph.nodes.length + 1, 'Graph ID collides with a node ID');
  graph.nodes.forEach((node, index) => {
    const type = node.role === 'Source' ? 'rsl-source' : Object.keys(EDITOR_TYPES).find(key => EDITOR_TYPES[key] === node.operation)!;
    const params = { ...node.parameters } as Record<string, unknown>;
    for (const key of ['values', 'seed']) if (key in params) params[key] = JSON.stringify(params[key]);
    output.push({ id: node.id, type, z: graph.id, ...params, ...(node.role === 'Source' ? { sourceKind: node.operation } : {}), ...graph.editor?.nodes[node.id], name: graph.editor?.nodes[node.id]?.name ?? node.operation, x: graph.editor?.nodes[node.id]?.x ?? 150 + index % 4 * 210, y: graph.editor?.nodes[node.id]?.y ?? 100 + Math.floor(index / 4) * 120, wires: node.role === 'Sink' ? [] : [[]] });
  });
  const byId = new Map(output.map(n => [n.id, n]));
  graph.nodes.forEach(node => node.inputs.forEach((port, index) => {
    let target = node.id;
    if (node.operation === 'combineLatest') {
      const layout = graph.editor?.inputs[node.id + '/' + port.name];
      target = layout?.id ?? node.id + '_input_' + index;
      invariant(typeof target === 'string' && /^[A-Za-z0-9_-]+$/.test(target) && !usedIds.has(target), 'Input adapter ID collision');
      usedIds.add(target);
      output.push({ id: target, type: 'rsl-input', z: graph.id, port: port.name, name: layout?.name ?? port.name, x: layout?.x ?? Number(byId.get(node.id)!.x) - 140, y: layout?.y ?? Number(byId.get(node.id)!.y) + index * 60, wires: [[node.id]] });
    }
    byId.get(port.from)!.wires![0]!.push(target);
  }));
  return output;
}

export function parseGraph(source: string, format: 'json' | 'yaml'): Graph {
  const parsed = parseExpressionDocument(source, 'workflow.' + format, format);
  // The editor transport profile additionally admits {} for empty parameter
  // records and literal packages. The canonical expression parser is unchanged.
  if (format === 'yaml' && parsed.diagnostics.length && parsed.diagnostics.every(d => d.message === 'Use a block mapping in deterministic YAML')) {
    const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true });
    visit(document, (_key, node) => { if (isMap(node) && node.flow) invariant(node.items.length === 0, 'Use a block mapping in deterministic YAML'); });
    return validateGraph(document.toJS({ maxAliasCount: 0 }));
  }
  invariant(parsed.diagnostics.length === 0, parsed.diagnostics.map(d => d.message).join('; '));
  return validateGraph(parsed.document);
}
export function serializeGraph(graph: Graph, format: 'json' | 'yaml'): string {
  return format === 'json' ? JSON.stringify(graph, null, 2) + '\n' : stringify(graph, { defaultStringType: 'QUOTE_DOUBLE', lineWidth: 0, aliasDuplicateObjects: false });
}
