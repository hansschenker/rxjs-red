import { createApplication } from './application.js';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  host: { type: 'string' },
  port: { type: 'string' },
  strictPort: { type: 'boolean' }
} });
const host = options.host ?? '127.0.0.1';
const port = Number(options.port ?? process.env.PORT ?? 1880);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
const application = await createApplication({ dataDir: process.env.RSL_DATA_DIR });
application.server.on('error', async error => { console.error(error); await application.close(); process.exitCode = 1; });
// Binding errors fail explicitly; this server never falls back to a different port.
application.server.listen(port, host, () => console.log(`rxjs-red: http://${host}:${port}/red/ — open the RSL sidebar to run a flow`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await application.close(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
