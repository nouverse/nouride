import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, KeyRound, Loader2, Wifi } from "lucide-react";
import { applianceApi as api, type BoxState } from "@/commons/lib/api.appliance";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";

export function LocalCard({ state }: { state: BoxState }) {
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: api.boxResetSetupLogin,
    onSuccess: (next) => queryClient.setQueryData(["box"], next),
  });
  const open = useMutation({
    mutationFn: api.boxOpenSetup,
    onSuccess: (result) => queryClient.setQueryData(["box"], result.state),
  });
  const names = state.localNames ?? [];
  const hotspot = state.setupHotspot;
  const setup = state.setupLogin;
  const { ask, dialog } = useConfirm();

  return (
    <Card title="On your network" description="Easy addresses for this box, and the sign-in for its setup console.">
      {dialog}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div className="space-y-2.5">
          <p className="flex items-center gap-2 text-sm font-semibold text-base-content">
            <Globe size={15} className="text-primary" /> Local addresses
          </p>
          {names.length ? (
            <ul className="space-y-1.5">
              {names.map((name) => (
                <li key={name}>
                  <a href={`http://${name}`} target="_blank" rel="noreferrer" className="link link-hover font-mono text-sm">
                    http://{name}
                  </a>
                  <span className="text-xs text-base-content/65"> ({name.startsWith("nougate") ? "Nougate" : "this dashboard"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-base-content/65">Not announced yet: the box has no address on your network.</p>
          )}
          <p className="text-[11px] text-base-content/65 leading-relaxed">
            Works on iPhone, Mac, Windows and Linux. Chrome on Android doesn’t support .local names; use the address above instead.
          </p>
        </div>

        <div className="space-y-2.5">
          <p className="flex items-center gap-2 text-sm font-semibold text-base-content">
            <KeyRound size={15} className="text-primary" /> Setup console sign-in
          </p>
          <p className="text-xs text-base-content/65 leading-relaxed">
            {setup?.cardDefault
              ? "The username and PIN on the quickstart card."
              : `Changed on the box to “${setup?.username ?? ""}”. The card no longer opens the setup console.`}
          </p>
          {setup && !setup.cardDefault && (
            <button
              type="button"
              className="btn btn-sm btn-outline btn-warning rounded-xl"
              disabled={reset.isPending}
              onClick={async () => {
                const yes = await ask({
                  title: "Reset the setup console sign-in?",
                  body: `The username and PIN printed on the quickstart card open the setup console again, and “${setup.username}” stops working.`,
                  confirmLabel: "Reset to the card",
                });
                if (yes) reset.mutate();
              }}
            >
              {reset.isPending ? <Loader2 size={14} className="animate-spin" /> : null} Reset to the card
            </button>
          )}
          {reset.error ? <ErrorNote error={reset.error} /> : null}
        </div>

        <div className="space-y-2.5 sm:col-span-2 border-t border-base-content/[0.06] pt-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-base-content">
            <Wifi size={15} className="text-primary" /> Setup console
          </p>
          <p className="text-xs text-base-content/65 leading-relaxed">
            To change this box’s Wi-Fi, reset its accounts or reset it to factory, open its setup Wi-Fi for 15 minutes and join{" "}
            <span className="font-mono">{hotspot?.ssid ?? "Nouride-Setup"}</span> (the card’s QR, or the PIN as the password). The box stays online meanwhile.
          </p>
          {hotspot?.open ? (
            <p className="text-xs font-medium text-success">The setup Wi-Fi is on now. Open http://10.42.0.1 once your phone is on it.</p>
          ) : (
            <button type="button" className="btn btn-sm btn-outline rounded-xl gap-2" disabled={open.isPending} onClick={() => open.mutate()}>
              {open.isPending ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />} Open setup Wi-Fi
            </button>
          )}
          {open.error ? <ErrorNote error={open.error} /> : null}
          <p className="text-[11px] text-base-content/65 leading-relaxed">
            Can’t reach this dashboard? Unplug the box three times in a row, each within a minute of plugging it in, and the setup Wi-Fi comes
            up and its sign-in goes back to the card.
          </p>
        </div>
      </div>
    </Card>
  );
}
