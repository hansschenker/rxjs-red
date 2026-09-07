(function () {
  'use strict';
  let installed = false;
  async function request(path, body) {
    const response = await fetch('/api/rsl/' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status });
    return result;
  }
  window.RslPanel = { install: function () {
    if (installed || !window.RED || !RED.sidebar) return;
    installed = true;
    const panel = document.createElement('div');
    panel.className = 'rsl-panel';
    panel.innerHTML = '<div class="rsl-controls"><div class="rsl-toolbar"><button data-action="run" class="rsl-primary">Run · subscribe</button><button data-action="cancel" disabled>Cancel</button><button data-action="validate">Validate</button></div>' +
      '<p class="rsl-canvas"></p><p class="rsl-hint">Run starts a snapshot of this tab. Deploy saves the canvas.</p></div>' +
      '<p class="rsl-feedback" role="status" hidden></p><p class="rsl-error" role="alert" hidden></p>' +
      '<div class="rsl-row"><label for="rsl-runs">Execution</label><select id="rsl-runs"><option value="">No execution selected</option></select></div>' +
      '<p class="rsl-status" role="status" aria-live="polite">Ready</p><p class="rsl-run-hint">Runs continue when you change tabs or close the browser. Cancel stops the selected execution.</p>' +
      '<details open><summary>Sink values</summary><pre class="rsl-values">Run a flow to see its values.</pre></details>' +
      '<details open><summary>Notification &amp; state inspector</summary><div class="rsl-row"><label for="rsl-node">Node</label><select id="rsl-node"><option value="">All nodes</option></select></div>' +
      '<div class="rsl-row"><label for="rsl-kind">Event</label><select id="rsl-kind"><option value="">All events</option><option value="state">State changes</option><option value="reaction">Reactions</option><option value="next">Values</option><option value="lifecycle">Subscription lifecycle</option><option value="error">Errors</option></select></div>' +
      '<label class="rsl-follow"><input type="checkbox" checked> Follow latest events</label><p class="rsl-trace-hint"></p>' +
      '<div class="rsl-events" tabindex="0" role="group" aria-label="Trace events"></div>' +
      '<p class="rsl-event-title">Select an event to inspect its context.</p><pre class="rsl-event-summary" hidden></pre>' +
      '<details class="rsl-raw" hidden><summary>Event JSON</summary><pre class="rsl-context"></pre></details></details>' +
      '<details><summary>RSL document</summary><div class="rsl-toolbar"><button data-action="json">Export JSON</button><button data-action="yaml">Export YAML</button></div><a class="rsl-download" hidden></a>' +
      '<label for="rsl-format">Import format</label> <select id="rsl-format"><option value="json">JSON</option><option value="yaml">YAML</option></select>' +
      '<textarea class="rsl-document" aria-label="RSL document" rows="8" spellcheck="false"></textarea><button data-action="import">Import RSL as a flow</button></details>' +
      '<details><summary>Examples</summary><select class="rsl-example" aria-label="Example flow"></select><button data-action="example">Add example flow</button></details>';
    const query = selector => panel.querySelector(selector);
    const runSelect = query('#rsl-runs');
    const nodeSelect = query('#rsl-node');
    const kindSelect = query('#rsl-kind');
    const follow = query('.rsl-follow input');
    const list = query('.rsl-events');
    const runs = new Map();
    const nodes = new Map();
    const buttons = new Map();
    let selected = ''; let status = ''; let events = []; let cursor = -1; let timer = null; let generation = 0; let busy = false; let selectedEvent = null; let downloadUrl = null;
    const setError = error => { query('.rsl-error').textContent = error ? error.message : ''; query('.rsl-error').hidden = !error; };
    const feedback = message => { query('.rsl-feedback').textContent = message; query('.rsl-feedback').hidden = !message; };
    const setStatus = message => { const element = query('.rsl-status'); if (element.textContent !== message) element.textContent = message; };
    const snapshot = () => ({ flows: RED.nodes.createCompleteNodeSet({ credentials: false }), flowId: RED.workspaces.active() });
    const nodeName = id => nodes.get(id)?.name || id;
    const short = value => { const text = JSON.stringify(value); return text?.length > 90 ? text.slice(0, 87) + '…' : text; };
    const title = event => event.time + ' ms · ' + nodeName(event.nodeId) + ' · ' + event.kind;
    function updateControls() {
      panel.querySelectorAll('[data-action]').forEach(button => { button.disabled = busy || (button.dataset.action === 'cancel' && (!selected || status !== 'running')); });
      runSelect.disabled = busy;
      query('[data-action="run"]').textContent = busy ? 'Working…' : 'Run · subscribe';
    }
    function updateCanvas() {
      const workspace = RED.nodes.workspace(RED.workspaces.active());
      query('.rsl-canvas').textContent = 'Canvas: ' + (workspace?.label || 'Choose an RSL flow tab');
      feedback('');
    }
    function updateRunOptions() {
      const existing = new Map([...runSelect.options].map(option => [option.value, option]));
      for (const run of [...runs.values()].reverse()) {
        let option = existing.get(run.id);
        if (!option) { option = new Option('', run.id); runSelect.add(option); }
        option.textContent = run.name + ' · ' + run.status + ' · ' + run.id.slice(0, 8);
      }
      for (const option of [...runSelect.options]) if (option.value && !runs.has(option.value)) option.remove();
      runSelect.value = selected;
    }
    function visibleEvents() {
      return events.filter(event => {
        if (nodeSelect.value && event.nodeId !== nodeSelect.value) return false;
        const kind = event.kind.replace(/^inner\./, '');
        return !kindSelect.value || (kindSelect.value === 'lifecycle' ? ['subscribe', 'unsubscribe', 'complete', 'error', 'finalize'].includes(kind) : kind === kindSelect.value);
      });
    }
    function inspect(event) {
      selectedEvent = event.sequence;
      follow.checked = false;
      query('.rsl-event-title').textContent = title(event);
      query('.rsl-context').textContent = JSON.stringify(event, null, 2);
      query('.rsl-raw').hidden = false;
      const detail = query('.rsl-event-summary');
      detail.hidden = false;
      if (event.kind === 'state') detail.textContent = 'Before: ' + JSON.stringify(event.context.before) + '\nAfter:  ' + JSON.stringify(event.context.after);
      else if ('value' in event) detail.textContent = JSON.stringify(event.value, null, 2);
      else if (event.kind === 'reaction') detail.textContent = JSON.stringify(event.context, null, 2);
      else if (event.error) detail.textContent = JSON.stringify(event.error, null, 2);
      else detail.textContent = event.kind.includes('unsubscribe') ? 'Subscription cancelled. No completion notification is sent.' : 'Subscription: ' + event.subscriptionId;
      buttons.forEach((button, sequence) => button.setAttribute('aria-pressed', String(sequence === selectedEvent)));
    }
    function renderEvents() {
      const matches = visibleEvents();
      const shown = matches.slice(-120);
      const retained = new Set(shown.map(event => event.sequence));
      // Keep existing DOM nodes so polling preserves keyboard focus and inspection position.
      for (const [sequence, button] of buttons) if (!retained.has(sequence)) {
        if (document.activeElement === button) list.focus();
        button.remove(); buttons.delete(sequence);
      }
      for (const event of shown) if (!buttons.has(event.sequence)) {
        const button = document.createElement('button');
        button.className = 'rsl-event';
        button.setAttribute('aria-pressed', String(event.sequence === selectedEvent));
        button.textContent = title(event) + ('value' in event ? ' · ' + short(event.value) : '');
        button.addEventListener('click', () => inspect(event));
        list.appendChild(button); buttons.set(event.sequence, button);
      }
      query('.rsl-trace-hint').textContent = !events.length ? 'No events yet.' : !matches.length ? 'No events match these filters.' : 'Showing ' + shown.length + ' of ' + matches.length + ' retained matching events.';
      if (follow.checked) list.scrollTop = list.scrollHeight;
    }
    function render(run) {
      status = run.status;
      runs.set(run.id, run); updateRunOptions(); updateControls();
      const statusText = { running: 'Running', completed: 'Completed', cancelled: 'Cancelled · unsubscribed', errored: 'Errored' }[status];
      setStatus(run.name + ' · ' + statusText + (run.dropped ? ' · ' + run.dropped + ' earlier trace events omitted' : ''));
      for (const node of run.nodes) if (!nodes.has(node.id)) {
        nodes.set(node.id, node);
        nodeSelect.add(new Option(node.name + ' · ' + node.operation + ' · ' + node.id.slice(0, 8), node.id));
      }
      query('.rsl-values').textContent = run.outputs.length ? run.outputs.map(item => nodeName(item.sinkId) + ' [' + item.sinkId.slice(0, 8) + ']: ' + JSON.stringify(item.value)).join('\n') + (run.droppedOutputs ? '\nEarlier outputs omitted: ' + run.droppedOutputs : '') : 'No values emitted.';
      events.push(...run.trace); events = events.slice(-2000);
      if (run.trace.length) cursor = run.trace.at(-1).sequence;
      renderEvents();
      if (status === 'errored' && selectedEvent === null) {
        const error = events.find(event => event.kind === 'error');
        if (error) inspect(error);
      }
    }
    async function poll(token) {
      if (token !== generation || !selected) return;
      clearTimeout(timer);
      try {
        const run = await request('runs/' + selected + '?after=' + cursor);
        if (token !== generation) return;
        render(run);
        if (run.status === 'running') timer = setTimeout(() => poll(token), 200);
      } catch (error) {
        if (token !== generation) return;
        if (error.status === 404) {
          runs.delete(selected); selectRun(''); updateRunOptions(); setError(new Error('This execution is no longer retained. Run the canvas again.'));
        } else {
          setStatus('Connection interrupted · retrying. The server may still be running this execution.');
          timer = setTimeout(() => poll(token), 1000);
        }
      }
    }
    function selectRun(id) {
      clearTimeout(timer); generation++; selected = id; status = ''; events = []; cursor = -1; selectedEvent = null;
      nodes.clear(); buttons.clear(); list.replaceChildren();
      nodeSelect.replaceChildren(new Option('All nodes', '')); kindSelect.value = ''; follow.checked = true;
      setStatus(id ? 'Loading execution…' : 'No execution selected');
      query('.rsl-values').textContent = id ? 'Loading values…' : 'Run a flow or select an execution to see its values.';
      query('.rsl-event-title').textContent = 'Select an event to inspect its context.';
      query('.rsl-event-summary').hidden = true; query('.rsl-event-summary').textContent = ''; query('.rsl-raw').hidden = true; query('.rsl-raw').open = false; query('.rsl-context').textContent = '';
      updateRunOptions(); updateControls(); renderEvents();
      if (id) poll(generation);
    }
    async function refreshRuns(restore = false) {
      const token = generation;
      const summaries = await request('runs');
      if (token !== generation) return;
      runs.clear(); summaries.forEach(run => runs.set(run.id, run.id === selected && status && status !== 'running' ? { ...run, status } : run)); updateRunOptions();
      if (restore) selectRun(summaries.filter(run => run.status === 'running').at(-1)?.id || summaries.at(-1)?.id || '');
      else if (selected && !runs.has(selected)) selectRun('');
    }
    function importFlow(flows) {
      const firstNode = flows.find(node => node.z && node.type.startsWith('rsl-'));
      const imported = RED.view.importNodes(JSON.stringify(flows), { addFlow: true, generateIds: true, applyNodeDefaults: true });
      const workspace = imported?.nodeMap[firstNode?.id]?.z;
      if (!workspace) throw new Error('The editor could not import this flow. Close any open node dialog and try again.');
      RED.workspaces.show(workspace);
      RED.sidebar.show('rsl');
      feedback('Flow added and selected. Press Run to start it.');
      panel.scrollTop = 0;
    }
    runSelect.addEventListener('change', () => { setError(null); selectRun(runSelect.value); });
    runSelect.addEventListener('focus', () => { refreshRuns().catch(setError); });
    nodeSelect.addEventListener('change', () => { buttons.clear(); list.replaceChildren(); renderEvents(); });
    kindSelect.addEventListener('change', () => { buttons.clear(); list.replaceChildren(); renderEvents(); });
    follow.addEventListener('change', renderEvents);
    list.addEventListener('wheel', () => { follow.checked = false; }, { passive: true });
    panel.addEventListener('click', async event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action || busy) return;
      busy = true; updateControls(); setError(null); feedback('');
      try {
        if (action === 'run') {
          const run = await request('runs', snapshot());
          runs.set(run.id, run); selectRun(run.id);
          await refreshRuns();
        } else if (action === 'cancel' && selected) {
          const token = generation;
          const run = await request('runs/' + selected + '/cancel', {});
          if (token === generation) { runs.set(run.id, run); clearTimeout(timer); generation++; await poll(generation); }
        } else if (action === 'validate') {
          const result = await request('compile', snapshot()); feedback('Valid canvas · ' + result.graph.nodes.length + ' RSL nodes. Ready to run.');
        } else if (action === 'json' || action === 'yaml') {
          const result = await request('export', { ...snapshot(), format: action });
          query('.rsl-document').value = result.source; query('#rsl-format').value = action;
          if (downloadUrl) URL.revokeObjectURL(downloadUrl);
          downloadUrl = URL.createObjectURL(new Blob([result.source], { type: action === 'json' ? 'application/json' : 'application/yaml' }));
          const anchor = query('.rsl-download'); anchor.href = downloadUrl; anchor.download = result.filename; anchor.textContent = 'Download ' + result.filename; anchor.hidden = false; anchor.click();
          feedback('RSL ' + action.toUpperCase() + ' ready. The download link remains available below.');
        } else if (action === 'import') {
          const result = await request('import', { source: query('.rsl-document').value, format: query('#rsl-format').value });
          importFlow(result.flows);
        } else if (action === 'example') {
          importFlow(await request('examples/' + query('.rsl-example').value));
        }
      } catch (error) { setError(error); } finally { busy = false; updateControls(); }
    });
    RED.sidebar.addTab({ id: 'rsl', name: 'RSL', label: 'RSL', iconClass: 'fa fa-play-circle', content: panel, enableOnEdit: true });
    RED.events.on('workspace:change', updateCanvas);
    RED.events.on('flows:change', updateCanvas);
    updateCanvas();
    request('examples').then(files => files.forEach(file => query('.rsl-example').add(new Option(file.replace('.json', ''), file)))).catch(setError);
    refreshRuns(true).catch(setError);
    window.addEventListener('pagehide', () => { clearTimeout(timer); generation++; if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
  } };
})();
