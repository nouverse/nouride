/**
 * Setting up a coding CLI that is not on the server yet (0.8.19): whether the orchestrator can do it, and what it is
 * asked, for the Models page's Coding CLIs and an external agent's Brain tab alike.
 */

/**
 * An install the orchestrator can run for you: a package manager's, as `nouride tools run` takes (`cli/commands/tools.ts`),
 * or `nouride agents install`, for a built-in CLI its maker installs with its own script. One a person added
 * that installs some other way it cannot, and the page says who can instead.
 */
export const byInstaller = (install: string): boolean => /^(npm|bun|pipx|uv|pip3?|cargo|go|rustup|nouride agents install) /.test(install);

/**
 * A coding CLI updated to the newest version this Nouride was tested with, or put back to the version before a failed
 * check (0.8.24): asked of the orchestrator as Set it up is, the command named so it runs the one that checks the new
 * version before the CLI's agents work again.
 */
export const updateMessage = (name: string, cli: string): string =>
  `Please update ${name} on this server with \`nouride agents update ${cli}\`, and tell me how it went.`; // plain-words-ok: the agent is told the command to run

export const goBackMessage = (name: string, cli: string, version: string): string =>
  `Please put ${name} on this server back to ${version} with \`nouride agents update ${cli} ${version}\`, and tell me how it went.`; // plain-words-ok: the agent is told the command to run

/**
 * What the orchestrator is asked, for the person to read and send: by the command that installs it where Nouride has
 * one, else what to install.
 */
export const setUpMessage = (name: string, install: string): string =>
  install.startsWith("nouride ")
    ? `Please install ${name} on this server with \`${install}\`, and tell me when it is ready to sign in.` // plain-words-ok: the agent is told the command to run
    : `Please install ${name} on this server, with what Nouride needs to use it as an agent (its ACP adapter), and tell me when it is ready to sign in.`; // plain-words-ok: the agent is told what to install, in the words it knows
