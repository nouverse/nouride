/**
 * A provider as its form holds it while it is being filled in, on the Models page and in the first-run setup: how it
 * is talked to, its address, its name and its extra headers, and what pointing it at a service fills.
 *
 * The name and the headers follow what the form picks (a service under "How to get an API key", a kind of provider)
 * until the person types their own, and then they are theirs. The name was "keep whatever is there", and the setup's
 * form opens with a name already in it: a person who picked Anthropic there saved a provider named `openai`. The
 * headers follow the same way, or the one OpenCode Go asks for would stay on a form since pointed at another service.
 */

import { useRef, useState } from "react";
import { headersFromText, headersToText } from "@/commons/lib/extra-headers";

type Kind = "openai" | "anthropic";

/** A field the form itself can fill: it follows a pick until what it holds was typed. */
function useFollowed(initial: string): { value: string; set: (typed: string) => void; follow: (picked: string) => void } {
  const [value, set] = useState(initial);
  /** The last value the form itself put there: one that differs from it was typed. */
  const filled = useRef(initial);
  return {
    value,
    set,
    follow: (picked) => {
      if (value.trim() !== "" && value !== filled.current) return;
      filled.current = picked;
      set(picked);
    },
  };
}

export function useProviderDraft(start: { name: string; kind: Kind; baseUrl: string; headers?: Record<string, string | null>; /** A provider that is already saved. */ saved?: boolean }) {
  const [kind, setKind] = useState<Kind>(start.kind);
  const [baseUrl, setBaseUrl] = useState(start.baseUrl);
  const name = useFollowed(start.name);
  const headers = useFollowed(headersToText(start.headers));
  return {
    kind,
    setKind,
    baseUrl,
    setBaseUrl,
    name: name.value,
    setName: name.set,
    /** The extra headers as the lines of their field, and as what a save sends (`lib/extra-headers.ts`). */
    headers: headers.value,
    setHeaders: headers.set,
    sentHeaders: () => headersFromText(headers.value),
    /**
     * Point it at a service, or at a kind of provider: how it is talked to and its address, with its name and the
     * headers it asks for. A saved provider keeps its name, which agents refer to it by, and its saved headers,
     * which may be its operator's own: a pick fills them only where there are none.
     */
    point: (to: { kind: Kind; baseUrl: string; name: string; headers?: Record<string, string> }) => {
      setKind(to.kind);
      setBaseUrl(to.baseUrl);
      if (!start.saved) name.follow(to.name);
      if (!start.saved || headers.value.trim() === "") headers.follow(headersToText(to.headers));
    },
  };
}
