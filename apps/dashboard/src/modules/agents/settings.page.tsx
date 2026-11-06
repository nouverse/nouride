/**
 * Daemon-wide agent settings — access mode, group context, mention behaviour, the daily spend cap,
 * and conversation retention. How much each agent asks is its own Access tab (the approval level).
 *
 * These controls used to live on the Agents index page, but they cluttered a list whose job is
 * showing agents. A dedicated page keeps the list clean and gives each setting room to breathe.
 *
 * `config.toml` itself is the last card, having spent a while in one agent's Files tab where it read
 * as that agent's file. Everything above it writes into that same file through a form; it is here
 * for the settings that have no form yet.
 */

import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/commons/components/ui/ui";
import { AccessModeSwitch } from "./components/AccessModeSwitch";
import { GroupContextControl } from "./components/GroupContextControl";
import { MentionSettings } from "./components/MentionSettings";
import { SessionRetentionControl } from "./components/SessionRetentionControl";
import { SpendCapControl } from "./components/SpendCapControl";
import { ToolBudgetControl } from "./components/ToolBudgetControl";
import { TurnBudgetControl } from "./components/TurnBudgetControl";
import { JobQuietControl } from "./components/JobQuietControl";
import { DaemonConfigEditor } from "./components/DaemonConfigEditor";

export default function AgentSettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Settings"
        description="Rules for every agent: who may talk to them, group chats, agents calling on each other, the daily spend limit, how long conversations are kept, and the settings file itself."
        actions={
          <Link
            to="/agents"
            className="btn btn-ghost btn-sm gap-2 shadow-xs active:scale-95 transition-all"
          >
            <ArrowLeft size={16} /> Back to Agents
          </Link>
        }
      />

      <AccessModeSwitch />
      <GroupContextControl />
      <MentionSettings />
      <SpendCapControl />
      <ToolBudgetControl />
      <TurnBudgetControl />
      <JobQuietControl />
      <SessionRetentionControl />
      {/* Last: it can express everything above it and anything the cards do not cover yet. */}
      <DaemonConfigEditor />
    </div>
  );
}
