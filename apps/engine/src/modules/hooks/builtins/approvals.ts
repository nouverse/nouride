/**
 * Answering the gate from chat: `/approve`, `/deny`, `/approvals`, `/grants`.
 *
 * All four are per conversation, which is the property that matters — a bare `/approve` cannot
 * answer something raised in a chat the person never saw. See `../pending.ts` for how "the request
 * waiting now" is resolved, and why it looks back fifteen minutes.
 */

import { describeApprovalLevel, resolveApprovalLevel } from "@nouride/policy";
import type { Hook } from "../types.ts";
import {
  answerAllApprovals,
  answerApproval,
  drainCoveredPending,
} from "../pending.ts";
import { isPlatformMention } from "../parse.ts";

export const approvalHooks: Hook[] = [
    {
      command: "/approve",
      description: "Approve a pending tool call; add `always` to stop being asked for it",
      handler: async (ctx) => {
        // `always` as a trailing word rather than a separate command: someone reading a prompt in
        // a chat answers with the shortest thing that works, and `/approve always` is shorter than
        // remembering a second verb. Openclaw accepts both spellings for the same reason.
        const always = ctx.args.some((arg) => /^(always|allow-always)$/i.test(arg));
        // `all`, because scaffolding a project raises a dozen requests and answering them one id at a
        // time is how an operator ends up switching the gate off entirely. Measured on a phone: the
        // ids are 24 hex characters, and one of them got mistyped.
        if (ctx.args.some((arg) => /^all$/i.test(arg))) {
          return answerAllApprovals(ctx, always ? "allow-always" : "allow-once");
        }
        const id = ctx.args.find(
          (arg) => !/^(always|allow-always|once|allow-once|all)$/i.test(arg) && !isPlatformMention(arg),
        );
        return answerApproval(ctx, always ? "allow-always" : "allow-once", id);
      },
    },

    /**
     * `/approvals` — how much this conversation asks, in three named levels.
     *
     * Replaces `/auto on|off`, which could only say "stop asking me" or "ask me". The two things people
     * actually want sit either side of that: an operator on their own homelab wants nothing asked, and a
     * shared room wants the policy honoured.
     *
     * **`trusted` is not settable here, and that is the point.** A chat sender is not authenticated —
     * knowing the bot's username proves nothing, which is the entire reason pairing exists. A
     * `/approvals trusted` typed in a Discord server would hand every member one command to disarm the
     * daemon. It is set in the dashboard, behind a login, or in `config.toml`, which is a hardline path
     * an agent cannot write to without asking.
     */
    {
      command: "/approvals",
      description:
        "How much I ask before running tools: `/approvals`, `/approvals careful`, `/approvals balanced`",
      handler: async (ctx) => {
        /**
         * The person store is needed to *set* a person's level, not to answer questions.
         *
         * Showing the level, and refusing `trusted`, are both answerable from the agent and the daemon
         * default alone. Bailing out early on a missing store made a build with no store report that
         * approval levels did not exist — which is false: two of the three layers were still deciding.
         */
        const store = ctx.deps.autoApprove;
        const arg = (ctx.args[0] ?? "").toLowerCase();
        const agentLevel = ctx.agent.config.approvals;
        const personLevel = store?.levelFor(ctx.gatewayId, ctx.senderId);
        const resolution = resolveApprovalLevel({
          ...(agentLevel ? { agent: agentLevel } : {}),
          ...(personLevel ? { person: personLevel } : {}),
          daemon: ctx.deps.daemonApprovals ?? "careful",
        });

        // Show. Says who decided, because "why am I being asked" and "why am I not" are one question.
        if (!arg) {
          return {
            handled: true,
            reply: [
              `Approvals: ${describeApprovalLevel(resolution)}`,
              "",
              resolution.source === "agent"
                ? "Set on this agent, so it is the same for everyone here. Change it in the dashboard."
                : "`/approvals balanced` to stop being asked about ordinary calls · `/approvals careful` to be asked.",
            ].join("\n"),
          };
        }

        if (arg === "trusted") {
          return {
            handled: true,
            reply: [
              "`trusted` cannot be set from a chat message.",
              "",
              "Anyone who can message me can type a command here. That is not proof of who they are,",
              "which is why pairing exists. `trusted` switches off every gate, config changes and stopping",
              "this daemon included, so it is set where there is a login: the dashboard, under this agent.",
            ].join("\n"),
          };
        }

        if (arg !== "careful" && arg !== "balanced") {
          return {
            handled: true,
            reply: "Use `/approvals careful` or `/approvals balanced`. `/approvals` on its own shows what is set.",
          };
        }

        if (agentLevel && agentLevel !== "per-person") {
          // The agent has decided for everyone. Saying so beats appearing to accept a setting that
          // will not apply — which is the shape of a control people stop trusting.
          return {
            handled: true,
            reply: [
              `This agent is set to \`${agentLevel}\`, which applies to everyone talking to it, so your`,
              "own setting will not change anything here. Change the agent in the dashboard, or set it",
              "to `per-person` to let each person choose.",
            ].join("\n"),
          };
        }

        if (!store) {
          return {
            handled: true,
            reply: "Your own level cannot be stored in this build. The agent's setting and the daemon default still apply.",
          };
        }

        if (arg === "balanced") {
          const changed = store.enable(ctx.gatewayId, ctx.senderId, ctx.senderId);
          // Drain every pending request this level covers. Someone who just said "stop asking me" and
          // then has to answer a queue by hand has been given a setting and not a change.
          const { drained, notice } = drainCoveredPending(ctx);
          return {
            handled: true,
            reply: [
              changed
                ? "Approvals: **balanced** for you. I will not ask before ordinary calls."
                : "Approvals were already **balanced** for you.",
              "",
              // Stated every time, not buried in documentation. Someone loosening a gate is entitled to
              // know exactly what it still covers.
              "Still asks, every time: changing a config.toml, giving someone access, stopping this",
              "daemon, replacing or deleting a stored secret, a credential leaving this machine, and",
              "changing its system packages. Like every level, it also asks about a program installed",
              "for every agent, a change to an agent's own persona or to who People says a person is,",
              "and work nobody watches sending somewhere its job did not name.",
              "`sudo` changes nothing: what it runs is what is asked about (`sudo systemctl stop nouride`",
              "still stops this daemon).",
              "",
              "This follows you, not this chat: it survives `/new`, `/reset` and a restart.",
              ...(drained > 0 ? ["", `Approved ${drained} pending request(s).`] : []),
              ...notice,
            ].join("\n"),
          };
        }

        return {
          handled: true,
          reply: store.disable(ctx.gatewayId, ctx.senderId, ctx.senderId)
            ? "Approvals: **careful** for you. I will ask again before gated calls."
            : "Approvals were already **careful** for you.",
        };
      },
    },

    {
      command: "/deny",
      description: "Deny a pending tool call",
      handler: async (ctx) => {
        const id = ctx.args.find((arg) => !isPlatformMention(arg));
        return answerApproval(ctx, "deny", id);
      },
    },

    {
      command: "/grants",
      description: "List standing command permissions, or revoke them: `/grants revoke <id|all>`",
      handler: async (ctx) => {
        const grants = ctx.deps.grants;
        if (!grants) return { handled: true, reply: "Grants are not enabled in this build." };
        const agentId = ctx.agent.config.id;

        if (/^revoke$/i.test(ctx.args[0] ?? "")) {
          const target = ctx.args[1];
          if (!target) return { handled: true, reply: "Name a grant id, or `all`." };
          if (/^all$/i.test(target)) {
            const count = grants.revokeAll(ctx.senderId, agentId);
            return { handled: true, reply: `Revoked ${count} grant(s). I will ask again from now on.` };
          }
          return {
            handled: true,
            reply: grants.revoke(target, ctx.senderId)
              ? `Revoked \`${target}\`.`
              : `\`${target}\` is not an active grant.`,
          };
        }

        const list = grants.list({ agentId });
        if (list.length === 0) {
          return { handled: true, reply: "No standing permissions. I ask before every new command." };
        }
        return {
          handled: true,
          reply: [
            `${list.length} standing permission(s):`,
            ...list.map(
              (grant) =>
                `- \`${grant.id}\` ${grant.commandText}` +
                (grant.useCount > 0 ? ` · used ${grant.useCount}×` : " · never used"),
            ),
            "Revoke with `/grants revoke <id>` or `/grants revoke all`.",
          ].join("\n"),
        };
      },
    },
];
