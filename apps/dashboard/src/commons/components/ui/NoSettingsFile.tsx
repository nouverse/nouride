/**
 * Said where a setting cannot be saved because the daemon has no settings file to write: it runs on its defaults, or
 * from what it was started with. In plain words, with the keys to set by hand under Details for whoever runs the server
 * (0.8.19). It was "This daemon has no config file to write. Set `[x] y` and restart", six times over.
 */

import { Details } from "./Details";
import { cn } from "@/commons/lib/utils";

export function NoSettingsFile({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <div className={cn("text-base-content/65 mt-1.5 space-y-1 text-xs", className)}>
      <p>This cannot be changed from the dashboard on this server.</p>
      <Details>
        <p>
          There is no <code>config.toml</code> to write. Set{" "}
          {keys.map((key, index) => (
            <span key={key}>
              {index > 0 ? " and " : ""}
              <code className="bg-base-200 rounded px-1.5 py-0.5 font-mono">{key}</code>
            </span>
          ))}{" "}
          in it, then restart.
        </p>
      </Details>
    </div>
  );
}
