import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fromNodeRed, toNodeRed, serializeGraph, parseGraph } from '../dist/adapter.js';
import { compileGraph } from '../dist/compiler.js';
const load = async name => JSON.parse(await readFile(new URL('../examples/' + name, import.meta.url), 'utf8'));

test('all examples round-trip through editor JSON and deterministic RSL JSON/YAML', async () => {
  for (const filename of await readdir(new URL('../examples/', import.meta.url))) {
    if (!filename.endsWith('.json')) continue;
    const flows = await load(filename); const graph = fromNodeRed(flows);
    compileGraph(graph);
    assert.deepEqual(fromNodeRed(toNodeRed(graph)), graph, filename);
    for (const format of ['json', 'yaml']) assert.deepEqual(parseGraph(serializeGraph(graph, format), format), graph, filename + ':' + format);
  }
});

test('named inputs retain their canvas coordinates, IDs, and logical names', async () => {
  const flows = await load('04-combine.json');
  const adapter = flows.find(n => n.type === 'rsl-input'); adapter.x = 333; adapter.y = 444; adapter.name = 'Account stream';
  const converted = toNodeRed(fromNodeRed(flows));
  const restored = converted.find(n => n.id === adapter.id);
  assert.equal(restored.x, 333); assert.equal(restored.y, 444); assert.equal(restored.name, 'Account stream'); assert.equal(restored.port, adapter.port);
});

test('ambiguous inputs, unsupported nodes, disabled nodes, and duplicate IDs fail validation', async () => {
  const original = await load('04-combine.json');
  const duplicateName = structuredClone(original); duplicateName.filter(n => n.type === 'rsl-input')[1].port = 'a';
  assert.throws(() => fromNodeRed(duplicateName), /duplicate input/);
  const noAdapter = structuredClone(original); noAdapter.find(n => n.id === 'numbers').wires = [['latest-pair']];
  assert.throws(() => fromNodeRed(noAdapter), /named RSL Input/);
  const unsupported = await load('01-values.json'); unsupported[1].type = 'function';
  assert.throws(() => fromNodeRed(unsupported), /enabled RSL/);
  const disabled = await load('01-values.json'); disabled[1].d = true;
  assert.throws(() => fromNodeRed(disabled), /enabled RSL/);
  assert.throws(() => fromNodeRed([...original, original[1]]), /Duplicate/);
});

test('document parser rejects duplicate keys and YAML aliases', () => {
  assert.throws(() => parseGraph('{"id":"a","id":"b"}', 'json'), /unique|same|keys/i);
  assert.throws(() => parseGraph('a: &a 1\nb: *a\n', 'yaml'), /Aliases|anchors/);
});

test('graph YAML permits empty literal objects without admitting nonempty flow mappings', async () => {
  const value = fromNodeRed(await load('01-values.json'));
  value.nodes[0].parameters.values = [{}, []]; value.nodes[0].parameters.valueType = 'json';
  assert.deepEqual(parseGraph(serializeGraph(value, 'yaml'), 'yaml'), value);
  assert.throws(() => parseGraph('profile: "rxjs-red.graph/0.1"\nclock: {id: "rsl-clock"}\nparameters: {}\n', 'yaml'), /block mapping/);
});
