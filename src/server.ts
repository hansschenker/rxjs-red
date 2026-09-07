import { createApplication } from './application.js';

const port = Number(process.env.PORT ?? 1880);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
const application = await createApplication({ dataDir: process.env.RSL_DATA_DIR });
application.server.on('error', async error => { console.error(error); await application.close(); process.exitCode = 1; });
application.server.listen(port, '127.0.0.1', () => console.log(`rxjs-red: http://localhost:${port}/red/ — open the RSL sidebar to run a flow`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await application.close(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
