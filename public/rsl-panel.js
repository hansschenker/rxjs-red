(function () {
  'use strict';
  let installed = false;
  async function request(path, body) {
    const response = await fetch('/api/rsl/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }
  window.RslPanel = { install: function () {
    if (installed || !window.RED || !RED.sidebar) return;
    installed = true;
    const panel = document.createElement('div');
    panel.className = 'rsl-panel';
    panel.innerHTML = '<div class="rsl-toolbar"><button data-action="run" class="rsl-primary">Run · subscribe</button><button data-action="cancel" disabled>Cancel</button><button data-action="validate">Validate</button></div>' +
      '<p class="rsl-hint">Run the current canvas. Deploy saves the editor; Run starts a stream.</p>' +
      '<div class="rsl-row"><label for="rsl-runs">Execution</label><select id="rsl-runs"><option value="">No execution yet</option></select></div>' +
      '<p class="rsl-status" role="status" aria-live="polite">Ready</p><p class="rsl-error" role="alert" hidden></p>' +
      '<details open><summary>Sink values</summary><pre class="rsl-values">Run a flow to see its values.</pre></details>' +
      '<details open><summary>Notification &amp; state inspector</summary><div class="rsl-row"><label for="rsl-node">Node</label><select id="rsl-node"><option value="">All nodes</option></select></div>' +
      '<div class="rsl-events" tabindex="0"></div><pre class="rsl-context">Select an event to inspect its context.</pre></details>' +
      '<details><summary>RSL document</summary><div class="rsl-toolbar"><button data-action="json">Export JSON</button><button data-action="yaml">Export YAML</button></div>' +
      '<label for="rsl-format">Import format</label> <select id="rsl-format"><option value="json">JSON</option><option value="yaml">YAML</option></select>' +
      '<textarea class="rsl-document" aria-label="RSL document" rows="8" spellcheck="false"></textarea><button data-action="import">Import RSL as a flow</button></details>' +
      '<details><summary>Examples</summary><select class="rsl-example" aria-label="Example flow"></select><button data-action="example">Add example flow</button></details>';
    const query = selector => panel.querySelector(selector);
    const runSelect = query('#rsl-runs');
    const nodeSelect = query('#rsl-node');
    let selected = ''; let events = []; let cursor = -1; let timer = null; let generation = 0; let busy = false;
    const setError = error => { query('.rsl-error').textContent = error ? error.message : ''; query('.rsl-error').hidden = !error; };
    const snapshot = () => ({ flows: RED.nodes.createCompleteNodeSet({ credentials: false }), flowId: RED.workspaces.active() });
    const visibleEvents = () => events.filter(event => !nodeSelect.value || event.nodeId === nodeSelect.value);
    function renderEvents() {
      const list = query('.rsl-events'); list.replaceChildren();
      for (const event of visibleEvents().slice(-120)) {
        const button = document.createElement('button');
        button.className = 'rsl-event';
        button.textContent = event.time + ' ms · ' + event.nodeId + ' · ' + event.kind;
        button.addEventListener('click', () => { query('.rsl-context').textContent = JSON.stringify(event, null, 2); });
        list.appendChild(button);
      }
    }
    function render(run) {
      query('.rsl-status').textContent = run.status + (run.dropped ? ' · showing recent trace (' + run.dropped + ' earlier events omitted)' : '');
      query('[data-action="cancel"]').disabled = run.status !== 'running';
      query('.rsl-values').textContent = run.outputs.length ? run.outputs.map(item => item.sinkId + ': ' + JSON.stringify(item.value)).join('\n') + (run.droppedOutputs ? '\nEarlier outputs omitted: ' + run.droppedOutputs : '') : 'No values emitted.';
      events.push(...run.trace); events = events.slice(-2000);
      if (run.trace.length) cursor = run.trace.at(-1).sequence;
      const old = nodeSelect.value;
      nodeSelect.replaceChildren(new Option('All nodes', ''));
      [...new Set(events.map(e => e.nodeId))].sort().forEach(id => nodeSelect.add(new Option(id, id)));
      nodeSelect.value = old;
      if (!nodeSelect.value) nodeSelect.value = '';
      renderEvents();
    }
    async function poll(token) {
      if (token !== generation || !selected) return;
      try {
        const run = await request('runs/' + selected + '?after=' + cursor);
        if (token !== generation) return;
        render(run);
        if (run.status === 'running') timer = setTimeout(() => poll(token), 200);
      } catch (error) { if (token === generation) setError(error); }
    }
    function selectRun(id) {
      clearTimeout(timer); generation++; selected = id; events = []; cursor = -1;
      query('.rsl-context').textContent = 'Select an event to inspect its context.';
      if (id) poll(generation);
    }
    async function refreshRuns(id) {
      const runs = await request('runs');
      runSelect.replaceChildren(new Option('Select an execution', ''));
      runs.forEach(run => runSelect.add(new Option(run.name + ' · ' + run.status + ' · ' + run.id.slice(0, 8), run.id)));
      runSelect.value = id || selected;
    }
    runSelect.addEventListener('change', () => selectRun(runSelect.value));
    nodeSelect.addEventListener('change', renderEvents);
    panel.addEventListener('click', async event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action || busy) return;
      busy = true; setError(null);
      try {
        if (action === 'run') {
          const run = await request('runs', snapshot());
          await refreshRuns(run.id); selectRun(run.id);
        } else if (action === 'cancel' && selected) {
          await request('runs/' + selected + '/cancel', {}); selectRun(selected); await refreshRuns(selected);
        } else if (action === 'validate') {
          const result = await request('compile', snapshot()); query('.rsl-status').textContent = 'Valid · ' + result.graph.nodes.length + ' RSL nodes';
        } else if (action === 'json' || action === 'yaml') {
          const result = await request('export', { ...snapshot(), format: action });
          query('.rsl-document').value = result.source; query('#rsl-format').value = action;
          const url = URL.createObjectURL(new Blob([result.source], { type: 'text/plain' }));
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        } else if (action === 'import') {
          const result = await request('import', { source: query('.rsl-document').value, format: query('#rsl-format').value });
          RED.view.importNodes(JSON.stringify(result.flows), { addFlow: true, generateIds: true, applyNodeDefaults: true });
        } else if (action === 'example') {
          const flows = await request('examples/' + query('.rsl-example').value);
          RED.view.importNodes(JSON.stringify(flows), { addFlow: true, generateIds: true, applyNodeDefaults: true });
        }
      } catch (error) { setError(error); } finally { busy = false; }
    });
    RED.sidebar.addTab({ id: 'rsl', name: 'RSL', label: 'RSL', iconClass: 'fa fa-play-circle', content: panel, enableOnEdit: true });
    request('examples').then(files => files.forEach(file => query('.rsl-example').add(new Option(file.replace('.json', ''), file)))).catch(setError);
    refreshRuns().catch(setError);
    window.addEventListener('pagehide', () => { clearTimeout(timer); generation++; });
  } };
})();
