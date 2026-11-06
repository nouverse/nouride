import { Cpu, Wifi, Wrench } from "lucide-react";
import type { BoxState } from "@/commons/lib/api.appliance";
import { Card } from "@/commons/components/ui/ui";
import { QrTile } from "./QrTile";

export function CodesCard({ state }: { state: BoxState }) {
  return (
    <Card title="Codes for this box" description="The same codes as the sticker on the box, for when it's out of reach.">
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 justify-items-center">
        <QrTile
          payload={state.setup.wifiQr}
          title="Setup Wi-Fi"
          caption={
            <>
              Joins <span className="font-mono">{state.setup.ssid}</span>. The box only offers it when it has no Wi-Fi of its own.
            </>
          }
        />
        {state.network.dashboardUrl && (
          <QrTile
            payload={state.network.dashboardUrl}
            title="This dashboard"
            caption={
              <>
                Opens <span className="font-mono">{state.network.dashboardUrl}</span> on a phone on the same Wi-Fi.
              </>
            }
          />
        )}
        <div className="flex flex-col items-center gap-3 text-center self-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-base-content/[0.05] text-base-content/65">
            {state.claimed ? <Cpu size={20} /> : <Wifi size={20} />}
          </span>
          <p className="text-xs text-base-content/65 leading-relaxed max-w-[240px]">
            The card’s QR joins the setup Wi-Fi, whose password is the PIN. {state.claimed ? "This box is claimed." : "Claim the box from this page."}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-base-content/65">
            <Wrench size={11} /> The PIN also signs in to the setup console, where the box’s Wi-Fi is changed.
          </p>
        </div>
      </div>
    </Card>
  );
}

