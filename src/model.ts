import type { JsonValue } from '@rxjs-rsl/synchronous-evaluator-adapter';

export const PROFILE = 'rxjs-red.graph/0.1' as const;
export const OPERATIONS = ['values', 'interval', 'map', 'filter', 'scan', 'take', 'delay', 'debounceTime', 'switchMap', 'combineLatest', 'shareReplay', 'sink'] as const;
export type Operation = typeof OPERATIONS[number];
export type Port = Readonly<{ name: string; from: string }>;
export type GraphNode = Readonly<{
  id: string;
  role: 'Source' | 'Pipeline' | 'Sink';
  operation: Operation;
  inputs: readonly Port[];
  parameters: Readonly<Record<string, JsonValue>>;
}>;
export type Layout = Readonly<{ x: number; y: number; name: string }>;
export type Graph = Readonly<{
  profile: typeof PROFILE;
  id: string;
  name: string;
  clock: Readonly<{ id: 'rsl-clock'; unit: 'ms' }>;
  nodes: readonly GraphNode[];
  editor?: Readonly<{ nodes: Readonly<Record<string, Layout>>; inputs: Readonly<Record<string, Layout & { id: string }>> }>;
}>;
export type EditorNode = {
  id: string; type: string; z?: string; name?: string; label?: string;
  x?: number; y?: number; wires?: string[][]; d?: boolean; disabled?: boolean;
  [key: string]: unknown;
};

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertJson(value: unknown, depth = 0): asserts value is JsonValue {
  invariant(depth <= 64, 'JSON exceeds maximum depth 64');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'JSON numbers must be finite'); return; }
  if (Array.isArray(value)) { for (const item of value) assertJson(item, depth + 1); return; }
  invariant(isRecord(value) && Object.getPrototypeOf(value) === Object.prototype, 'Expected portable JSON data');
  for (const [key, item] of Object.entries(value)) {
    invariant(!['__proto__', 'prototype', 'constructor'].includes(key), 'Reserved property: ' + key);
    assertJson(item, depth + 1);
  }
}

export function validateGraph(value: unknown): Graph {
  assertJson(value);
  invariant(isRecord(value) && value.profile === PROFILE, 'Expected profile ' + PROFILE);
  invariant(typeof value.id === 'string' && /^[A-Za-z0-9_-]+$/.test(value.id), 'Invalid graph id');
  invariant(typeof value.name === 'string', 'Graph name is required');
  invariant(isRecord(value.clock) && value.clock.id === 'rsl-clock' && value.clock.unit === 'ms', 'Clock must be rsl-clock in ms');
  invariant(Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.length <= 256, 'Use 1–256 nodes');
  const nodes = new Map<string, GraphNode>();
  for (const candidate of value.nodes) {
    invariant(isRecord(candidate), 'Expected node object');
    invariant(typeof candidate.id === 'string' && /^[A-Za-z0-9_-]+$/.test(candidate.id) && !nodes.has(candidate.id), 'Invalid or duplicate node id');
    invariant(OPERATIONS.includes(candidate.operation as Operation), 'Unsupported operation: ' + candidate.operation);
    invariant(isRecord(candidate.parameters) && Array.isArray(candidate.inputs), 'Node parameters and inputs are required');
    const node = candidate as unknown as GraphNode;
    const role = ['values', 'interval'].includes(node.operation) ? 'Source' : node.operation === 'sink' ? 'Sink' : 'Pipeline';
    invariant(node.role === role, node.id + ': role does not match operation');
    const expected = node.role === 'Source' ? 0 : node.operation === 'combineLatest' ? -1 : 1;
    invariant(expected === -1 ? node.inputs.length >= 2 : node.inputs.length === expected, node.id + ': invalid input count');
    const names = new Set<string>();
    for (const port of node.inputs) {
      invariant(isRecord(port) && typeof port.name === 'string' && /^[A-Za-z0-9_-]+$/.test(port.name) && typeof port.from === 'string' && !names.has(port.name), node.id + ': invalid or duplicate input name');
      names.add(port.name);
    }
    if (node.operation === 'combineLatest') invariant(node.inputs.every((p, i) => i === 0 || node.inputs[i - 1]!.name < p.name), node.id + ': combineLatest input names must be sorted by code point');
    nodes.set(node.id, node);
  }
  invariant([...nodes.values()].some(n => n.role === 'Source'), 'At least one Source is required');
  invariant([...nodes.values()].some(n => n.role === 'Sink'), 'At least one Sink is required');
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(id: string): void {
    invariant(!visiting.has(id), 'Cycles are not admitted: ' + id);
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes.get(id)!;
    for (const input of node.inputs) {
      const upstream = nodes.get(input.from);
      invariant(upstream && upstream.role !== 'Sink', id + ': input must reference a Source or Pipeline');
      visit(input.from);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const node of nodes.values()) if (node.role === 'Sink') visit(node.id);
  invariant(visited.size === nodes.size, 'Every node must contribute to a Sink');
  if (value.editor !== undefined) {
    invariant(isRecord(value.editor) && isRecord(value.editor.nodes) && isRecord(value.editor.inputs), 'Invalid editor metadata');
    for (const layout of [...Object.values(value.editor.nodes), ...Object.values(value.editor.inputs)]) {
      invariant(isRecord(layout) && typeof layout.x === 'number' && typeof layout.y === 'number' && typeof layout.name === 'string', 'Invalid node layout');
    }
  }
  return structuredClone(value) as unknown as Graph;
}
