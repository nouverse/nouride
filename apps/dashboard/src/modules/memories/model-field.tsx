/**
 * A model field for one provider profile: what the profile lists, as suggestions, and only the kind
 * this field takes — embedding models for semantic search, chat models for the nightly pass. A
 * profile that lists none of that kind says so, rather than offering the other kind.
 *
 * Suggestions only, like every model picker here (`Combobox`): the list is whatever the endpoint's
 * `/v1/models` says. Whether a model really embeds is the engine's to check, and it does, before
 * semantic search is switched on.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { Combobox } from "@/commons/components/ui/Combobox";
import { isEmbeddingModel } from "@/commons/lib/model-kind";

export function ModelField(props: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
  kind: "embedding" | "chat";
  /** Listing a profile's models is an admin's; everyone else types. */
  admin: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const models = useQuery({
    queryKey: ["provider-models", props.provider],
    queryFn: () => api.providerModels(props.provider),
    enabled: props.admin && Boolean(props.provider),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const listed = models.data?.ok ? models.data.models : [];
  const options = listed.filter((model) => isEmbeddingModel(model) === (props.kind === "embedding"));
  return (
    <div className="space-y-1">
      <Combobox
        options={options}
        loading={models.isLoading && models.fetchStatus !== "idle"}
        value={props.value}
        onChange={props.onChange}
        disabled={props.disabled ?? false}
        {...(props.placeholder ? { placeholder: props.placeholder } : {})}
      />
      {listed.length > 0 && options.length === 0 ? (
        <p className="text-warning text-xs">
          {props.provider} lists no {props.kind === "embedding" ? "embedding" : "chat"} models. {props.kind === "embedding" ? "Pick a provider that embeds, like Ollama with bge-m3." : "Pick another provider."}
        </p>
      ) : null}
    </div>
  );
}
