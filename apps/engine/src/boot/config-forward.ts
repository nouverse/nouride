/**
 * What a start writes into an older install's `config.toml` before anything is built from it, in order.
 *
 * Each step is a setting an earlier build read from a guess or a default that this build reads from the file, written
 * once so the install goes on as it was. Each says in its own file what it writes and why, does nothing the second
 * time, and leaves the daemon to start when the file cannot be written. Run holding the data folder's lock, so no
 * second daemon writes beside it.
 */

import { readTextFileIfExists } from "@nouride/runtime";
import type { GlobalConfig } from "@nouride/shared";
import type { BuildEdition } from "@/commons/build.ts";
import { bringEndpointKeysForward } from "./endpoint-keys.ts";
import { keepRouterGatewayOn } from "./router-gateway.ts";
import { keepSharedWhatsappLogin } from "./whatsapp-login.ts";

export async function bringConfigForward(input: { configPath: string; config: GlobalConfig; carried: boolean; edition: BuildEdition }): Promise<void> {
  // A Router install's gateway kept on (`router-gateway.ts`).
  await keepRouterGatewayOn(input);
  // A profile on a known endpoint given what it needs, before any client is built from it (`endpoint-keys.ts`).
  await bringEndpointKeysForward(input);
  // An install's one WhatsApp login kept where it is, before any connection opens (`whatsapp-login.ts`).
  await keepSharedWhatsappLogin({ configPath: input.configPath, config: input.config, source: (await readTextFileIfExists(input.configPath)) ?? "" });
}
