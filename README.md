# rxjs-red

An embedded **Node-RED 5.0.6** application for visually composing RSL workflows and executing them with **RxJS 7.8.2**.

Draw a flow, configure its JSONata expressions, and press **Run · subscribe** in the **RSL** sidebar. Values and notification traces appear beside the canvas. **Cancel** unsubscribes from the running graph, including sources, pending scheduled deliveries, and inner streams.

This is a working editor feasibility prototype. The graph transport is explicitly identified as `rxjs-red.graph/0.1`; it is not a replacement for the canonical RSL specifications or a complete reaction-state-machine executor.

## Run locally

Use Node.js **22.9 or later** and npm. The application requires a resident Node.js process.

```sh
git clone https://github.com/hansschenker/rxjs-red.git
cd rxjs-red
npm ci --ignore-scripts
npm run build
npm start
```

Open **http://localhost:1880/red/**. The application binds to `127.0.0.1` and is intended for trusted local development. It does not configure remote authentication.

1. The first launch opens the **Values — map and filter** example.
2. Open the **RSL** sidebar using its play-circle icon on the right.
3. Press **Run · subscribe**. The Sink displays **8** and **10**, followed by completion.
4. Select a notification to inspect its execution ID, subscription ID, logical time, and available context.
5. Expand **Examples** to add another flow. Importing adds and selects a copy with new editor IDs.

**Run uses the current canvas**, including edits that have not been deployed. **Deploy saves the Node-RED flow configuration**; RSL description nodes do not start RxJS execution on deployment. Restarting preserves saved flows in `.data/`. Runs and traces are held in memory and do not survive restart.

`PORT` selects another local port. `RSL_DATA_DIR` selects another flow-storage directory. On Windows PowerShell, set these as `$env:PORT` and `$env:RSL_DATA_DIR` before starting.

For development, `npm run dev` builds once and watches the built server modules. Run `npm run build` after TypeScript edits to restart that development server; reload the browser after sidebar asset changes. Explicit flags are accepted, for example `npm run dev -- --host 127.0.0.1 --port 1881 --strictPort`. A non-loopback host is an explicit choice for a trusted environment; it does not add authentication. Restarting the development server cancels its runs.

## The RSL palette

| Node | What happens over time |
| --- | --- |
| Source: values | Emit each array element as one package; period 0 is synchronous |
| Source: interval | Emit counters after each period; an empty count runs until cancelled |
| map | Calculate one result per input using a synchronous JSONata expression |
| filter | Forward the original package when the condition returns `true` |
| scan · remember | Remember and emit the next total for this subscription |
| take | Complete after the configured count and unsubscribe upstream |
| delay | Schedule each next value after the duration; errors remain immediate |
| debounceTime | Emit after a quiet period; completion flushes a pending value |
| switchMap · latest | Cancel the previous inner stream and start the latest Worker stream |
| Named input | Identify one logical input of `combineLatest` on the canvas |
| combineLatest | Emit an ordered tuple after all inputs have emitted, then on each input next |
| shareReplay · 1 | Explicitly share upstream execution with a one-value replay buffer |
| Sink · inspect | Own a subscription and display its output |

Examples cover values, remembered state, inner cancellation, two named inputs, two shared sinks, debounce completion, and explicit cancellation of an infinite source.

Expressions use the existing RSL bindings:

```text
map:    {% $notification.value * 2 %}
filter: {% $rsl.event.value > 6 %}
scan:   {% $state.total + $notification.value %}
index:  {% $state.index %}
```

