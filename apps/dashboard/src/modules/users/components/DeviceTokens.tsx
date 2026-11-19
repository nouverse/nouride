/**
 * The devices that stay signed in: Home apps on this machine, each with a token `nouride auth device` made. Listed
 * for an admin, each with who it signs in as and when it last did, and revoked here: the app's next trade is then
 * refused and it lands on the sign-in. None is made from here: making one needs the machine itself.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Smartphone, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";
import { shortWhen } from "@/commons/lib/when";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";

export function DeviceTokens() {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, enabled: admin, retry: false });
  const queryClient = useQueryClient();
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeDevice(id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }) });
  const { ask, dialog } = useConfirm();
  if (!admin || devices.error) return null;
  const list = devices.data?.devices ?? [];

  return (
    <Card title="Devices that stay signed in" description="Nouride Home on the machine Nouride runs on stays signed in without a password, until it is taken off here. Taken off, that app asks for a password again.">
      {dialog}
      {list.length === 0 ? (
        <p className="text-sm text-base-content/65" data-devices="none">
          None yet. A device is added from the machine Nouride runs on, never from here.
        </p>
      ) : (
        <ul className="divide-y divide-base-content/[0.06]">
          {list.map((device) => (
            <li key={device.id} data-device={device.id} className="flex min-h-11 items-center gap-3 py-2.5">
              <Smartphone size={16} className="shrink-0 text-base-content/60" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-base-content">{device.label}</span>
                <span className="block text-xs text-base-content/65">
                  Signs in as {device.username} · {device.lastUsedAt ? `last ${shortWhen(device.lastUsedAt)}` : "not used yet"}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm min-h-11 gap-1.5 text-error"
                disabled={revoke.isPending}
                onClick={async () => {
                  const yes = await ask({ title: `Revoke ${device.label}?`, body: "That app is signed out now, and asks for a password the next time it opens.", confirmLabel: "Revoke" });
                  if (yes) revoke.mutate(device.id);
                }}
              >
                <Trash2 size={14} aria-hidden="true" /> Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={revoke.error} />
    </Card>
  );
}
