import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { Loader2 } from "lucide-react";

function useQrImage(payload: string | null, width = 220): string | null {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (!payload) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(payload, { margin: 1, width, errorCorrectionLevel: "M" })
      .then((url) => !cancelled && setImage(url))
      .catch(() => !cancelled && setImage(null));
    return () => {
      cancelled = true;
    };
  }, [payload, width]);
  return image;
}

export function QrTile({ payload, title, caption }: { payload: string | null; title: string; caption: ReactNode }) {
  const image = useQrImage(payload);
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="bg-white rounded-2xl p-3 shadow-xs border border-base-content/[0.08]">
        {image ? (
          <img src={image} alt={title} width={180} height={180} className="block h-[180px] w-[180px]" />
        ) : (
          <div className="flex h-[180px] w-[180px] items-center justify-center">
            <Loader2 size={18} className="animate-spin text-base-content/40" />
          </div>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-base-content">{title}</p>
        <div className="text-xs text-base-content/65 leading-relaxed max-w-[240px]">{caption}</div>
      </div>
    </div>
  );
}

