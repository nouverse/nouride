/**
 * The coding CLIs built in, one file each in this folder, all of one shape (`row.ts`). Adding one is its file and its
 * line here (`docs/CODING_CLIS.md`); the contract test holds every file of the folder to being listed, and every row to
 * the shape.
 */

import type { CliRow } from "./row.ts";
import { antigravity } from "./antigravity.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { grok } from "./grok.ts";

export const BUILT_IN_CLIS: readonly CliRow[] = [claudeCode, codex, antigravity, cursor, grok];

export { helpersUpdate, type CliPreset, type CliRow, type CliUse, type UseLimit, type UseReader, type UseToken, type UseWindow } from "./row.ts";
