/**
 * A password a person types, with an eye to see what was typed (0.8.23): making the admin on the first visit, the owner
 * could not check the password before saving it (2026-11-08). For a password someone chooses or signs in with, and its
 * confirmation; a key or a token that is pasted (Secrets, a provider's key) keeps a plain password field.
 *
 * Hidden until asked, and hidden again by the same button. The button never submits the form, so Enter in the field
 * still does.
 */

import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/commons/lib/utils";

export function PasswordInput({ className, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...input} type={shown ? "text" : "password"} className={cn(className, "pr-10")} />
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square absolute right-2 top-1/2 -translate-y-1/2 rounded-lg text-base-content/65 hover:text-base-content"
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onClick={() => setShown((now) => !now)}
      >
        {shown ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}
