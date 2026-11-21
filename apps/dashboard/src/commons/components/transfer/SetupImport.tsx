/**
 * The setup's first page, for someone who is moving and not starting: one line under the form that opens the import
 * card in its place on the page. A new install that takes a file needs none of the setup's steps: it comes back as the
 * other machine's Nouride, already set up.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/commons/lib/api";
import { ImportCard } from "./ImportCard";

export function SetupImport() {
  const [open, setOpen] = useState(false);
  const state = useQuery({ queryKey: ["transfer"], queryFn: api.transfer, enabled: open });
  if (open) return <ImportCard state={state.data} title="Bring your Nouride in from the other machine" />;
  return (
    <p className="text-center text-sm text-base-content/70" data-setup-import>
      Moving from another machine?{" "}
      <button type="button" className="link link-primary font-semibold" onClick={() => setOpen(true)}>
        Bring its file in
      </button>{" "}
      instead of setting up from nothing.
    </p>
  );
}
