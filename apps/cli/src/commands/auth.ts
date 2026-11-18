/**
 * `nouride auth device --name "<label>"`: a device token for a Home app on this machine, so it never lands on the
 * dashboard's sign-in. Asked of the daemon with the control token, which only someone who can read the data folder
 * holds; the daemon binds it to the first admin and keeps only its hash. Its value is printed once, here.
 */

import type { Client } from "@nouride/cli-kit";
import { flagValue, BOLD, DIM, GREEN, RESET, say, usageError, usageLines, plain } from "@nouride/cli-kit";

interface DeviceView {
  id: string;
  label: string;
  username: string;
}

const USAGE = `${DIM}nouride auth device --name "<label>"   a device token for a Home app on this machine${RESET}`;

export async function authCommand(client: Client, args: string[]): Promise<void> {
  const [what] = args;
  if (what !== "device") usageError(what ? `\`nouride auth\` has no "${what}".` : "usage: nouride auth device --name <label>", plain(USAGE));
  const name = flagValue(args, "--name");
  if (!name) usageLines(USAGE);
  const made = await client.post<{ device: DeviceView; value: string }>("/auth/devices", { name });
  say(`${GREEN}✓${RESET} device ${BOLD}${made.device.id}${RESET} "${made.device.label}", signs in as ${made.device.username}`);
  say(`\n  ${BOLD}${made.value}${RESET}\n  ${DIM}Shown once. The app trades it at ${client.baseUrl}/api/control/auth/device for a session; revoke it on the Users page.${RESET}`);
}
