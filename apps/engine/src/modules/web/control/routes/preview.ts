/**
 * A preview of HTML an agent wrote: the `html` block of a reply, HTML written straight into one, or an `.html` file
 * among Nouride's files, served as the page it is so a person can look at it.
 *
 * It is somebody else's page, written by a model, and it is served from the dashboard's own address. So it is served
 * under a policy of its own (`PREVIEW_SECURITY_HEADERS`, `web/server.ts`), and three things hold whatever the page
 * tries:
 *
 * - **It reaches nothing.** No request leaves it: not to the daemon's API, not to the web. What it shows is what is
 *   written in it: its own markup, styles and scripts, and pictures given as `data:`.
 * - **It is nobody.** It runs with no origin of its own, so the session's cookie, the dashboard's storage and the
 *   page around it are not its to read, in a frame and in a tab alike.
 * - **It stays where it is.** It cannot move the page around it, open a window or send a form.
 *
 * And the daemon takes the HTML from what it has stored, never from what the browser sends: a request names a turn
 * and where in its reply the HTML is, or a file by its path, and nothing in it is served back.
 *
 * A frame the dashboard filled itself would take the dashboard's policy, under which the page's own scripts do not
 * run and its requests go where the dashboard's may: that is why this is a route.
 */

import { readFileRange } from "@nouride/runtime";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { conversationFor } from "../conversation.ts";
import { isHtmlRun } from "../html-run.ts";
import { filesRoot, findFile } from "../system-files.ts";
import { readerOf } from "../whose.ts";
import { hidden } from "./system-files.ts";

/** The control API's paths that answer under the preview's policy. */
export const PREVIEW_PATH = "/preview";

/** A page larger than this, in a file's bytes or a block's characters, is not previewed: it is read whole. A choice. */
const PREVIEW_MAX = 2 * 1024 * 1024;

/** What a refusal says, as a page: the frame shows it where the preview would have been. */
const said = (words: string) => `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;color:#555;padding:24px">${words}</body>`;

/**
 * What is added after a page's own words so that the page says how tall it is. In a chat a reply's page is drawn in the
 * reply itself, in a frame the dashboard cannot see into: without this it is a box of one height for a line of text
 * and for a long page alike. The page tells the frame around it its height, and again when that changes; in a tab of
 * its own it says nothing. The dashboard holds what it hears to its own bounds, since a page's own script can say a
 * number too.
 */
const SAYS_ITS_HEIGHT =
  '\n<script>(function(){if(parent===window)return;var d=document,say=function(){var b=d.body;parent.postMessage({nouridePreviewHeight:Math.max(d.documentElement.offsetHeight,b?b.scrollHeight:0)},"*")};if(window.ResizeObserver)new ResizeObserver(say).observe(d.documentElement);addEventListener("load",say);say()})()</script>';

/**
 * A page as it is served: its words as they are stored, then `SAYS_ITS_HEIGHT`. Words that are a page's inside, with
 * no doctype and no `<html>` of their own, are given the doctype a page begins with: without one a browser lays them
 * out as pages of the last century were, where the page is always as tall as its frame and its height says nothing.
 */
export function asPage(html: string): string {
  const whole = /^\s*<(?:!doctype\b|html[\s>])/i.test(html);
  return `${whole ? "" : "<!doctype html>\n"}${html}${SAYS_ITS_HEIGHT}`;
}

/** Kept by no cache, and read as the type it is sent as: the next look reads what is stored then. */
const PAGE = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" };

/**
 * The words of an `html` block of a reply, by where they are in it, or null where that is not one: `at` must follow a
 * fence line that names `html`, and what comes after `length` characters must be the fence's end. Besides a run of
 * HTML written with no fence (`htmlRunAt`), no other part of a reply is a page somebody wrote to be looked at, and
 * none is served as one.
 */
export function htmlBlockAt(reply: string, at: number, length: number): string | null {
  // A place counted from the reply's start, in whole characters: one counted back from its end is nowhere.
  if (!Number.isInteger(at) || !Number.isInteger(length) || at < 0 || length <= 0) return null;
  const opened = /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*html\b[^\n]*\n$/i.exec(reply.slice(0, at));
  if (!opened) return null;
  const closes = new RegExp(`^\\n?[ \\t]*${opened[1]![0] === "`" ? "`" : "~"}{${opened[1]!.length},}[ \\t]*(?:\\n|$)`);
  return closes.test(reply.slice(at + length)) ? reply.slice(at, at + length) : null;
}

/**
 * The words of a run of HTML an agent wrote straight into its reply, with no fence around it, by where they are in
 * it, or null where that is not one (`html-run.ts`). Asked for HTML, a model often writes the tags as they are.
 */
export function htmlRunAt(reply: string, at: number, length: number): string | null {
  return isHtmlRun(reply, at, length) ? reply.slice(at, at + length) : null;
}

export function registerPreviewRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * An `html` block of a turn's reply, or a run of HTML written straight into it: `?at=` and `?length=` say where in
   * the stored reply it is. Read by whoever may open the turn's conversation, as the turn itself is.
   */
  control.get(`${PREVIEW_PATH}/turn/:id`, (c) => {
    const turn = deps.turns?.get(c.req.param("id"));
    const reader = readerOf(c.get("principal"), deps.ctx.config.people);
    if (!turn || !(reader.everyone || conversationFor(deps, reader, turn.sessionId))) return c.html(said("This is not there to preview."), 404);
    const [at, length] = [Number(c.req.query("at")), Number(c.req.query("length"))];
    const html = htmlBlockAt(turn.reply ?? "", at, length) ?? htmlRunAt(turn.reply ?? "", at, length);
    if (html === null) return c.html(said("This is not there to preview."), 404);
    if (html.length > PREVIEW_MAX) return c.html(said("This page is too large to preview here."), 413);
    return c.body(asPage(html), 200, PAGE);
  });

  /** An `.html` file among Nouride's files, by its path there. An admin's, as every route of the files is. */
  control.get(`${PREVIEW_PATH}/file`, async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.html(said("Only an admin can open Nouride's files."), 403);
    const found = findFile(filesRoot(deps.ctx.configSource, deps.ctx.config.daemon.dataDir), c.req.query("path") ?? "");
    if (!found.ok || !/\.html?$/i.test(found.entry.name)) return c.html(said("This is not there to preview."), 404);
    const size = found.entry.sizeBytes ?? 0;
    if (size > PREVIEW_MAX) return c.html(said("This page is too large to preview here."), 413);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(await readFileRange(found.real, 0, size).arrayBuffer()));
    // Its words as the Files page shows them: a credential written into a page is hidden here too.
    return c.body(asPage(hidden(raw, deps.secrets.knownValues())), 200, PAGE);
  });
}
