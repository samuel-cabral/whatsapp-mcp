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

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}
