/**
 * Linking a WhatsApp account by scanning a QR code.
 * Remade with Apple HIG: clear visual instructions, elegant QR container,
 * and live pairing polling.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { CheckCircle2, Loader2, QrCode } from "lucide-react";
import { api } from "@/commons/lib/api";

export function WhatsAppPairing({ gatewayId }: { gatewayId: string }) {
  const pairing = useQuery({
    queryKey: ["pairing", gatewayId],
    queryFn: () => api.pairing(gatewayId),
    refetchInterval: (query) => (query.state.data?.linked ? false : 3_000),
    retry: false,
  });

  const [image, setImage] = useState<string | null>(null);
  const qr = pairing.data?.qr ?? null;

  useEffect(() => {
    if (!qr) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(qr, { margin: 1, width: 240, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setImage(url);
      })
      .catch(() => {
        if (!cancelled) setImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qr]);

  if (pairing.isPending) {
    return (
      <div className="flex items-center gap-2.5 py-4 text-xs font-medium text-base-content/65">
        <Loader2 size={15} className="animate-spin text-primary" /> Checking WhatsApp link status…
      </div>
    );
  }

  if (pairing.error) {
    return (
      <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning text-xs rounded-xl p-3">
        <span>This WhatsApp connection is not running yet. Restart Nouride after saving to start it.</span>
      </div>
    );
  }

  if (pairing.data?.linked) {
    return (
      <div className="border border-success/30 bg-success/10 flex items-center gap-3 rounded-2xl p-4 shadow-xs">
        <CheckCircle2 size={20} className="text-success shrink-0" />
        <div className="text-sm">
          <p className="font-bold text-success">Device Linked & Authenticated</p>
          <p className="text-base-content/70 mt-0.5">
            WhatsApp session is active and securely encrypted. It will remain linked across restarts.
          </p>
        </div>
      </div>
    );
  }

  if (!image) {
    return (
      <div className="flex items-center gap-2.5 py-4 text-xs font-medium text-base-content/65">
        <Loader2 size={15} className="animate-spin text-primary" /> Getting the QR code to pair with…
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 p-4 rounded-2xl bg-base-200/40 border border-base-content/[0.08]">
      <div className="p-3 bg-white rounded-2xl border border-base-300 shadow-md shrink-0">
        <img
          src={image}
          alt="WhatsApp QR pairing code"
          className="rounded-xl"
          width={240}
          height={240}
        />
      </div>

      <div className="space-y-3.5 text-sm max-w-md">
        <div className="flex items-center gap-2">
          <QrCode size={16} className="text-primary" />
          <h4 className="font-bold text-base-content text-sm sm:text-base">Scan with WhatsApp</h4>
        </div>

        <ol className="space-y-2.5 text-base-content/80">
          <li className="flex items-start gap-2.5">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-xs grid place-items-center shrink-0 mt-0.5">1</span>
            <span>Open WhatsApp on your phone → tap <b>Settings</b> → <b>Linked Devices</b>.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-xs grid place-items-center shrink-0 mt-0.5">2</span>
            <span>Tap <b>Link a Device</b> and point your camera at this QR code.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-xs grid place-items-center shrink-0 mt-0.5">3</span>
            <span className="text-base-content/65">
              The QR code auto-refreshes every 20 seconds. Once scanned, pairing is complete.
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}
