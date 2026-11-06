/**
 * Run before the CLI (`--preload`): as it exits, whether the secret store's key is still in its environment, written to
 * the file `KEY_AT_EXIT` names. The launcher hands root's key to every command run through it (0.8.19), and what a
 * command starts must inherit none of it.
 */

import { writeFileSync } from "node:fs";

const out = process.env.KEY_AT_EXIT;
if (out) process.on("exit", () => writeFileSync(out, process.env.NOURIDE_ENCRYPTION_KEY === undefined ? "gone" : "still there"));
