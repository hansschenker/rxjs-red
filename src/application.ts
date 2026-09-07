import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdir, readFile, copyFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fromNodeRed, toNodeRed, parseGraph, serializeGraph } from './adapter.js';
import { compileGraph, startExecution, errorView, type Execution, type ExecutionStatus, type TraceEvent } from './compiler.js';
import { invariant, isRecord } from './model.js';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
type RunNode = Readonly<{ id: string; name: string; operation: string }>;
type Run = { id: string; graphId: string; name: string; nodes: readonly RunNode[]; status: ExecutionStatus; trace: TraceEvent[]; outputs: { sinkId: string; value: unknown }[]; dropped: number; droppedOutputs: number; execution?: Execution };
const summary = (run: Run) => ({ id: run.id, graphId: run.graphId, name: run.name, status: run.status });

export async function createApplication({ dataDir = join(ROOT, '.data') }: { dataDir?: string } = {}) {
  const app = express();
  const server = createServer(app);
  const RED = require('node-red');
  const runs = new Map<string, Run>();
  const examplesDir = join(ROOT, 'examples');
  await mkdir(dataDir, { recursive: true });
  // COPYFILE_EXCL preserves user edits across restarts.
  try { await copyFile(join(examplesDir, '01-values.json'), join(dataDir, 'flows.json'), 1); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  app.disable('x-powered-by');
  // This development editor defaults to loopback in server.ts.
  // Reject browser cross-origin mutations, including form posts, before Node-RED routes.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== 'http://' + req.headers.host) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed' }); return;
    }
    next();
  });
  app.use('/api/rsl', express.json({ limit: '1mb' }));
  app.use('/rsl-assets', express.static(join(ROOT, 'public')));
  app.get('/', (_req, res) => res.redirect('/red/'));
  const selectGraph = (body: unknown) => {
    invariant(isRecord(body), 'Expected an object body');
    invariant(body.flowId === undefined || typeof body.flowId === 'string', 'flowId must be a string');
    return body.graph ? body.graph : fromNodeRed(body.flows, body.flowId);
  };
  app.get('/api/rsl/health', (_req, res) => res.json({ app: 'rxjs-red', nodeRed: require('node-red/package.json').version, rxjs: require('rxjs/package.json').version, profile: 'rxjs-red.graph/0.1' }));
  app.post('/api/rsl/compile', (req, res) => {
    const compiled = compileGraph(selectGraph(req.body));
    res.json({ graph: compiled.graph, types: Object.fromEntries(compiled.types) });
  });
  app.post('/api/rsl/export', (req, res) => {
    invariant(req.body.format === 'json' || req.body.format === 'yaml', 'Choose json or yaml');
    const { graph } = compileGraph(selectGraph(req.body));
    res.json({ source: serializeGraph(graph, req.body.format), filename: graph.id + '.rsl.' + req.body.format });
  });
  app.post('/api/rsl/import', (req, res) => {
    invariant(typeof req.body.source === 'string' && ['json', 'yaml'].includes(req.body.format), 'Expected source and format');
    const { graph } = compileGraph(parseGraph(req.body.source, req.body.format));
    res.json({ graph, flows: toNodeRed(graph) });
  });
  app.get('/api/rsl/examples', async (_req, res, next) => {
    try { res.json((await readdir(examplesDir)).filter(f => f.endsWith('.json')).sort()); } catch (error) { next(error); }
  });
  app.get('/api/rsl/examples/:name', async (req, res, next) => {
    try {
      invariant(/^\d\d-[a-z-]+\.json$/.test(req.params.name!), 'Invalid example name');
      res.type('json').send(await readFile(join(examplesDir, req.params.name!), 'utf8'));
    } catch (error) { next(error); }
  });
  app.get('/api/rsl/runs', (_req, res) => res.json([...runs.values()].map(summary)));
  app.post('/api/rsl/runs', (req, res) => {
    const compiled = compileGraph(selectGraph(req.body));
    invariant([...runs.values()].filter(r => r.status === 'running').length < 4, 'Cancel an active run before starting another (limit 4)');
    if (runs.size >= 20) { const old = [...runs.values()].find(r => r.status !== 'running'); if (old) runs.delete(old.id); }
    // Capture labels with the execution so later canvas edits cannot rename its history.
    const nodes = compiled.graph.nodes.map(node => ({ id: node.id, name: compiled.graph.editor?.nodes[node.id]?.name || node.operation, operation: node.operation }));
    const run: Run = { id: randomUUID(), graphId: compiled.graph.id, name: compiled.graph.name, nodes, status: 'running', trace: [], outputs: [], dropped: 0, droppedOutputs: 0 };
    runs.set(run.id, run);
    run.execution = startExecution(compiled, {
      id: run.id,
      trace(event) {
        run.trace.push(event);
        if (run.trace.length > 2000) { run.trace.shift(); run.dropped++; }
      },
      next(sinkId, value) {
        run.outputs.push({ sinkId, value });
        if (run.outputs.length > 500) { run.outputs.shift(); run.droppedOutputs++; }
      },
      status(status) { run.status = status; },
    });
    res.status(201).json(summary(run));
  });
  app.get('/api/rsl/runs/:id', (req, res) => {
    const run = runs.get(req.params.id!);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    const after = req.query.after === undefined ? -1 : Number(req.query.after);
    invariant(Number.isInteger(after) && after >= -1, 'Invalid trace cursor');
    res.json({ ...summary(run), nodes: run.nodes, trace: run.trace.filter(e => e.sequence > after), outputs: run.outputs, dropped: run.dropped, droppedOutputs: run.droppedOutputs });
  });
  app.post('/api/rsl/runs/:id/cancel', (req, res) => {
    const run = runs.get(req.params.id!);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    run.execution?.cancel(); res.json(summary(run));
  });
  RED.init(server, {
    httpAdminRoot: '/red', httpNodeRoot: false, userDir: resolve(dataDir),
    flowFile: 'flows.json', nodesDir: join(ROOT, 'nodes'),
    functionExternalModules: false, externalModules: { autoInstall: false, palette: { allowInstall: false, allowUpload: false } },
    editorTheme: {
      page: { title: 'rxjs-red · RSL Studio', scripts: [join(ROOT, 'public/rsl-panel.js')], css: [join(ROOT, 'public/rsl-panel.css')] },
      header: { title: 'rxjs-red' },
      projects: { enabled: false }, tours: false,
    },
    logging: { console: { level: 'warn', metrics: false, audit: false } },
  });
  app.use('/red', RED.httpAdmin);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error), details: errorView(error) });
  });
  await RED.start();
  return {
    app, server, RED,
    async close() {
      for (const run of runs.values()) run.execution?.cancel();
      await RED.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    },
  };
}
