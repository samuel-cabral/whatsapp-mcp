/**
 * Baileys hands out jids in several shapes: with a device suffix (":12@"),
 * as "@lid", or already bare. Everything downstream keys on the bare form,
 * so normalization has to happen at the boundary — not at each call site.
 */
export function normalizeJid(jid: string): string {
  const [user, server] = jid.split("@");
  if (!server) return jid;
  const bare = user.split(":")[0];
  return `${bare}@${server}`;
}

/**
 * Two jids the server says are the same person, reduced to a lid_map row. Any pair
 * that is not exactly one @lid and one phone-number jid is not evidence of anything
 * and yields null — the same field can hold a group, a broadcast or nothing at all.
 */
export function lidPair(a: unknown, b: unknown): { lid: string; pn: string } | null {
  if (typeof a !== "string" || typeof b !== "string") return null;
  const x = normalizeJid(a);
  const y = normalizeJid(b);
  if (x.endsWith("@lid") && y.endsWith("@s.whatsapp.net")) return { lid: x, pn: y };
  if (y.endsWith("@lid") && x.endsWith("@s.whatsapp.net")) return { lid: y, pn: x };
  return null;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/**
 * WhatsApp routes things that are not people through the same message pipeline:
 * the status feed, newsletters, bots. They carry a pushName like anyone else, so
 * whoever learns names from messages has to exclude them — otherwise the status
 * feed shows up in the chat list wearing some stranger's name.
 */
export function isUserJid(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}
