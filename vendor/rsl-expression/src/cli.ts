#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  expressionUnitSchema,
  parseExpressionDocument,
  validateExpression,
} from "./index.js";
const file = process.argv[2];
if (file === "--schema")
  console.log(JSON.stringify(expressionUnitSchema, null, 2));
else if (!file || process.argv.length !== 3) {
  console.error(
    "Usage: rsl-expression-validate <unit.json|unit.yaml> | --schema",
  );
  process.exitCode = 2;
} else {
  try {
    const source = readFileSync(file, "utf8");
    const parsed = parseExpressionDocument(
      source,
      file,
      file.endsWith(".json") ? "json" : "yaml",
    );
    if (parsed.diagnostics.length) {
      console.log(
        JSON.stringify(
          { valid: false, status: "invalid", diagnostics: parsed.diagnostics },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    } else {
      const result = validateExpression(parsed.document);
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `Cannot validate ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
