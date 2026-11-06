/**
 * The keys marked advanced (SIMPLIFY §3, 0.8.0): rarely needed, so a power user loses nothing and nobody else has to
 * read past them. Each still works exactly as before; what changes is where it is shown — in one appendix of the
 * docs (the site's config page, "Advanced settings"), in `nouride config explain`, and in the dashboard behind an
 * "Advanced" disclosure — and not in `config.example.toml` or on a settings page's first screen.
 *
 * The RFC's families, each spelled out: shutdown and log formatting; every cooldown and code lifetime; `[llm.context]`
 * but `compact_at_tokens` and `summary_model`; `[llm.streaming]`; `[queue]` but `max_concurrent_turns` and `steer`;
 * `[cron]` but `enabled` and `unattended_approval`; `[nougate] port`; `[control]`; `credentials_dir`; the output and
 * media byte limits; mention hops and wake chains. `config-example.test.ts` holds the example to this list, and the
 * site's appendix to it, in both languages.
 */

/** By TOML path, as `describeConfig` names a key. */
export const ADVANCED_KEYS: ReadonlySet<string> = new Set([
  "daemon.shutdown_timeout_ms",
  "daemon.log_pretty",
  "security.access.code_ttl_ms",
  "security.access.notify_cooldown_ms",
  "security.access.deny_cooldown_ms",
  "alerts.cooldown_ms",
  "security.rate_limit.cooldown_reply",
  "llm.context.max_context_ratio",
  "llm.context.truncation_strategy",
  "llm.context.preserve_recent_turns",
  "llm.context.compact_at_ratio",
  "llm.context.preserve_recent_tool_results",
  "llm.streaming.enabled",
  "llm.streaming.typing_indicator",
  "llm.streaming.progress_in_chat",
  "queue.max_concurrent_per_agent",
  "queue.max_queue_depth",
  "queue.queue_timeout_ms",
  "queue.steer_reply",
  "queue.steer_reply_model",
  "queue.steer_reply_timeout_ms",
  "cron.min_interval_ms",
  "cron.max_jobs",
  "cron.run_retention_days",
  "cron.catchup_window_ms",
  "cron.fail_streak_limit",
  "cron.command_timeout_ms",
  "nougate.port",
  "control.enabled",
  "control.chat",
  "security.credentials_dir",
  "security.tool_max_output_bytes",
  "media.max_image_bytes",
  "media.max_audio_bytes",
  "agents.mention_max_hops",
  "agents.job_wake_max_chain",
]);
