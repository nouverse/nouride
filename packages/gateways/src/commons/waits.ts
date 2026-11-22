/** A length of time as a person says it, for what a connection waits on: "45 seconds", "30 minutes", "1 hour 5 minutes". */
export function waitWords(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;
  if (whole < 90) return unit(whole, "second");
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}`;
}