`$notification.value` and `$rsl.event.value` refer to the same current package. `$state.index` is the zero-based input-notification index for that operation. The canonical adapter's `$rsl.time.now` exposes the frame's captured logical time in milliseconds. The canonical expression profile, its admission checks, and its synchronous JSONata **1.8.7** evaluator are reused from [rxjs-rsl-astra-01](https://github.com/hansschenker/rxjs-rsl-astra-01).

Node-RED independently uses JSONata **2.2.2**. Its expression evaluator is not substituted for the pinned RSL evaluator. The prototype uses plain expression fields with envelope validation and validates the complete expression through the RSL adapter on Validate, Run, and Export.

## Multiple inputs and sharing

To combine two streams, wire each through a **Named input** node, give the inputs distinct names such as `a` and `b`, and connect both to `combineLatest`. Sorted input names determine tuple order. The compiler removes these visual adapters and retains explicit logical input references. This works with Node-RED's single physical input port without modifying its editor.

Two Sinks create two cold subscriptions by default. Add **shareReplay · 1** at the intended sharing boundary to use one upstream connection within a run. Its fixed RxJS contract is `shareReplay({ bufferSize: 1, refCount: true })`: reset on error, reset on zero subscribers while active, retain the completed cache. Separate Run actions always allocate separate graphs and sharing hubs.

## Inspect and exchange workflows

- The RSL sidebar displays named Sink values and a bounded notification trace, with filters for node and event kind.
- `scan` displays before/after memory directly. Value-sensitive operations expose their actual evaluation frames in Event JSON.
- Selecting an event preserves its context and keyboard focus while new values arrive; **Follow latest events** resumes automatic scrolling.
- Execution status stays separate from canvas validation. On reload, the sidebar selects the newest active run or latest retained result. **Cancel** always targets the selected execution.
- Inner traces distinguish subscribe, next, complete, error, and unsubscribe.
- Export prepares RSL JSON or YAML, triggers a download, and retains both a download link and editable document text.
- Import validates that document and adds an equivalent supported flow to the canvas.
- Native Node-RED Import/Export remains available for the editor's own JSON format.

The graph transport preserves RSL node IDs, expressions, logical input names, labels, and coordinates. Comments and visual groups are omitted from the RSL projection; native Node-RED JSON preserves those editor features. Arbitrary Node-RED nodes and subflows are not translated.

## Verify

```sh
npm run check
npm run demo
```

`check` builds strict TypeScript and runs **21 prototype tests** and all **288 inherited evaluator tests**. Prototype tests cover actual RxJS execution, virtual time, same-stack teardown, sharing, expression errors, graph validation, JSON/YAML round trips, and HTTP integration with a real embedded Node-RED runtime. Generated node definitions are also executed in a JavaScript test context. GitHub Actions runs the same checks on Node.js 22 and 24.

The [browser milestone record](docs/BROWSER-MILESTONE.md) documents real palette and wire drags, node-dialog edits, running before Deploy, state inspection, keyboard interaction, cancellation, reload recovery, expression errors, and JSON/YAML imports. It includes screenshots and the remaining verification limits; these browser exercises are separate from the automated test suite.

## Design and scope

- [Prototype architecture and transport contract](docs/PROTOTYPE.md)
- [Browser editor milestone and screenshots](docs/BROWSER-MILESTONE.md)
- [Lessons from Dean Cording's state-machine node](docs/STATE-MACHINE-INSPIRATION.md)
- [Verification record](verification.json)
- [Pinned evaluator provenance](vendor/rsl-expression/UPSTREAM.json)

The prototype implements its supported operations using the actual RxJS 7 operators. It does not implement a general interpreter for the canonical RSL reaction definitions, arbitrary Observable-producing Workers, full operator-state inspection, generic pattern subflows, or ASL workflows. `switchMap` currently exposes the named `delayedValue` Worker to make cancellation and timing directly observable.

Trace retention is limited to 2,000 events and 500 Sink outputs per run; dropped counts are displayed. Up to four runs may be active, and up to 20 runs are retained. Closing the browser does not cancel a run: use Cancel or stop the server. Server shutdown tears down every active run.

## Attribution

Node-RED is maintained by its contributors and the OpenJS Foundation; RxJS and JSONata remain external dependencies. The existing RSL evaluator is vendored from the user's `rxjs-rsl-astra-01` repository at the revision recorded in `UPSTREAM.json`. Its runtime source and schema are unchanged; one inherited test uses module resolution instead of a fixed dependency path so it works with npm hoisting.

Dean Cording's [node-red-contrib-state-machine](https://github.com/DeanCording/node-red-contrib-state-machine) informed the state-inspection design. No code from that repository is copied or installed.

Commit co-authorship uses the previously requested fictional attribution `Astra <astra@openai.com>`; it is not a verified mailbox or account association. This repository is private to npm (`"private": true`) and is not published as an npm package.
