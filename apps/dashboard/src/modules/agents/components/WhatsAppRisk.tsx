/**
 * What a WhatsApp number risks, said where a person is about to take that risk: adding a number, opening an agent that
 * has one, and on an open agent's Access page and number. Nouride links to WhatsApp unofficially, so WhatsApp may ban a
 * number it takes for a bot, and an agent answering strangers is the likeliest way there. Said and not refused: it is
 * the owner's number and the owner's choice.
 */

export function WhatsAppRisk({ open }: { open: boolean }) {
  return (
    <div role="note" data-whatsapp-risk className="border-warning/30 bg-warning/10 text-base-content/85 rounded-xl border p-3 text-xs leading-relaxed">
      <p className="font-semibold">About WhatsApp</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {open ? <li>This agent answers anyone. That is the riskiest way to use a WhatsApp number, so start with low daily limits.</li> : null}
        {/* plain-words-ok: Baileys, named so a person who looks it up learns what the link is */}
        <li>Nouride connects to WhatsApp unofficially, the way WhatsApp Web does (through Baileys), not through WhatsApp's official Business API.</li>
        <li>
          WhatsApp may restrict or ban a number it sees acting like a bot: answering many people it doesn't know, sending a lot, or replying to a broadcast. A ban can't be undone from here, and the
          number's chats may be lost.
        </li>
        <li>Use a number you can afford to lose, not your personal one.</li>
      </ul>
    </div>
  );
}
