/**
 * The schema manifest — every version this build knows how to apply.
 *
 * The baseline, `069_baseline.sql`: the schema 0.8.0 left, every migration up to 69 in one file. Folded on 2026-10-26
 * by `scripts/squash-migrations.ts` from the chain 0.8.0 had — `068_baseline.sql` (032 to 068, folded on 2026-10-24
 * and compared with a live box's 0.7.28 database as well) and `069_missions_automations.sql`, 0.8.0's additions — and
 * proved to give the same `sqlite_master` as that chain, every row byte for byte. Reading the schema is reading one
 * file, and nothing in this build converts rows an older one wrote.
 *
 * The SQL is *imported as text*, not read from disk. `bun build --compile` produces one executable
 * with no `migrations/` directory beside it, and an earlier version of this listed the directory at
 * runtime. In a compiled binary that scan found nothing, so `migrate()` saw zero pending migrations
 * on a database at `user_version = 0`, logged "schema up to date", and the daemon died on its first
 * query with `no such table: sender_access`. Fail-open and silent: the shape where a check reports
 * success because it could not find anything to check.
 *
 * A hard-coded list cannot be empty, so that failure is gone by construction. Adding a migration
 * means adding a line here, and forgetting is caught by `migrations.test.ts`, which compares this
 * list against the directory.
 *
 * **A migration's comments are frozen with it.** The fingerprint hashes the file as written, so a corrected
 * comment in one already applied makes every upgrading install refuse to start (`schema-fingerprint.test.ts` pins
 * the shipped values, and the baseline's bytes). A stale comment is corrected where the table's code lives.
 *
 * ## What the squash costs, and why it was affordable
 *
 * **A database below 69 can no longer be brought here by this build.** The steps are gone. That is affordable
 * because this version starts only on data 0.8.0 has run on (`boot/upgrade-floor.ts`), and 0.8.0 brought every
 * database to 69 on that run — so a database below it is refused, "install 0.8.0 first" (`db/index.ts`), as is a
 * snapshot restored from before it (`nouride db restore`). Each squash before was affordable the same way: into
 * `032_baseline.sql` on 2026-09-09, when the only two installs were both at 32, and into `068_baseline.sql` on
 * 2026-10-24, when 0.8.0 started only on data 0.7.28 had brought to 68.
 *
 * ## Why the baseline keeps the version it replaces, and the fingerprint
 *
 * It is `069_baseline.sql`, not `001_`. Version numbers are the only thing deciding what a database still needs: a
 * baseline numbered 1 would leave every install already at 69 with nothing pending forever, so `070_something.sql`
 * would never reach them. And a database at 69 holds the fingerprint the chain gave it, so the baseline states that
 * fingerprint instead of hashing its own text (`schemaFingerprint` in `db/index.ts`): an install 0.8.0 left at 69 is
 * the same schema as one this file makes, and a database this file made still opens under 0.8.0. The fingerprint is
 * the one `schemaFingerprint` gave 0.8.0's chain at 69 — what 0.8.0 stamped on a new database and on one it brought
 * from 68 alike — and `schema-fingerprint.test.ts` holds it.
 *
 * ## Only SQL
 *
 * A migration is SQL and nothing else. The chain had three that ran code after their SQL, to convert rows SQLite
 * could not; 0.8.0's rule is that a migration adds tables and features and brings no old form forward (owner,
 * 2026-10-20), so there is no place for one.
 */

import baseline from "./migrations/069_baseline.sql" with { type: "text" };
import missionBranch from "./migrations/070_mission_branch.sql" with { type: "text" };
import approvalClass from "./migrations/071_approval_class.sql" with { type: "text" };
import missionTold from "./migrations/072_mission_told.sql" with { type: "text" };
import missionSummary from "./migrations/073_mission_summary.sql" with { type: "text" };
import missionCounts from "./migrations/074_mission_counts.sql" with { type: "text" };
import sessionTokenHash from "./migrations/075_session_token_hash.sql" with { type: "text" };
import keptAcrossRestart from "./migrations/076_kept_across_restart.sql" with { type: "text" };
import daemonState from "./migrations/077_daemon_state.sql" with { type: "text" };
import knowledge from "./migrations/078_knowledge.sql" with { type: "text" };
import knowledgeEdges from "./migrations/079_knowledge_edges.sql" with { type: "text" };
import chatMessagesKey from "./migrations/080_chat_messages_key.sql" with { type: "text" };
import retryPromised from "./migrations/081_retry_promised.sql" with { type: "text" };
import resumeAsked from "./migrations/082_resume_asked.sql" with { type: "text" };
import conversationOpener from "./migrations/083_conversation_opener.sql" with { type: "text" };
import runSteps from "./migrations/084_run_steps.sql" with { type: "text" };
import roomAnswerer from "./migrations/085_room_answerer.sql" with { type: "text" };
import thingOwner from "./migrations/086_thing_owner.sql" with { type: "text" };

export interface Migration {
  /** Parsed from the filename prefix, and what `user_version` is set to once applied. */
  version: number;
  /** The filename, for the log line and for the test that checks this list against the directory. */
  name: string;
  sql: string;
  /**
   * The fingerprint a database at this version holds, for a baseline folded from a chain this build no longer has —
   * the chain's, which `schemaFingerprint` returns for it and folds the migrations after it onto.
   */
  fingerprint?: number;
}

/**
 * Ordered by version. Forward-only, per TD-005 — there are no `down` migrations, because the
 * recovery path for a bad migration on a single-file database is to restore the file
 * (`nouride db restore`), and pretending otherwise builds a rollback nobody tests.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 69, name: "069_baseline.sql", sql: baseline, fingerprint: -804988230 },
  { version: 70, name: "070_mission_branch.sql", sql: missionBranch },
  { version: 71, name: "071_approval_class.sql", sql: approvalClass },
  { version: 72, name: "072_mission_told.sql", sql: missionTold },
  { version: 73, name: "073_mission_summary.sql", sql: missionSummary },
  { version: 74, name: "074_mission_counts.sql", sql: missionCounts },
  { version: 75, name: "075_session_token_hash.sql", sql: sessionTokenHash },
  { version: 76, name: "076_kept_across_restart.sql", sql: keptAcrossRestart },
  { version: 77, name: "077_daemon_state.sql", sql: daemonState },
  { version: 78, name: "078_knowledge.sql", sql: knowledge },
  { version: 79, name: "079_knowledge_edges.sql", sql: knowledgeEdges },
  { version: 80, name: "080_chat_messages_key.sql", sql: chatMessagesKey },
  { version: 81, name: "081_retry_promised.sql", sql: retryPromised },
  { version: 82, name: "082_resume_asked.sql", sql: resumeAsked },
  { version: 83, name: "083_conversation_opener.sql", sql: conversationOpener },
  { version: 84, name: "084_run_steps.sql", sql: runSteps },
  { version: 85, name: "085_room_answerer.sql", sql: roomAnswerer },
  { version: 86, name: "086_thing_owner.sql", sql: thingOwner },
];

/**
 * The schema 0.8.0 left, and the oldest this build starts on. A database below it is from before the floor: refused
 * at start, by `nouride db adopt` and by `nouride db restore` — "install 0.8.0 first" (`docs/DEPLOY.md` § The upgrade
 * window).
 */
export const FLOOR_SCHEMA = MIGRATIONS[0]!.version;
