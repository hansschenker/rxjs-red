# rxjs-red prototype architecture and graph transport v0.1

Date: 2026-09-07. Status: implemented feasibility prototype. Behavioral baseline: RxJS 7.8.2.

## Authority and boundary

The canonical RSL Structural Foundation, Core Execution, Operator State-Machine and Reaction Semantics, and Expression/Context specifications retain authority. This repository explores an editor and execution bridge for a bounded subset. `rxjs-red.graph/0.1` is a prototype transport profile, not a new canonical RSL language version.

Node-RED provides the canvas, palette, property dialogs, persistence, and native flow JSON. Its runtime loads RSL description nodes, but those nodes do not route RSL notifications through `node.send`. The host compiles the selected canvas into an RxJS graph. Pressing Run starts one execution; each Sink starts a subscription within it. The expression adapter is compiled before activation and invoked synchronously at the relevant input reaction.

| Component | Responsibility |
| --- | --- |
| `nodes/catalog.json` | Declarative palette, defaults, help, and property fields |
| `scripts/generate-nodes.mjs` | Generate Node-RED HTML definitions from the catalog |
| `nodes/rsl.js` | Register inert description nodes with Node-RED |
| `public/rsl-panel.js` | Run, cancel, inspect, import, export, and example controls |
| `src/adapter.ts` | Bidirectional supported Node-RED graph conversion |
| `src/model.ts` | Graph structure, finite JSON, port, reference, and DAG checks |
| `src/compiler.ts` | Type/expression checks and lazy RxJS graph construction |
| `src/application.ts` | Embedded editor, local HTTP API, bounded run retention |
| `vendor/rsl-expression` | Existing canonical expression evaluator boundary |

## Graph transport

A document has `profile`, `id`, `name`, `clock`, `nodes`, and optional `editor` fields. The prototype's clock is explicitly `rsl-clock`, unit `ms`. Node IDs and input names use ASCII letters, digits, underscore, and hyphen. Every executable node must contribute to a Sink. Cycles, dangling edges, Sink outputs, duplicate IDs, duplicate input names, and disabled/unsupported nodes in the selected flow are rejected.

```json
{
  "profile": "rxjs-red.graph/0.1",
  "id": "example",
  "name": "One value",
  "clock": { "id": "rsl-clock", "unit": "ms" },
  "nodes": [
    {
      "id": "source",
      "role": "Source",
      "operation": "values",
      "inputs": [],
      "parameters": { "values": [42], "periodMs": 0, "valueType": "number" }
    },
    {
      "id": "sink",
      "role": "Sink",
      "operation": "sink",
      "inputs": [{ "name": "input", "from": "source" }],
      "parameters": {}
    }
  ]
}
```

`editor.nodes` retains positions and labels. `editor.inputs` retains the IDs, positions, and labels of named input adapters, keyed by `targetNodeId/inputName`. These fields have no emission behavior. Omitting editor metadata lets the importer supply a simple layout.

JSON and YAML represent the same graph. The source boundary reuses deterministic RSL parsing: one document, finite portable values, duplicate-key checks, no aliases/anchors/tags, and JSON-compatible scalar syntax. **The graph YAML transport explicitly additionally admits empty mappings `{}`**, needed for empty parameter records and literal empty-object packages. Nonempty flow mappings remain rejected. This exception applies only to this named graph transport; the vendored canonical expression parser is unchanged. Runtime packages never pass through the source parser.

The current graph type vocabulary is `number`, `string`, `boolean`, and `json`. Source values are checked against their declarations. `combineLatest` derives an ordered tuple type from its inputs. `map`, `scan`, and `switchMap` declare result/state types; the canonical expression adapter checks expression contracts and runtime results. This does not claim exhaustive graph type inference.

## Subscription, time, and remembered state

Compiling performs no subscription, Worker invocation, or scheduling. A Run action builds a graph with deferred source activation and subscribes its Sinks. Ordinary graph fan-out retains cold behavior: a cached Observable description is not an implicit multicast. `shareReplay` alone creates the explicit shared connection supported in this milestone.

Every execution receives a scheduler; HTTP runs use `asyncScheduler`, while tests inject `TestScheduler`. Elapsed logical time is sampled from that scheduler relative to execution start. Synchronous sources and operators remain synchronous. Timed Sources and operators use that same scheduler explicitly. Node-RED message routing does not introduce asynchronous boundaries between RSL nodes.

