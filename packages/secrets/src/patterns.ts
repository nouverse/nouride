/**
 * Every shape of credential the daemon recognises in text — one list, so adding one is adding a row.
 *
 * Two readers, through `findSecrets` (`scan.ts`). A message a person sends is scanned as it arrives, and what matches
 * is taken out before anything stores it or a model reads it: that reader has to be right, because a false hit takes
 * a word out of somebody's message. And `redact` (`redact.ts`) scrubs drafts, audit rows and memory's transcripts,
 * where over-eager is the point — a masked SHA costs a draft a little precision, a leaked token an incident.
 *
 * So each rule has a tier:
 * - **certain** — a vendor's own format, a prefix and a length nothing else has. Both readers take it.
 * - **context** — a key that names a secret, then `=` or `:`, then a value that looks like one: `TOKEN=…`,
 *   `password: …`, `"api_key": "…"`, `kata sandi: …`. Both readers take it, and only when `accept` agrees the value is
 *   a credential rather than a word, a name or code — so `token: expired` and `token = process.env.TOKEN` stay as they
 *   were written. A secret a sentence names without one ("password wifi gw …") is not looked for: the ways of saying
 *   it are endless, guessing at them took ordinary words out of messages, and `/secret set` is the sure way.
 * - **eager** — what only `redact` takes: the looser shapes it has always masked, anything assigned to a
 *   secret-sounding key, long hex.
 *
 * A rule names the part that is secret with a `value` group; without one the whole match is. `redactAs` is the
 * coarser name `redact` has always written (`[redacted:api-key]`), so a scrubbed draft reads as it did.
 *
 * Every rule carries examples it must take, value exact, and near-misses nothing may take; the package's tests hold
 * each row to its own. The examples are built at run time (`sample`): a token spelled out in the source is one a
 * secret scanner flags, whether or not it was ever real. Patterns are a vendor's documented format or one seen in the
 * wild — never a guess, since a guessed prefix is a word somebody will type.
 */

export type SecretTier = "certain" | "context" | "eager";

/** Text a rule must take, and exactly the part of it that is the secret. */
export interface SecretExample {
  text: string;
  value: string;
}

export interface SecretPattern {
  /** Stable, kebab-case: what a log line names. */
  id: string;
  /** What a person reads: "an OpenAI-style key". */
  label: string;
  tier: SecretTier;
  /** What `redact` writes in its place: `[redacted:<redactAs>]`. */
  redactAs: string;
  /** Global. A named group `value` is the secret part; without one, the whole match is. */
  pattern: RegExp;
  /** Whether a matched value is a credential — a context rule's half of the decision. */
  accept?: (value: string) => boolean;
  examples: readonly SecretExample[];
  /** Text nothing in the registry may take from a message. */
  nearMisses?: readonly string[];
}

const BASE62 = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOWER = "abcdefghijkmnopqrstuvwxyz23456789";
const DIGITS = "0123456789";

/** A credential-shaped string of `length` after `prefix`, the same on every run — for the examples. */
export function sample(prefix: string, length: number, alphabet = BASE62): string {
  let seed = [...`${prefix}${length}${alphabet}`].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
  let out = prefix;
  for (let i = 0; i < length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out += alphabet[(seed >>> 8) % alphabet.length];
  }
  return out;
}

/** An example whose whole text is the secret. */
const whole = (text: string): SecretExample => ({ text, value: text });

/** An example where only `value` is the secret, between what names it and what follows it. */
const within = (before: string, value: string, after = ""): SecretExample => ({ text: before + value + after, value });

/** A token on its own, not the middle of a longer one — `\b`, for tokens that may hold `-` and `_`. */
const token = (body: string) => new RegExp(`(?<![A-Za-z0-9_-])${body}(?![A-Za-z0-9_-])`, "g");

/** Words and digits joined by `_` or `-`, in one case, with a word among them: an identifier somebody named. */
const nameLike = (value: string) =>
  /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+$/.test(value) &&
  (value === value.toLowerCase() || value === value.toUpperCase()) &&
  value.split(/[_-]/).some((part) => /^[A-Za-z]{3,}$/.test(part));

const kindsOf = (value: string) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9_-]/].filter((kind) => kind.test(value)).length;

