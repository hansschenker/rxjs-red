# Lessons from node-red-contrib-state-machine

Reviewed 2026-09-07 at the user's suggestion: [DeanCording/node-red-contrib-state-machine](https://github.com/DeanCording/node-red-contrib-state-machine).

The repository's package manifest declares version 1.2.1 and wraps `javascript-state-machine` 3.x. This note describes the inspected source; it does not establish compatibility or maintenance status for Node-RED 5.

| Observed design | Application to rxjs-red |
| --- | --- |
| Editable states and `{name, from, to}` transition rows | Future reaction editors can offer explicit structured fields |
| Current state shown with `node.status` | Keep remembered state and lifecycle outcomes visible |
| Invalid triggers can be ignored or reported | Make reaction policy and failure behavior explicit |
| State output can use message, flow, or global properties | Require an explicit state owner and lifetime in RSL |
| Runtime behavior and editor definition are separate files | Keep palette/authoring concerns separate from stream execution |

The first prototype applies the **visible state** lesson in its RSL inspector: `scan` records before and after its state transition, while input reactions retain the notification's evaluation context. Its runtime source remains based on RxJS operations; this reference package is neither installed nor copied.

There are semantic differences that matter for later integration. The reference creates its state machine when a Node-RED node is deployed and can emit its initial state when flows start. In rxjs-red, subscription starts execution, state is subscription-owned unless sharing is explicit, and `scan` does not emit its seed. Node-RED message-processing completion does not mean RxJS stream completion. The full RSL reaction model must also cover error, completion, cancellation, timers, inner streams, and explicit sharing.

The reference also lets context changes provide the next trigger value, but still processes transitions on receipt of a message. This reinforces the distinction between remembered data and the event that causes a reaction.

A future RSL reaction editor could expose columns for **notification source/kind**, **guard**, **remembered-state updates**, **resource actions**, and **emission/termination actions**. This is a design direction, not a feature implemented by this prototype, and must follow the canonical RSL reaction semantics.

Sources inspected:

- [README](https://github.com/DeanCording/node-red-contrib-state-machine/blob/master/README.md)
- [Runtime implementation](https://github.com/DeanCording/node-red-contrib-state-machine/blob/master/state-machine.js)
- [Editor definition](https://github.com/DeanCording/node-red-contrib-state-machine/blob/master/state-machine.html)
- [Package manifest](https://github.com/DeanCording/node-red-contrib-state-machine/blob/master/package.json)
