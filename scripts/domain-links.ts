/**
 * The domain check's table (`check-domains.ts`): which engine domain imports which.
 *
 * `LINKS_AT_START` is every link there was when the rule began, read off the tree as found rather than argued one by
 * one: 134 links among 32 domains, 24 of them both ways. It may only shrink. A link added since goes in `LINKS_ADDED`
 * with the reason the one domain needs the other, as a size budget has its reason.
 */

/** Each domain's links to the others when the rule began, by the domain that imports. */
export const LINKS_AT_START: Readonly<Record<string, readonly string[]>> = {
  attachments: ["llm"],
  config: ["llm", "memory", "missions", "people", "tools"],
  cron: ["missions", "tools"],
  events: ["turns"],
  "external-agents": ["llm", "missions", "notes", "people", "pipeline", "router", "tools"],
  hooks: ["cron", "llm", "missions", "notes", "pipeline", "reflection", "sessions", "tools", "update"],
  jobs: ["missions", "tools"],
  llm: ["events", "hooks", "memory", "people", "router", "system-packages", "toolchain", "tools", "turns"],
  "mcp-oauth": ["web"],
  "mcp-registry": ["skills-hub"],
  "mcp-server": ["memory"],
  memory: ["llm", "missions", "people"],
  missions: ["cron", "external-agents", "memory", "notes", "pipeline", "tools", "turns"],
  people: ["config", "hooks"],
  pipeline: [
    "access", "attachments", "chat-events", "cron", "hooks", "jobs", "llm", "memory", "missions", "notes", "people",
    "reflection", "rooms", "router", "sessions", "toolchain", "tools", "turns", "update", "users", "web",
  ],
  reflection: ["llm"],
  setup: ["config", "gateways", "llm", "tools"],
  "skills-hub": ["reflection", "tools"],
  tools: [
    "attachments", "config", "cron", "gateways", "jobs", "llm", "mcp-registry", "memory", "missions", "notes", "people",
    "pipeline", "reflection", "router", "setup", "skills-hub", "toolchain", "update", "web",
  ],
  turns: ["events", "llm", "pipeline", "tools"],
  update: ["cron", "jobs", "tools"],
  users: ["web"],
  web: [
    "access", "attachments", "chat-events", "config", "cron", "events", "external-agents", "gateways", "jobs", "llm",
    "mcp-oauth", "mcp-registry", "mcp-server", "memory", "missions", "notes", "people", "pipeline", "reflection", "rooms",
    "router", "sessions", "setup", "skills-hub", "tools", "turns", "update", "users",
  ],
};

/** Links added since the rule began, `"from → to"`, each with the reason `from` needs `to`. */
export const LINKS_ADDED: Readonly<Record<string, string>> = {};
