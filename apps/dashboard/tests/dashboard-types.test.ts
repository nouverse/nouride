/**
 * How the dashboard is typechecked: as strictly as the rest of the repository, and as browser code.
 *
 * Its tsconfig was the one project in `lint:types` that did not extend `tsconfig.base.json`, so `noUnusedLocals`,
 * `noUnusedParameters` and `noUncheckedIndexedAccess` — on everywhere else, and said in the contributing guide to be
 * on — were off here, and 48 dead imports and locals had collected in seventeen files.
 *
 * And `@types/qrcode` handed every file Node's globals, by `/// <reference types="node" />`: `process.env`, `Buffer`
 * and `__dirname` typechecked clean in code that throws the moment a tab runs it. The tsconfig's
 * `types: ["vite/client"]` was never the gap — it stops `@types` packages being added by name, not one package's types
 * pulling another in by reference — so the second test asks the compiler which files the program is made of.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import ts from "typescript";

const CONFIG = join(dirname(import.meta.path), "..", "tsconfig.json");

function parsed(): ts.ParsedCommandLine {
  const config = ts.getParsedCommandLineOfConfigFile(CONFIG, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!config) throw new Error(`could not read ${CONFIG}`);
  return config;
}

describe("the dashboard's types", () => {
  test("are held to the rules every other project is", () => {
    const { noUnusedLocals, noUnusedParameters, noUncheckedIndexedAccess, strict } = parsed().options;
    expect({ noUnusedLocals, noUnusedParameters, noUncheckedIndexedAccess, strict }).toEqual({
      noUnusedLocals: true,
      noUnusedParameters: true,
      noUncheckedIndexedAccess: true,
      strict: true,
    });
  });

  test("have no Node globals in them", () => {
    const config = parsed();
    // Resolved, not checked: which files are in the program is decided before any of them is typechecked.
    const files = ts.createProgram({ rootNames: config.fileNames, options: config.options }).getSourceFiles();

    const isNode = (name: string) => name.includes("/@types/node/");
    // Named by what referenced it, so a failure says which package to drop rather than only that Node is in.
    const broughtBy = files
      .filter((file) => !isNode(file.fileName) && file.typeReferenceDirectives.some((ref) => ref.fileName === "node"))
      .map((file) => file.fileName.slice(file.fileName.lastIndexOf("node_modules/") + "node_modules/".length));

    expect({ nodeFiles: files.filter((file) => isNode(file.fileName)).length, broughtBy }).toEqual({ nodeFiles: 0, broughtBy: [] });
  });
});
