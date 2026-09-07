# Vendored RSL synchronous evaluator

This directory contains a pinned snapshot of the user's [rxjs-rsl-astra-01](https://github.com/hansschenker/rxjs-rsl-astra-01) expression adapter. See [UPSTREAM.json](UPSTREAM.json) for the revision and original blob hashes.

Runtime source, TypeScript configuration, package metadata, and schema match the upstream snapshot. The standard-function inventory test uses `import.meta.resolve("jsonata")` so it works with npm's dependency hoisting. This README is adapted to the vendored layout. No other behavioral changes are made here.

Run all inherited tests from the rxjs-red root with `npm run test:evaluator` after installing root dependencies.

Canonical documents remain in the original repository:

- [Expression and Context Profile](https://github.com/hansschenker/rxjs-rsl-astra-01/blob/6aca96176e8662c468dabed11e8104d2e4a17a51/docs/RSL-Expression-and-Context-Profile-v0.1.md)
- [Expression Schema and Validator](https://github.com/hansschenker/rxjs-rsl-astra-01/blob/6aca96176e8662c468dabed11e8104d2e4a17a51/docs/RSL-Expression-Schema-and-Validator-v0.1.md)
- [Synchronous Evaluator Adapter](https://github.com/hansschenker/rxjs-rsl-astra-01/blob/6aca96176e8662c468dabed11e8104d2e4a17a51/docs/RSL-Synchronous-Evaluator-Adapter-v0.1.md)
