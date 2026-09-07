# Working on rxjs-red

- RxJS 7.8.2 is the fixed behavioral baseline. Keep dependency pins and the lockfile.
- Preserve canonical RSL specifications. `rxjs-red.graph/0.1` is a scoped editor transport profile, not a canonical language replacement.
- Use functions and readonly TypeScript contracts. Node-RED registration requires constructor functions; keep those wrappers inert and small.
- An Observable is a description; compilation must not subscribe or schedule. Make cancellation, timing, and sharing explicit.
- Use the vendored synchronous RSL adapter for expressions. Do not replace it with Node-RED's JSONata evaluator.
- Keep provenance for changes under `vendor/rsl-expression`. Runtime source and schema initially match the pinned upstream revision.
- The source-of-truth palette is `nodes/catalog.json`; regenerate `nodes/rsl.html` through the build script.
- Run `npm run check` before shipping behavior changes. Use virtual-time and lifecycle assertions for semantic risks.
- Keep `.data`, dependencies, generated TypeScript output, credentials, and logs out of Git.
- Do not publish to npm. The package is intentionally private.
