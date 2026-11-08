/**
 * What may be said about a secret (0.8.19, the owner's custom fields): a name and a text each, as many as a person
 * needs (`domain`, `username`, `email`, `what`, or anything), shown to people and to agents. So never secret: a field
 * whose text has the shape of a credential is refused, naming the field, before it is written where anyone reads it.
 */

import { findSecrets } from "./scan.ts";
import { handlesIn } from "./transient.ts";
import { SecretError } from "./store-error.ts";

const MAX_FIELDS = 20;
const MAX_FIELD_NAME = 40;
const MAX_FIELD_TEXT = 500;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9 _-]*$/;

export interface FieldChange {
  set?: Record<string, string>;
  remove?: readonly string[];
}

function assertField(secret: string, name: string, text: string): void {
  if (!name || name.length > MAX_FIELD_NAME || !FIELD_NAME.test(name)) {
    throw new SecretError(`"${name}" is not a field name for ${secret}: letters, digits, spaces, dashes and underscores, starting with a letter, at most ${MAX_FIELD_NAME}`, "fields");
  }
  if (text.length > MAX_FIELD_TEXT) throw new SecretError(`${secret}'s field "${name}" is longer than ${MAX_FIELD_TEXT} characters`, "fields");
  if (/[\r\n]/.test(text)) throw new SecretError(`${secret}'s field "${name}" is more than one line`, "fields");
  if (handlesIn(text).length > 0 || findSecrets(text, "ingress").length > 0) {
    throw new SecretError(`${secret}'s field "${name}" looks like a key or a password, and fields are shown to everyone: store it as a secret's value instead`, "fields");
  }
}

/** `fields` with `change` applied, each checked, or a refusal naming what is wrong. Pure. */
export function changedFields(secret: string, fields: Readonly<Record<string, string>>, change: FieldChange): Record<string, string> {
  const next: Record<string, string> = { ...fields };
  for (const name of change.remove ?? []) delete next[name.trim()];
  for (const [rawName, rawText] of Object.entries(change.set ?? {})) {
    const name = rawName.trim();
    const text = String(rawText).trim();
    assertField(secret, name, text);
    if (text) next[name] = text;
    else delete next[name];
  }
  if (Object.keys(next).length > MAX_FIELDS) throw new SecretError(`${secret} would have more than ${MAX_FIELDS} fields`, "fields");
  return next;
}