/**
 * Whether a value something names as a secret is one, rather than a word, a name, a reference or code.
 *
 * What a key called `token` holds is as often `nougate` (a Nouride config names its secrets), `${TOKEN}`,
 * `process.env.TOKEN` or `./secrets/token` as a credential, and taking one of those out of a message takes out the part
 * of it that mattered. Short of all that: more than one kind of character — "Hunter2024!" is a password, "expired" is
 * a word.
 */
export function plausibleSecret(value: string): boolean {
  if (value.length < 6 || value.length > 512) return false;
  // A reference or a placeholder: ${KEY}, $KEY, %KEY%, <your key>, {{ secrets.KEY }}, xxxx, ****.
  if (/^(?:\$\{?\w+\}?|%\w+%|<.*>|\{\{.*\}\}|x{4,}|\*{4,}|\.{3,}|…)$/i.test(value)) return false;
  // An address or a path.
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|~?\.{0,2}\/)/i.test(value) || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value)) return false;
  // A number, a date, a time, an address, a version.
  if (/^[\d.,:/_-]+$/.test(value) || /^v?\d+(?:\.\d+)+(?:[-+][\w.]+)?$/i.test(value)) return false;
  // A word or a name: `expired`, `openai_main`, `your-secret-key`, `TokenType` — and a name with a digit in it,
  // `e2e_saved_token`, `AWS_S3_BUCKET`: words joined by `_` or `-` in one case, which a key or a password rarely is.
  // ("Simpan token tadi sebagai e2e_saved_token" lost the name it asked for, on the box.) A UUID has no word in it.
  if (/^[A-Za-z]+(?:[_-][A-Za-z]+)*$/.test(value) || nameLike(value)) return false;
  // Code: `process.env.TOKEN`, `getenv("TOKEN")`, `z.string().min(8)`.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /[()[\]{}]/.test(value)) return false;
  return kindsOf(value) >= 2;
}

