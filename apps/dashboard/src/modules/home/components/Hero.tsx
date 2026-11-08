/**
 * Home's greeting (0.8.24): the cat waving, or saying good night late in the evening, the person's name, one line on
 * what is going on, and the main action, a new chat.
 */

import { Link } from "@tanstack/react-router";
import { MessageSquarePlus } from "lucide-react";
import { Mascot } from "@/commons/components/brand/Mascot";

/** The greeting for the hour it is where the person is, and whether it is the night's. */
export function greetingAt(hour: number): { words: string; night: boolean } {
  if (hour >= 5 && hour < 12) return { words: "Good morning", night: false };
  if (hour >= 12 && hour < 18) return { words: "Good afternoon", night: false };
  if (hour >= 18 && hour < 22) return { words: "Good evening", night: false };
  return { words: "Good night", night: true };
}

export function Hero({ name, line, hour = new Date().getHours() }: { name: string; line: string; hour?: number }) {
  const { words, night } = greetingAt(hour);
  return (
    <section className="hero-soft flex items-center gap-4 overflow-hidden rounded-[22px] border border-base-content/[0.08] p-4 shadow-soft sm:gap-6 sm:p-6">
      <Mascot pose={night ? "goodNight" : "waving"} className="-my-2 w-24 sm:-my-4 sm:w-40" />
      <div className="min-w-0 space-y-1.5 sm:space-y-3">
        <h1 className="text-2xl leading-tight text-base-content sm:text-4xl">
          {words}
          {name ? `, ${name}` : ""}
        </h1>
        {line && <p className="text-sm text-base-content/70 sm:text-base">{line}</p>}
        <Link to="/chat" className="btn btn-primary mt-1 gap-2 max-sm:hidden">
          <MessageSquarePlus size={17} aria-hidden="true" />
          New chat
        </Link>
      </div>
    </section>
  );
}
