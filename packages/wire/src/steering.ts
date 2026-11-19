/** `[queue] steer_reply` and `steer_ack` (`routes/steering.ts`): what a person is told when they write while the agent works. */
export interface SteeringPolicy {
  /** A line in the agent's own words under or in place of "Got it". */
  reply: boolean;
  /** "Got it" at once. Off: only the agent's line is said, and nothing where there is none. */
  ack: boolean;
  editable: boolean;
}
