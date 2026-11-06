/**
 * Signing out, asked first — from the sidebar and from My Account alike.
 *
 * The sidebar's Sign Out sits beside the theme toggle, one misclick away, and ended the session at
 * once. One hook for both buttons, so they ask the same question and do the same thing.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/commons/lib/api";
import { useConfirm } from "@/commons/components/ui/confirm";

export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { ask, dialog } = useConfirm();

  const signOut = async () => {
    const sure = await ask({ title: "Sign out?", body: "You will need your password to come back in.", confirmLabel: "Sign out", cancelLabel: "Stay", danger: false, emphasis: "cancel" });
    if (!sure) return;
    await api.logout().catch(() => {});
    queryClient.clear();
    void navigate({ to: "/login" });
  };

  return { signOut, dialog };
}
