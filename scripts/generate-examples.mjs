import { mkdir, writeFile } from 'node:fs/promises';
import { toNodeRed } from '../dist/adapter.js';
const directory = new URL('../examples/', import.meta.url);
await mkdir(directory, { recursive: true });
function node(id, operation, parameters, from) {
  return { id, role: ['values', 'interval'].includes(operation) ? 'Source' : operation === 'sink' ? 'Sink' : 'Pipeline', operation, parameters, inputs: from ? [{ name: 'input', from }] : [] };
}
async function save(filename, name, nodes) {
  const graph = { profile: 'rxjs-red.graph/0.1', id: filename.replace('.json', ''), name, clock: { id: 'rsl-clock', unit: 'ms' }, nodes };
  await writeFile(new URL(filename, directory), JSON.stringify(toNodeRed(graph), null, 2) + '\n');
}
const source = (id, periodMs = 0) => node(id, 'values', { values: [1, 2, 3, 4, 5], periodMs, valueType: 'number' });
await save('01-values.json', '01 · Values — map and filter', [source('values-source'), node('double', 'map', { expression: '{% $notification.value * 2 %}', valueType: 'number' }, 'values-source'), node('greater-than-six', 'filter', { expression: '{% $notification.value > 6 %}' }, 'double'), node('values-sink', 'sink', {}, 'greater-than-six')]);
await save('02-memory.json', '02 · Remembered state', [source('memory-source', 200), node('running-total', 'scan', { expression: '{% $state.total + $notification.value %}', seed: 0, valueType: 'number' }, 'memory-source'), node('memory-sink', 'sink', {}, 'running-total')]);
await save('03-latest.json', '03 · Only the latest inner', [source('latest-source', 80), node('latest-result', 'switchMap', { worker: 'delayedValue', expression: '{% $notification.value * 10 %}', durationMs: 150, valueType: 'number' }, 'latest-source'), node('latest-sink', 'sink', {}, 'latest-result')]);
await save('04-combine.json', '04 · Two named inputs', [node('numbers', 'values', { values: [1, 2, 3], periodMs: 300, valueType: 'number' }), node('letters', 'values', { values: ['a', 'b', 'c'], periodMs: 450, valueType: 'string' }), { ...node('latest-pair', 'combineLatest', {}), inputs: [{ name: 'a', from: 'numbers' }, { name: 'b', from: 'letters' }] }, node('combine-sink', 'sink', {}, 'latest-pair')]);
await save('05-sharing.json', '05 · Explicit sharing to two sinks', [node('shared-source', 'interval', { periodMs: 150, count: 5 }), node('replay-one', 'shareReplay', {}, 'shared-source'), node('sink-a', 'sink', {}, 'replay-one'), node('sink-b', 'sink', {}, 'replay-one')]);
await save('06-debounce.json', '06 · Debounce completion flush', [source('debounce-source', 80), node('quiet-period', 'debounceTime', { durationMs: 150 }, 'debounce-source'), node('debounce-sink', 'sink', {}, 'quiet-period')]);
await save('07-cancel.json', '07 · Run until cancelled', [node('continuous-source', 'interval', { periodMs: 200, count: null }), node('continuous-sink', 'sink', {}, 'continuous-source')]);