Operator scopes are allocated per subscription. `scan` remembers state with the real RxJS `scan`; the host also records its before/after value for inspection. Pure JSONata expressions are the user-supplied calculations. The named `delayedValue` Worker produces an Observable whose timer is owned by its subscription. `switchMap` selects the latest inner and cancels the old one before invoking the new projection.

Sink completion and errors are terminal notifications. Unsubscription is a teardown event and does not send completion. A workflow run becomes `completed` after all Sinks complete. Any Sink error applies the prototype's explicit fail-fast workflow policy: mark the run `errored` and cancel sibling Sink subscriptions. Cancel marks the run `cancelled` and tears down all remaining work. Terminal outcomes are idempotent.

The instrumentation attaches its child Subscriber before activating a source. This preserves synchronous upstream teardown for `take`, including `take(0)` never subscribing to the source.

## Trace contract

Every trace entry carries an execution-wide increasing sequence number, node ID, subscription ID, logical time, and kind. Kinds include `subscribe`, `reaction`, `state`, `next`, `error`, `complete`, `unsubscribe`, and `finalize`; inner lifecycle events use the `inner.` prefix. `next` carries a value; `error` carries a diagnostic; completion and cancellation have no invented payload.

For value-sensitive input reactions, `context` contains the actual canonical `$rsl` evaluation view. Unary inputs have `inputIndex: 0`; the operation's zero-based notification index is `$state.index`. `scan` also records before/after memory. This is selected operator inspection, not a complete trace of the internal RxJS timer queues, all operator memory, or every canonical RSL action.

The shareReplay node's lifecycle trace describes its upstream connection; downstream Sinks retain separate subscription IDs. `$rsl.connection` is not exposed by this prototype's expression contexts. A complete connection-aware reaction executor remains future work.

HTTP transport and the inspector handle portable JSON. Direct forwarding preserves array packages inside the engine, but arbitrary JavaScript instances/Promises/cyclic objects are outside this editor transport contract.

## Editor lifecycle

Run snapshots the current selected tab. A later edit or Deploy does not mutate a running graph. Deploy persists Node-RED descriptions only; it neither starts nor cancels RSL runs. The sidebar can select and cancel each retained execution. Closing a tab/browser does not unsubscribe from the server-owned run. Server shutdown does.

Each run captures its node labels and operation names for historical inspection. The sidebar distinguishes the active canvas from the selected execution, restores an active run after reload, and retains event focus during polling. State and lifecycle filters make memory changes and cancellation directly inspectable. See the [browser milestone](BROWSER-MILESTONE.md) for exercised workflows and evidence.

Native Node-RED nodes, configuration objects, subflows, groups, credentials, and arbitrary message handlers cannot be treated as equivalent RxJS operations. Comments/groups may decorate the chosen RSL tab but are omitted from RSL export. Named inputs must feed exactly one combineLatest and receive exactly one upstream stream. Their unique code-point-sorted names define tuple order, which is enforced on imported graph documents as well.

## HTTP API

| Method and path under `/api/rsl` | Behavior |
| --- | --- |
| `GET /health` | Report app/runtime versions |
| `POST /compile` | Validate `{flows, flowId}` or `{graph}`; return graph and derived types |
| `POST /runs` | Start a validated snapshot; return execution ID/status |
| `GET /runs` | List retained executions |
| `GET /runs/:id?after=N` | Return later trace events, bounded outputs, dropped counts, and execution-owned `nodes: [{id, name, operation}]` |
| `POST /runs/:id/cancel` | Idempotently cancel a run |
| `POST /export` | Compile and serialize with `format: "json"` or `"yaml"` |
| `POST /import` | Parse `{source, format}`, validate/compile, and return editor nodes |
| `GET /examples` | List bundled example filenames |
| `GET /examples/:name` | Read a bundled example |

The server is a trusted local authoring tool, defaults to loopback, and rejects cross-origin browser mutations. An explicit `--host` flag supports development preview environments; it does not configure authentication. Expressions are validated and bounded by the existing adapter; this is not a hostile-code sandbox. There is no authenticated remote deployment configuration, durable execution engine, or npm publication.

## Next focused work

1. Connect the canonical notification-driven reaction executor to the same graph boundary.
2. Add richer logical input editing and user-defined Observable-producing Workers.
3. Extend state/connection inspection and only then package tested behavior patterns as reusable visual components.