/** What a key assigned a secret is called: `DB_PASSWORD`, `api_key`, `authToken`, `kata sandi`. */
const SECRET_KEY = "(?:passwo?rd|passwd|passphrase|sandi|secret|token|api[_-]?key|apikey|access[_-]?key|credentials?|private[_-]?key|auth[_-]?key)";

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // ── keys ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "private-key",
    label: "a private key",
    tier: "certain",
    redactAs: "private-key",
    // To its END line or, pasted cut short, to the end of its base64.
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|(?:\s*[A-Za-z0-9+/]{16,}={0,2})+)/g,
    examples: [
      whole(`-----BEGIN OPENSSH PRIVATE KEY-----\n${sample("b3BlbnNzaC1rZXktdjE", 51)}\n-----END OPENSSH PRIVATE KEY-----`),
      whole(`-----BEGIN RSA PRIVATE KEY-----\n${sample("MIIEow", 58)}\n${sample("", 64)}\n-----END RSA PRIVATE KEY-----`),
      whole(`-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${sample("lQOYBF", 58)}\n-----END PGP PRIVATE KEY BLOCK-----`),
      within("my key:\n", `-----BEGIN PRIVATE KEY-----\n${sample("MIIEvQ", 58)}\n${sample("", 40)}==`, "\n\nthanks"),
    ],
    nearMisses: ["-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----", "-----BEGIN CERTIFICATE-----"],
  },
  {
    id: "putty-key",
    label: "a PuTTY private key",
    tier: "certain",
    redactAs: "private-key",
    pattern: /PuTTY-User-Key-File-\d+: [\s\S]*?Private-MAC: [a-f0-9]{40,}/g,
    examples: [whole(`PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\n${sample("AAAAI", 43)}\nPrivate-MAC: ${sample("", 64, HEX)}`)],
  },
  {
    id: "age-secret-key",
    label: "an age secret key",
    tier: "certain",
    redactAs: "private-key",
    pattern: token("AGE-SECRET-KEY-1[0-9A-Z]{58}"),
    examples: [whole(sample("AGE-SECRET-KEY-1", 58, UPPER))],
  },

  // ── model providers ────────────────────────────────────────────────────────────────────────────────────────────
  { id: "anthropic-key", label: "an Anthropic key", tier: "certain", redactAs: "api-key", pattern: token("sk-ant-[A-Za-z0-9_-]{20,}"), examples: [whole(sample("sk-ant-api03-", 95, BASE64URL))] },
  { id: "openrouter-key", label: "an OpenRouter key", tier: "certain", redactAs: "api-key", pattern: token("sk-or-v1-[a-f0-9]{40,}"), examples: [whole(sample("sk-or-v1-", 64, HEX))] },
  { id: "nougate-key", label: "a Nougate key", tier: "certain", redactAs: "api-key", pattern: token("sk-nou-[A-Za-z0-9_-]{40,}"), examples: [whole(sample("sk-nou-", 43, BASE64URL))] },
  {
    id: "openai-key",
    label: "an OpenAI-style key",
    tier: "certain",
    redactAs: "api-key",
    // `sk-` is OpenAI's, and DeepSeek's and Moonshot's and most compatible gateways' after it: hex, or a random run with
    // a capital and a digit in it — which a kebab-case name after `sk-` is not.
    pattern: token("sk-(?!ant-|or-|nou-)(?:[a-f0-9]{32,}|(?=[\\w-]*[A-Z])(?=[\\w-]*[0-9])[A-Za-z0-9_-]{20,})"),
    examples: [whole(sample("sk-proj-", 156, BASE64URL)), whole(sample("sk-", 48)), whole(sample("sk-", 32, HEX))],
    nearMisses: ["pip install sk-learn", "the sk-hynix-memory-prices-2025 report", "sk-12345", "task-1234567890123456789012"],
  },
  { id: "google-api-key", label: "a Google API key", tier: "certain", redactAs: "api-key", pattern: token("AIza[0-9A-Za-z_-]{35}"), examples: [whole(sample("AIza", 35, BASE64URL))] },
  { id: "google-oauth-secret", label: "a Google OAuth client secret", tier: "certain", redactAs: "api-key", pattern: token("GOCSPX-[A-Za-z0-9_-]{28}"), examples: [whole(sample("GOCSPX-", 28, BASE64URL))] },
  { id: "groq-key", label: "a Groq key", tier: "certain", redactAs: "api-key", pattern: token("gsk_[A-Za-z0-9]{40,}"), examples: [whole(sample("gsk_", 52))] },
  { id: "xai-key", label: "an xAI key", tier: "certain", redactAs: "api-key", pattern: token("xai-[A-Za-z0-9]{40,}"), examples: [whole(sample("xai-", 80))] },
  { id: "huggingface-token", label: "a Hugging Face token", tier: "certain", redactAs: "api-key", pattern: token("hf_[A-Za-z0-9]{30,}"), examples: [whole(sample("hf_", 34))] },
  { id: "replicate-token", label: "a Replicate token", tier: "certain", redactAs: "api-key", pattern: token("r8_[A-Za-z0-9]{30,}"), examples: [whole(sample("r8_", 37))] },
  { id: "perplexity-key", label: "a Perplexity key", tier: "certain", redactAs: "api-key", pattern: token("pplx-[A-Za-z0-9]{40,}"), examples: [whole(sample("pplx-", 48))] },
  { id: "cerebras-key", label: "a Cerebras key", tier: "certain", redactAs: "api-key", pattern: token("csk-[a-z0-9]{40,}"), examples: [whole(sample("csk-", 48, LOWER))] },

  // ── code hosts and registries ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "github-token",
    label: "a GitHub token",
    tier: "certain",
    redactAs: "api-key",
    pattern: token("(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})"),
    examples: [whole(sample("ghp_", 36)), whole(sample("ghs_", 36)), whole(`github_pat_${sample("", 22)}_${sample("", 59)}`)],
    nearMisses: ["ghp_short", "the ghp_ prefix"],
  },
  { id: "gitlab-token", label: "a GitLab token", tier: "certain", redactAs: "api-key", pattern: token("gl(?:pat|dt|ptt|rt|cbt|imt|oas|soat|ft|agent)-[A-Za-z0-9_-]{20,}"), examples: [whole(sample("glpat-", 20, BASE64URL)), whole(sample("glrt-", 26, BASE64URL))] },
  { id: "bitbucket-app-password", label: "a Bitbucket app password", tier: "certain", redactAs: "api-key", pattern: token("ATBB[A-Za-z0-9_=.-]{32,}"), examples: [whole(sample("ATBB", 32))] },
  { id: "npm-token", label: "an npm token", tier: "certain", redactAs: "api-key", pattern: token("npm_[A-Za-z0-9]{36}"), examples: [whole(sample("npm_", 36))] },
  { id: "pypi-token", label: "a PyPI token", tier: "certain", redactAs: "api-key", pattern: token("pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}"), examples: [whole(sample("pypi-AgEIcHlwaS5vcmc", 70, BASE64URL))] },
  { id: "dockerhub-token", label: "a Docker Hub token", tier: "certain", redactAs: "api-key", pattern: token("dckr_pat_[A-Za-z0-9_-]{24,}"), examples: [whole(sample("dckr_pat_", 27, BASE64URL))] },
  { id: "atlassian-token", label: "an Atlassian API token", tier: "certain", redactAs: "api-key", pattern: token("ATATT3[A-Za-z0-9_=-]{50,}"), examples: [whole(sample("ATATT3", 180, BASE64URL))] },

  // ── chat platforms ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "telegram-bot-token",
    label: "a Telegram bot token",
    tier: "certain",
    redactAs: "api-key",
    pattern: /(?<![\w:])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
    examples: [whole(`${sample("", 10, DIGITS)}:AA${sample("", 33, BASE64URL)}`)],
    nearMisses: ["12345678:short", "at 10:30:45 on 2026-10-18"],
  },
  {
    id: "discord-bot-token",
    label: "a Discord bot token",
    tier: "certain",
    redactAs: "api-key",
    pattern: token("[MNO][A-Za-z0-9_-]{23,25}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,38}"),
    examples: [whole(`M${sample("", 25, BASE64URL)}.${sample("G", 5, BASE64URL)}.${sample("", 38, BASE64URL)}`)],
  },
  {
    id: "discord-webhook",
    label: "a Discord webhook URL",
    tier: "certain",
    redactAs: "api-key",
    pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{60,}/g,
    examples: [whole(`https://discord.com/api/webhooks/${sample("", 19, DIGITS)}/${sample("", 68, BASE64URL)}`)],
  },
  {
    id: "slack-token",
    label: "a Slack token",
    tier: "certain",
    redactAs: "api-key",
    pattern: token("(?:xox[abeprs]-\\d+-[A-Za-z0-9-]{10,}|xapp-\\d-[A-Z0-9]+-\\d+-[a-f0-9]{30,})"),
    examples: [
      whole(`xoxb-${sample("", 12, DIGITS)}-${sample("", 13, DIGITS)}-${sample("", 24)}`),
      whole(`xapp-1-${sample("A", 10, UPPER)}-${sample("", 13, DIGITS)}-${sample("", 64, HEX)}`),
    ],
    nearMisses: ["xoxo-hugs-and-kisses-from-jakarta"],
  },
  {
    id: "slack-webhook",
    label: "a Slack webhook URL",
    tier: "certain",
    redactAs: "api-key",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g,
    examples: [whole(`https://hooks.slack.com/services/${sample("T", 10, UPPER)}/${sample("B", 10, UPPER)}/${sample("", 24)}`)],
  },

  // ── cloud and infrastructure ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "aws-access-key",
    label: "an AWS access key",
    tier: "certain",
    redactAs: "api-key",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
    examples: [whole(sample("AKIA", 16, UPPER)), whole(sample("ASIA", 16, UPPER))],
  },
  {
    id: "aws-secret-key",
    label: "an AWS secret key",
    tier: "certain",
    redactAs: "assigned-secret",
    pattern: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?(?<value>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    examples: [within("aws_secret_access_key = ", sample("", 40)), within("AWS_SECRET_ACCESS_KEY=", sample("", 40))],
  },
  {
    id: "azure-storage-key",
    label: "an Azure storage key",
    tier: "certain",
    redactAs: "assigned-secret",
    pattern: /AccountKey=(?<value>[A-Za-z0-9+/]{40,}={0,2})/g,
    examples: [within("DefaultEndpointsProtocol=https;AccountName=box;AccountKey=", `${sample("", 86)}==`, ";EndpointSuffix=core.windows.net")],
  },
  { id: "digitalocean-token", label: "a DigitalOcean token", tier: "certain", redactAs: "api-key", pattern: token("do[opr]_v1_[a-f0-9]{64}"), examples: [whole(sample("dop_v1_", 64, HEX))] },
  { id: "supabase-token", label: "a Supabase token", tier: "certain", redactAs: "api-key", pattern: token("sbp_[a-f0-9]{40}"), examples: [whole(sample("sbp_", 40, HEX))] },
  { id: "vault-token", label: "a HashiCorp Vault token", tier: "certain", redactAs: "api-key", pattern: token("hv[sbr]\\.[A-Za-z0-9_-]{24,}"), examples: [whole(sample("hvs.", 90, BASE64URL))] },
  { id: "terraform-token", label: "a Terraform Cloud token", tier: "certain", redactAs: "api-key", pattern: token("[A-Za-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9_=-]{60,}"), examples: [whole(`${sample("", 14)}.atlasv1.${sample("", 67, BASE64URL)}`)] },
  { id: "doppler-token", label: "a Doppler token", tier: "certain", redactAs: "api-key", pattern: token("dp\\.(?:pt|st|sa|ct|scim|audit)\\.[A-Za-z0-9]{40,}"), examples: [whole(sample("dp.st.", 43))] },
  { id: "netlify-token", label: "a Netlify token", tier: "certain", redactAs: "api-key", pattern: token("nfp_[A-Za-z0-9]{36,}"), examples: [whole(sample("nfp_", 40))] },
  { id: "sentry-token", label: "a Sentry token", tier: "certain", redactAs: "api-key", pattern: token("sntry[su]_[A-Za-z0-9_=+/]{40,}"), examples: [whole(sample("sntrys_", 64))] },
  { id: "grafana-token", label: "a Grafana token", tier: "certain", redactAs: "api-key", pattern: token("(?:glsa_[A-Za-z0-9]{32}_[a-f0-9]{8}|glc_[A-Za-z0-9+/=]{32,})"), examples: [whole(`${sample("glsa_", 32)}_${sample("", 8, HEX)}`), whole(sample("glc_", 64))] },
  { id: "newrelic-key", label: "a New Relic key", tier: "certain", redactAs: "api-key", pattern: token("NRAK-[A-Z0-9]{27}"), examples: [whole(sample("NRAK-", 27, UPPER))] },
  { id: "onepassword-token", label: "a 1Password service account token", tier: "certain", redactAs: "api-key", pattern: token("ops_eyJ[A-Za-z0-9+/=_-]{100,}"), examples: [whole(sample("ops_eyJ", 120, BASE64URL))] },

  // ── payments, mail and work tools ──────────────────────────────────────────────────────────────────────────────
  { id: "stripe-key", label: "a Stripe key", tier: "certain", redactAs: "api-key", pattern: token("(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{24,})"), examples: [whole(sample("sk_live_", 99)), whole(sample("rk_test_", 24)), whole(sample("whsec_", 32))] },
  { id: "midtrans-server-key", label: "a Midtrans server key", tier: "certain", redactAs: "api-key", pattern: token("(?:SB-)?Mid-server-[A-Za-z0-9_-]{20,}"), examples: [whole(sample("SB-Mid-server-", 24, BASE64URL)), whole(sample("Mid-server-", 24, BASE64URL))] },
  { id: "xendit-key", label: "a Xendit key", tier: "certain", redactAs: "api-key", pattern: token("xnd_(?:production|development)_[A-Za-z0-9]{40,}"), examples: [whole(sample("xnd_development_", 60))] },
  { id: "square-token", label: "a Square token", tier: "certain", redactAs: "api-key", pattern: token("sq0(?:atp|csp)-[A-Za-z0-9_-]{22,}"), examples: [whole(sample("sq0atp-", 22, BASE64URL))] },
  { id: "braintree-token", label: "a Braintree token", tier: "certain", redactAs: "api-key", pattern: token("access_token\\$production\\$[a-z0-9]{16}\\$[a-f0-9]{32}"), examples: [whole(`access_token$production$${sample("", 16, LOWER)}$${sample("", 32, HEX)}`)] },
  { id: "twilio-key", label: "a Twilio API key", tier: "certain", redactAs: "api-key", pattern: token("SK[0-9a-fA-F]{32}"), examples: [whole(sample("SK", 32, HEX))] },
  { id: "sendgrid-key", label: "a SendGrid key", tier: "certain", redactAs: "api-key", pattern: token("SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}"), examples: [whole(`SG.${sample("", 22, BASE64URL)}.${sample("", 43, BASE64URL)}`)] },
  { id: "mailgun-key", label: "a Mailgun key", tier: "certain", redactAs: "api-key", pattern: token("key-[0-9a-f]{32}"), examples: [whole(sample("key-", 32, HEX))] },
  { id: "mailchimp-key", label: "a Mailchimp key", tier: "certain", redactAs: "api-key", pattern: token("[0-9a-f]{32}-us\\d{1,2}"), examples: [whole(`${sample("", 32, HEX)}-us21`)] },
  { id: "notion-token", label: "a Notion token", tier: "certain", redactAs: "api-key", pattern: token("(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,})"), examples: [whole(sample("secret_", 43)), whole(sample("ntn_", 46))] },
  { id: "linear-key", label: "a Linear key", tier: "certain", redactAs: "api-key", pattern: token("lin_(?:api|oauth)_[A-Za-z0-9]{40}"), examples: [whole(sample("lin_api_", 40))] },
  { id: "airtable-token", label: "an Airtable token", tier: "certain", redactAs: "api-key", pattern: token("pat[A-Za-z0-9]{14}\\.[a-f0-9]{64}"), examples: [whole(`${sample("pat", 14)}.${sample("", 64, HEX)}`)] },
  { id: "figma-token", label: "a Figma token", tier: "certain", redactAs: "api-key", pattern: token("figd_[A-Za-z0-9_-]{40,}"), examples: [whole(sample("figd_", 40, BASE64URL))] },
  { id: "shopify-token", label: "a Shopify token", tier: "certain", redactAs: "api-key", pattern: token("shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}"), examples: [whole(sample("shpat_", 32, HEX))] },
  { id: "postman-key", label: "a Postman key", tier: "certain", redactAs: "api-key", pattern: token("PMAK-[a-f0-9]{24}-[a-f0-9]{34}"), examples: [whole(`${sample("PMAK-", 24, HEX)}-${sample("", 34, HEX)}`)] },

  // ── shapes any service uses ────────────────────────────────────────────────────────────────────────────────────
  {
    id: "jwt",
    label: "a JSON web token",
    tier: "certain",
    redactAs: "jwt",
    // The leading `eyJ` is the encoded `{"` every token starts with, which is what makes this safe to match on.
    pattern: token("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"),
    examples: [whole(`eyJhbGciOiJIUzI1NiJ9.${sample("eyJ", 40, BASE64URL)}.${sample("", 43, BASE64URL)}`)],
    nearMisses: ["eyJhbGciOiJIUzI1NiJ9 on its own is only a header"],
  },
  {
    id: "url-credentials",
    label: "a password in a URL",
    tier: "certain",
    redactAs: "url-credentials",
    // The host and the user stay — they are usually the point. Only the password goes.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:(?<value>[^\s/@]+)@/gi,
    examples: [within("postgres://app:", sample("", 16), "@db.internal:5432/app"), within("https://deploy:", sample("", 12), "@git.example.com/repo.git")],
    nearMisses: ["https://example.com/path?q=1", "mailto:someone@example.com", "ssh://git@github.com/org/repo.git", "http://localhost:8080/@admin"],
  },

  // ── a key that names a secret, then the value ──────────────────────────────────────────────────────────────────
  {
    id: "bearer-token",
    label: "a bearer token",
    tier: "context",
    redactAs: "bearer-token",
    // The header, not the word: `Authorization: Bearer …`.
    pattern: /\b(?:Bearer|Basic)\s+(?<value>[A-Za-z0-9._~+/=-]{16,})/gi,
    accept: plausibleSecret,
    examples: [within("Authorization: Bearer ", sample("", 32)), within("-H 'Authorization: Basic ", `${sample("", 30)}==`, "'")],
    nearMisses: ["the bearer of bad news", "basic internationalization support"],
  },
  {
    id: "auth-header",
    label: "an API key in a header",
    tier: "context",
    redactAs: "bearer-token",
    pattern: /\b(?:Authorization|X-[A-Za-z-]*(?:Key|Token|Secret|Auth)[A-Za-z-]*)\s*:\s*(?:[A-Za-z]+\s+)?(?<value>[A-Za-z0-9._~+/=-]{12,})/gi,
    accept: plausibleSecret,
    examples: [within("curl -H 'X-Api-Key: ", sample("", 32), "'"), within("Authorization: Token ", sample("", 40))],
    nearMisses: ["Authorization: required for every request", "X-Api-Key: <your key here>"],
  },
  {
    id: "assigned-secret",
    label: "a password or key",
    tier: "context",
    redactAs: "assigned-secret",
    // `DB_PASSWORD=…`, `api_key: "…"`, `"token": "…"`. The key is kept and only the value goes.
    pattern: new RegExp(`(?<![A-Za-z0-9_-])(?:[A-Za-z_][A-Za-z0-9_-]{0,40}?)?${SECRET_KEY}[A-Za-z0-9_-]{0,40}["']?\\s*[:=]\\s*(?<q>["']?)(?<value>[^\\s"'\`,;)]{6,512})\\k<q>`, "gi"),
    accept: plausibleSecret,
    examples: [
      within('DB_PASSWORD="', sample("", 14), '"'),
      within("api_key: ", sample("", 32)),
      within('"auth_token": "', sample("", 24), '"'),
      within("password=", "Hunter2024!"),
      within("kata sandi: ", "Rumah2024#9"),
    ],
    nearMisses: [
      "token: expired",
      "password=password",
      "API_KEY=${API_KEY}",
      "SECRET_KEY=your-secret-key",
      'api_key = "nougate"',
      'exec_secrets = ["github_token"]',
      "const token = process.env.GITHUB_TOKEN;",
      "password: z.string().min(8)",
      "PASSWORD_MIN_LENGTH=12",
      "token_file: ./secrets/token",
      "Simpan token tadi sebagai e2e_saved_token.",
      "password nya lupa, minta reset dong",
      "the token expired yesterday",
    ],
  },
  // ── what only a draft or a transcript loses ────────────────────────────────────────────────────────────────────
  {
    id: "api-key-eager",
    label: "an API key",
    tier: "eager",
    redactAs: "api-key",
    // The looser shapes redaction has always masked: `sk-` or a Slack prefix, whatever follows.
    pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    examples: [whole("sk-this-is-a-kebab-name-2025")],
  },
  {
    id: "bearer-token-eager",
    label: "a bearer token",
    tier: "eager",
    redactAs: "bearer-token",
    pattern: /\b(?:Bearer|Basic)\s+(?<value>[A-Za-z0-9._~+/=-]{16,})/gi,
    examples: [within("Authorization: Bearer ", "abcdefghijklmnopqrstuvwx")],
  },
  {
    id: "assigned-secret-eager",
    label: "a password or key",
    tier: "eager",
    redactAs: "assigned-secret",
    // Anything assigned to a secret-sounding key, a word or not: `password=hunter` goes from a draft.
    pattern: new RegExp(`(?<![A-Za-z0-9_-])(?:[A-Za-z_][A-Za-z0-9_-]{0,40}?)?${SECRET_KEY}[A-Za-z0-9_-]{0,40}["']?\\s*[:=]\\s*(?<q>["']?)(?<value>[^\\s"'\`,;)]{6,})\\k<q>`, "gi"),
    examples: [within("password=", "hunter")],
  },
  {
    id: "long-hex",
    label: "a long hex string",
    tier: "eager",
    redactAs: "long-hex",
    // Session ids, SHAs, anything hand-rolled: forty is a git SHA, and above it almost nothing a procedure keeps needs it.
    pattern: /\b[0-9a-f]{40,}\b/gi,
    examples: [whole(sample("", 40, HEX))],
  },
];
