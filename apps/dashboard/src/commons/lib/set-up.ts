/**
 * Setting up a coding CLI that is not on the server yet (0.8.19): whether the orchestrator can do it, and what it is
 * asked, for the Models page's Coding CLIs and an external agent's Brain tab alike.
 */

/**
 * An install the orchestrator can run for you: a package manager's, as `nouride tools run` takes (`cli/commands/tools.ts`).
 * One a person added that installs some other way it cannot, and the page says who can instead.
 */
export const byInstaller = (install: string): boolean => /^(npm|bun|pipx|uv|pip3?|cargo|go|rustup) /.test(install);

/** What the orchestrator is asked, for the person to read and send (the owner's words, 2026-11-05). */
export const setUpMessage = (name: string): string =>
  `Please install ${name} on this server, with what Nouride needs to use it as an agent (its ACP adapter), and tell me when it is ready to sign in.`; // plain-words-ok: the agent is told what to install, in the words it knows
