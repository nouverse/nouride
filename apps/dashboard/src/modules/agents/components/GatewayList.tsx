/**
 * The connections belonging to one agent.
 * Remade with Apple HIG: clean gateway cards, platform badges,
 * modal forms, and restart notices.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { defaultConnectionName } from "@/modules/agents/components/connection-name";
import { waitingSaid } from "@/modules/agents/components/gateway-waiting";
import { PLATFORMS, platformsToAdd, type Platform } from "@/modules/agents/components/gateway-platforms";
import { Plus, Trash2 } from "lucide-react";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";
import type { GatewayInstance } from "@nouride/wire";
import { Card, EmptyState, ErrorNote, Field, StatusDot } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { WhatsAppPairing } from "./WhatsAppPairing";
import { RestartNeeded } from "@/commons/components/box/RestartNeeded";
import { Details } from "@/commons/components/ui/Details";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { ListLoading } from "@/commons/components/ui/Spinner";

export function GatewayList({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  // Asked again while one is on its way up: its row says what it waits on, and that it has connected, without a reload.
  const gateways = useQuery({
    queryKey: ["gateways"],
    queryFn: api.gateways,
    refetchInterval: (query) => (query.state.data?.gateways.some((gateway) => gateway.enabled && (gateway.status === "connecting" || gateway.status === "reconnecting")) ? 10_000 : false),
  });
  const [adding, setAdding] = useState<Platform | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["gateways"] });

  const mine = (gateways.data?.gateways ?? []).filter((gateway) => gateway.agent === agentId);
  const pendingRestart = mine.some((gateway) => gateway.enabled && gateway.status === null);
  // Nothing is offered until the agent's own connections are known: a moment of all three would offer what it has.
  const toAdd = gateways.data ? platformsToAdd(mine) : [];
  // What a connection with no override of its own inherits. Served by the daemon rather than repeated
  // here, so the field cannot advertise a default the engine no longer has.
  const groupContextDefault = gateways.data?.groupContextDefault ?? 20;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-base-content/65 max-w-xl text-sm leading-relaxed">
          The chat apps this agent answers on. A message that comes in on one goes straight to it.
        </p>

        {toAdd.length > 0 && <DropdownMenu
          trigger={<><Plus size={16} /> Add Connection</>}
          triggerClassName="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
          width={208}
          menuClassName="bg-base-100/95 backdrop-blur-xl rounded-2xl border border-base-content/10 p-2 shadow-xl"
        >
          {(close) =>
            toAdd.map((platform) => (
              <li key={platform.id}>
                <button
                  type="button"
                  className="rounded-xl py-2 font-medium text-sm active:scale-95"
                  onClick={() => {
                    close();
                    setAdding(platform.id);
                  }}
                >
                  <span className="font-semibold">{platform.label}</span>
                </button>
              </li>
            ))
          }
        </DropdownMenu>}
      </div>

      {/* A connection is opened at boot: one added or changed since is saved, and not connected until a restart. */}
      {pendingRestart && <RestartNeeded>a connection added or changed since Nouride started connects then</RestartNeeded>}

      {adding && (
        <GatewayForm
          platform={adding}
          agentId={agentId}
          groupContextDefault={groupContextDefault}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void refresh();
          }}
        />
      )}

      {gateways.isPending ? (
        <ListLoading />
      ) : mine.length === 0 ? (
        <Card>
          <EmptyState
            pose="noSignal"
            title="No connections configured"
            description="Link a Telegram bot, Discord bot, or WhatsApp account to start chatting with this agent."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {mine.map((gateway) => (
            <GatewayCard
              key={gateway.id}
              gateway={gateway}
              agentId={agentId}
              groupContextDefault={groupContextDefault}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GatewayCard({
  gateway,
  agentId,
  groupContextDefault,
  onChanged,
}: {
  gateway: GatewayInstance;
  agentId: string;
  groupContextDefault: number;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const saved = useSaved();
  const remove = useMutation({
    mutationFn: () => api.deleteGateway(gateway.id),
    onSuccess: (answer) => {
      saved(answer, `Connection ${gateway.id} removed`);
      onChanged();
    },
  });
  const platform = PLATFORMS.find((entry) => entry.id === gateway.platform);
  const { ask, dialog } = useConfirm();
  const waiting = waitingSaid(gateway);

  return (
    <Card
      title={`${platform?.label ?? gateway.platform} (${gateway.name})`}
      description={gateway.id}
      actions={
        <div className="flex items-center gap-2">
          <StatusDot status={gateway.enabled ? gateway.status : null} />
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg font-medium hover:bg-base-200"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
            onClick={async () => {
              const yes = await ask({
                title: `Remove connection ${gateway.id}?`,
                body: platform?.pairs
                  ? "This unlinks WhatsApp: the number has to be paired again to come back."
                  : "Its saved bot token is deleted, and the agent stops answering on it.", // plain-words-ok: the bot token, the platform's own word
                confirmLabel: "Remove",
              });
              if (yes) remove.mutate();
            }}
            aria-label="Remove connection"
          >
            <Trash2 size={14} />
          </button>
        </div>
      }
    >
      {editing ? (
        <GatewayForm
          platform={gateway.platform}
          agentId={agentId}
          existing={gateway}
          groupContextDefault={groupContextDefault}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : (
        <>
          {waiting ? (
            <p role="status" className="mb-4 rounded-xl border border-warning/20 bg-warning/10 p-3 text-sm break-words text-base-content">
              {waiting}
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
              <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
                Connects When Nouride Starts
              </dt>
              <dd className="font-semibold text-base-content">{gateway.enabled ? "Yes" : "No"}</dd>
            </div>
            <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
              <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
                Group Context
              </dt>
              <dd className="font-semibold text-base-content">
                {(gateway.groupContextMessages ?? groupContextDefault) === 0 ? (
                  "Off"
                ) : (
                  <>
                    {gateway.groupContextMessages ?? groupContextDefault} messages
                    {gateway.groupContextMessages === undefined && (
                      <span className="text-base-content/65 font-normal"> (the default)</span>
                    )}
                  </>
                )}
              </dd>
            </div>
            <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
              <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
                Its Key
              </dt>
              <dd>
                {gateway.hasCredential ? (
                  <>
                    <span className="font-semibold text-base-content">Saved</span>
                    <Details>
                      <p>
                        As the secret <code className="bg-base-300/80 px-1.5 py-0.5 rounded-md text-[11px]">{gateway.tokenSecret || `${gateway.id}-key`}</code>
                      </p>
                    </Details>
                  </>
                ) : (
                  <span className="text-error font-medium">Not saved yet</span>
                )}
              </dd>
            </div>
          </dl>
        </>
      )}

      {platform?.pairs && gateway.enabled && !editing && (
        <div className="mt-5 pt-5 border-t border-base-content/[0.08]">
          <WhatsAppPairing gatewayId={gateway.id} agentId={agentId} />
        </div>
      )}

      <ErrorNote error={remove.error} />
      {dialog}
    </Card>
  );
}

function GatewayForm({
  platform,
  agentId,
  existing,
  groupContextDefault,
  onClose,
  onSaved,
}: {
  platform: Platform;
  agentId: string;
  existing?: GatewayInstance;
  groupContextDefault: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const meta = PLATFORMS.find((entry) => entry.id === platform);
  const [name, setName] = useState(existing?.name ?? defaultConnectionName(agentId));
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  /**
   * Kept as the raw string, not a number.
   *
   * A numeric state would turn a half-deleted field into `NaN` or, worse, into 0 — which is the off
   * position, so clearing the box to retype it would submit "never read the room again". Parsed once,
   * on submit, and an unparseable value is simply not sent.
   */
  const [groupContext, setGroupContext] = useState(
    String(existing?.groupContextMessages ?? groupContextDefault),
  );

  const saved = useSaved();
  const groupContextValue = Number.parseInt(groupContext, 10);
  const groupContextValid =
    Number.isInteger(groupContextValue) && groupContextValue >= 0 && groupContextValue <= 100;

  const save = useMutation({
    mutationFn: () =>
      api.saveGateway({
        platform,
        name,
        enabled,
        agent: agentId,
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(groupContextValid ? { groupContextMessages: groupContextValue } : {}),
      }),
    onSuccess: (answer) => {
      saved(answer, `Connection ${platform}:${name}`);
      onSaved();
    },
  });

  const body = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {meta?.note && (
        <div className="alert alert-info bg-info/10 border border-info/30 text-info text-xs rounded-xl p-3">
          <span>{meta.note}</span>
        </div>
      )}

      <Field
        label="Name for This Connection"
        hint={`Its id becomes ${platform}:${name || "…"}.`}
      >
        <input
          className="input w-full rounded-xl text-sm"
          value={name}
          disabled={Boolean(existing)}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>

      <Field
        label={meta?.tokenLabel ?? "Key"}
        hint={
          existing
            ? "Leave it empty to keep the one saved."
            : meta?.tokenHint
        }
      >
        <input
          className="input w-full font-mono text-sm rounded-xl"
          type="password"
          autoComplete="off"
          placeholder={existing ? "•••••••••••• (unchanged)" : ""}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>

      <Field
        label="Group Context (this connection only)"
        hint={
          groupContextValid
            ? groupContextValue === 0
              ? `Off for this connection: in groups the agent only sees the message that tagged it. Every other connection still follows the setting for every agent (${groupContextDefault}), changed on the Agents page.`
              : `Messages replayed when the agent is tagged in a group. Overrides the setting for every agent, ${groupContextDefault}, which is changed on the Agents page.`
            : "Enter a whole number between 0 (off) and 100."
        }
      >
        <input
          className={`input w-full rounded-xl text-sm ${groupContextValid ? "" : "input-error"}`}
          type="number"
          min={0}
          max={100}
          step={1}
          value={groupContext}
          onChange={(e) => setGroupContext(e.target.value)}
        />
      </Field>

      <div className="p-3 rounded-xl bg-base-200/50 border border-base-content/[0.06] flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-base-content block">Connect When Nouride Starts</span>
          <span className="text-base-content/65 text-xs">This connection starts whenever Nouride does.</span>
        </div>
        <input
          type="checkbox"
          className="toggle toggle-primary toggle-sm"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </div>

      <ErrorNote error={save.error} />

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
          disabled={save.isPending || !groupContextValid}
        >
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          {existing ? "Save Changes" : "Add Connection"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );

  if (existing) return body;
  return (
    <Card title={`Add ${meta?.label ?? platform} Connection`} className="border-primary/30 shadow-lg">
      {body}
    </Card>
  );
}
