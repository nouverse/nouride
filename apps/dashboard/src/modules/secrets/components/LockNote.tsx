/**
 * How the secrets are kept (0.8.19): locked, and how far the key that unlocks them is from them, which is what the
 * lock is worth. Said in plain words for people who are not technical (the owner, 2026-11-05); where the key is, and
 * what to do about it, is `nouride doctor`'s to say to whoever runs the server.
 */

import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { SecretLock } from "@nouride/wire";

/** The sentence for each state, and whether it is one to act on. Pure. */
export function lockWords(lock: SecretLock): { text: string; warn: boolean } {
  if (!lock.encrypted) return { text: "Your secrets will be locked a few minutes after this update finishes.", warn: false };
  if (lock.key?.level === "install") {
    return { text: "Your secrets are saved locked. The key is kept next to Nouride's folder for now, and moves somewhere safer the next time Nouride is installed again on this server.", warn: false };
  }
  if (lock.key?.level === "data") {
    return { text: "Your secrets are saved locked, but the key is kept with them, so a copy of Nouride's data could open them. Whoever runs this server can keep the key separately.", warn: true };
  }
  return { text: "Your secrets are saved locked, and the key that opens them is kept apart from them.", warn: false };
}

export function LockNote({ lock }: { lock: SecretLock | undefined }) {
  // A daemon before 0.8.19 does not say: nothing to tell.
  if (!lock) return null;
  const { text, warn } = lockWords(lock);
  const Icon = warn ? ShieldAlert : ShieldCheck;
  return (
    <p className={`flex shrink-0 items-start gap-2 px-1 text-xs ${warn ? "text-warning" : "text-base-content/65"}`}>
      <Icon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
