import { readFile } from 'node:fs/promises';
import { fromNodeRed } from '../dist/adapter.js';
import { compileGraph, startExecution } from '../dist/compiler.js';
const flows = JSON.parse(await readFile(new URL('../examples/01-values.json', import.meta.url), 'utf8'));
startExecution(compileGraph(fromNodeRed(flows)), { id: 'console-demo', next: (sink, value) => console.log(sink + ':', value), status: status => console.log('Execution:', status) });
