/**
 * One turn read whole by its id — what `nouride turns show` prints (`GET /turns/:id`): each model call with why it
 * ended, what each request carried, and the work it handed to the background. The payload types are `@nouride/wire`'s.
 */

import { control, request } from "./api.client";
import type { TurnRecordDetail } from "@nouride/wire";

export const turnsApi = {
  turnRecord: (id: string) => request<TurnRecordDetail>(`${control}/turns/${encodeURIComponent(id)}`),
};
