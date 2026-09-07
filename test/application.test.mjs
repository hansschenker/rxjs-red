import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
import { createApplication } from '../dist/application.js';

test('embedded Node-RED serves real custom nodes and executes the RSL HTTP workflow', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rxjs-red-'));
  const application = await createApplication({ dataDir: directory });
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
  const base = 'http://127.0.0.1:' + application.server.address().port;
  t.after(async () => { await application.close(); await rm(directory, { recursive: true, force: true }); });
  async function api(path, body, expected = 200) {
    const response = await fetch(base + '/api/rsl/' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  const health = await api('health'); assert.equal(health.rxjs, '7.8.2'); assert.equal(health.nodeRed, '5.0.6');
  const editor = await fetch(base + '/red/'); const html = await editor.text();
  assert.equal(editor.status, 200); assert.match(html, /rxjs-red/); assert.match(html, /rsl-panel/);
  const nodesResponse = await fetch(base + '/red/nodes', { headers: { accept: 'text/html' } });
  const nodes = await nodesResponse.text(); assert.equal(nodesResponse.status, 200);
  assert.match(nodes, /data-template-name="rsl-source"/); assert.match(nodes, /data-template-name="rsl-combine-latest"/);
  assert.deepEqual(await api('runs'), []); // Loading the editor never subscribes.
  const flows = await api('examples/01-values.json');
  const compiled = await api('compile', { flows }); assert.equal(compiled.graph.profile, 'rxjs-red.graph/0.1');
  const run = await api('runs', { flows }, 201);
  const detail = await api('runs/' + run.id);
  assert.equal(detail.status, 'completed'); assert.deepEqual(detail.outputs.map(e => e.value), [8, 10]);
  assert.deepEqual(detail.nodes.find(n => n.id === 'double'), { id: 'double', name: 'map', operation: 'map' });
  const renamed = structuredClone(flows); renamed.find(n => n.id === 'double').name = 'Renamed after Run';
  await api('compile', { flows: renamed });
  assert.equal((await api('runs/' + run.id)).nodes.find(n => n.id === 'double').name, 'map');
  assert.ok(detail.trace.some(e => e.kind === 'reaction' && e.context.event.value === 1));
  const end = detail.trace.at(-1).sequence;
  assert.deepEqual((await api('runs/' + run.id + '?after=' + end)).trace, []);
  for (const format of ['json', 'yaml']) {
    const exported = await api('export', { flows, format });
    const imported = await api('import', { source: exported.source, format });
    assert.deepEqual(imported.graph, compiled.graph);
  }
  const continuous = await api('examples/07-cancel.json');
  const active = await api('runs', { flows: continuous }, 201); assert.equal(active.status, 'running');
  assert.equal((await api('runs/' + active.id + '/cancel', {})).status, 'cancelled');
  const cancelled = await api('runs/' + active.id);
  assert.ok(cancelled.trace.some(e => e.kind === 'unsubscribe'));
  assert.ok(!cancelled.trace.some(e => e.nodeId === 'continuous-sink' && e.kind === 'complete'));
  const bad = structuredClone(flows); bad[1].type = 'function'; await api('compile', { flows: bad }, 400);
  const crossOrigin = await fetch(base + '/api/rsl/runs', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: JSON.stringify({ flows }) });
  assert.equal(crossOrigin.status, 403);
});

test('generated editor definitions register all node roles and validate expression envelopes', async () => {
  const html = await readFile(new URL('../nodes/rsl.html', import.meta.url), 'utf8');
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  const definitions = new Map();
  vm.runInNewContext(script, { RED: { nodes: { registerType: (name, def) => definitions.set(name, def) } }, window: {} });
  assert.equal(definitions.size, 12);
  assert.equal(definitions.get('rsl-source').inputs, 0);
  assert.equal(definitions.get('rsl-sink').outputs, 0);
  const validate = definitions.get('rsl-map').defaults.expression.validate;
  assert.equal(validate.call({}, '{% $notification.value * 2 %}'), true);
  assert.equal(validate.call({}, 'value * 2'), false);
  assert.equal(definitions.get('rsl-source').defaults.count.validate.call({ sourceKind: 'values' }, undefined), true);
  assert.equal(definitions.get('rsl-source').defaults.count.validate.call({ sourceKind: 'interval' }, null), true);
  assert.equal(definitions.get('rsl-source').defaults.values.validate.call({ sourceKind: 'interval' }, undefined), true);
  new vm.Script(await readFile(new URL('../public/rsl-panel.js', import.meta.url), 'utf8'));
});
