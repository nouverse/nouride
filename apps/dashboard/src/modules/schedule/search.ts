/**
 * The Schedule page's place in the URL (0.8.11): one job, `?job=<id>`, the link an agent hands a person for the job it
 * proposed. Its card is scrolled to, marked and its runs open. An id that is not one — anything but letters, digits,
 * `_` and `-` — is dropped, so the page opens as it would without it; one the list does not hold changes nothing.
 */

export interface ScheduleSearch {
  job?: string;
}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseScheduleSearch(search: Record<string, unknown>): ScheduleSearch {
  return typeof search.job === "string" && JOB_ID.test(search.job) ? { job: search.job } : {};
}

/** A job's card, by its id: what `?job=` scrolls to. */
export function jobCardId(jobId: string): string {
  return `job-${jobId}`;
}
