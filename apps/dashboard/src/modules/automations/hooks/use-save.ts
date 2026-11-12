/**
 * Saving an automation's page: a new one is made (through the webhooks' door when its address is what starts it,
 * which is an admin's), one that exists is sent what changed and nothing else. What the server refuses is kept for the
 * page to say, with the step it names: a refusal's own words begin "step 3: …", and its everyday ones are what is said.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JobInput } from "@nouride/wire";
import { ApiError, failureWords } from "@/commons/lib/api.client";
import { api } from "@/commons/lib/api";
import { useToast } from "@/commons/components/ui/toast";
import { createBody, patchBody, type Draft } from "../lib/draft";
import { refusedStep } from "../lib/steps";

export interface Saving {
  save: () => void;
  pending: boolean;
  /** The last save's refusal, until the next save or a discard. */
  error: unknown;
  /** The step that refusal names, and what to say on its card. */
  refused: { index: number; message: string } | null;
  forget: () => void;
}

/** `id`: the automation being changed; none for one being made. `onSaved` is told the id it has now. */
export function useSave(id: string | null, was: Draft, now: Draft, onSaved: (id: string) => void): Saving {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const saving = useMutation({
    mutationFn: async (): Promise<string> => {
      if (id) return (await api.cronUpdate(id, patchBody(was, now))).job.id;
      const body = createBody(now);
      return now.start === "webhook" ? (await api.webhookCreate(body)).webhook.id : (await api.cronCreate(body as JobInput)).job.id;
    },
    onSuccess: async (saved) => {
      setError(null);
      toast.success(id ? "Changes saved" : "Automation saved", now.name.trim());
      // Asked again before the page lets go of the draft, so it is never drawn as it was before the save.
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
      onSaved(saved);
    },
    onError: setError,
  });

  // The route's own words name the step; they are under Details, and the everyday ones are what the card says.
  const said = error instanceof ApiError ? (error.server?.error ?? error.message) : undefined;
  const index = refusedStep(said);
  return {
    save: () => saving.mutate(),
    pending: saving.isPending,
    error,
    refused: error && index !== null && index < now.steps.length ? { index, message: failureWords(error).said } : null,
    forget: () => setError(null),
  };
}
