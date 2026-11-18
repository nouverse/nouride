/**
 * A picture a mission handed back, served to its page: what its report draws in place where it names one of its own
 * result files (`![what it shows](flow.png)`). A report was text alone on the page: its pictures reached the chat as
 * files, and the page listed them by name.
 *
 * By its place among the result's files and never by a path, so nothing is served but a file the mission itself named
 * as its result; to whoever may see the mission, as its page is; and a picture only.
 */

import { statFile } from "@nouride/runtime";
import { asciiName, fileResponse } from "../file-response.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { thingOfMission, thingsFor } from "../whose.ts";

/**
 * What the page may draw, by the file's ending: what a browser draws as a picture and nothing else. Not an SVG: opened
 * by its address it is a document, and what it holds would run as the dashboard.
 */
const RESULT_PICTURES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A result's picture past this is not drawn in the page: 20 MB, a choice, well over a diagram or a screenshot. */
const RESULT_PICTURE_BYTES = 20 * 1024 * 1024;

export function registerMissionPictureRoute(control: ControlApp, deps: ControlDeps): void {
  control.get("/missions/:id/files/:index", (c) => {
    const missions = deps.missions;
    if (!missions) return c.json({ error: "missions are not run in this process" }, 501);
    const mission = missions.find(c.req.param("id"));
    if (!mission || !thingsFor(deps, c.get("principal")).sees(thingOfMission(mission))) return c.json({ error: "no such file" }, 404);
    // A whole number and nothing else: `0x1` and `-1` are no place in a list.
    const place = c.req.param("index") ?? "";
    const path = /^\d+$/.test(place) ? mission.files[Number.parseInt(place, 10)] : undefined;
    const type = path ? RESULT_PICTURES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] : undefined;
    if (!path || !type) return c.json({ error: "no such file" }, 404);
    const stat = statFile(path);
    // Named by the result and gone since: said as that, where a broken picture would read as a bug.
    if (!stat || stat.isDirectory) return c.json({ error: "that file is no longer on disk" }, 410);
    if (stat.size > RESULT_PICTURE_BYTES) return c.json({ error: "that picture is too large to draw here" }, 413);
    return fileResponse(path, stat.size, c.req.header("range"), {
      "content-type": type,
      "content-disposition": `inline; filename="${asciiName(path.slice(path.lastIndexOf("/") + 1))}"`,
      // Private, as it is somebody's work, and short, since a mission's folder is removed a week after it ends.
      "cache-control": "private, max-age=300",
    });
  });
}
