/**
 * Why this module exists: on 2026-08-25 this daemon stopped receiving messages and
 * said nothing for 47 hours. `whatsapp_status` answered "conectado: sim, sync
 * inicial: completo" the whole time, because every field it had was about the
 * socket, and the socket was fine. Nothing in the system was watching the one thing
 * that had actually stopped.
 *
 * It was also the third such blackout in nine days (20.4h on 19/08, 26.4h on 23/08).
 * The first two healed on their own and nobody noticed, which is the argument
 * against auditing the database after the fact: by the time you look, backfill has
 * already patched the hole.
 */

export type InboundVerdict = "ok" | "suspeito" | "quebrado";

/** Live counters from the daemon. A sliding one-hour window. */
export interface InboundHealth {
  decryptedLastHour: number;
  undecryptableLastHour: number;
  disconnectsLastHour: number;
  /** Since when the Baileys event buffer has been stuck, if it is. */
  bufferingSinceMs: number | null;
}

export interface InboundAssessment {
  verdict: InboundVerdict;
  daytimeMinutesSilent: number;
  /** One line, ready to print in the status and in a tool response. */
  reason: string;
}

/**
 * Daytime only. Measured over 64.754 messages across 79 days, the worst real
 * daytime gap in this account was 113 minutes and the p99.99 was 94; by wall clock
 * the worst gap is 7.4 hours and the fifteen largest are all overnight. A wall
 * clock threshold loose enough to survive a night is too loose to catch a workday.
 */
export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 23;

export const SUSPECT_AFTER_DAYTIME_MIN = 180;
export const BROKEN_AFTER_DAYTIME_MIN = 360;

/**
 * The fast leg. Traffic still arriving while nothing decodes is not a quiet
 * afternoon, it is a break, and it is visible in about forty minutes instead of six
 * hours. This is the literal condition the daemon was in on 25/08 at 14h.
 */
export const BROKEN_UNDECRYPTABLE_PER_HOUR = 20;

/** A healthy offline batch drains in seconds; a minute means it is never coming. */
export const BROKEN_BUFFERING_MS = 60_000;

/** Bounds the walk below, so a never-seen inbound cannot spin. */
const MAX_LOOKBACK_MIN = 14 * 24 * 60;

/**
 * Minutes between two instants that fall inside the local day. Walks a minute at a
 * time rather than doing calendar arithmetic, because the only thing that must be
 * right here is the DST and midnight handling, and Intl already knows those.
 */
export function daytimeMinutesBetween(fromSec: number, toSec: number, tz?: string): number {
  if (!(toSec > fromSec)) return 0;

  const hourAt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });

  const totalMin = Math.min(Math.floor((toSec - fromSec) / 60), MAX_LOOKBACK_MIN);
  let daytime = 0;
  for (let i = 0; i < totalMin; i++) {
    const at = new Date((fromSec + i * 60) * 1000);
    const hour = Number(hourAt.format(at));
    if (hour >= DAY_START_HOUR && hour < DAY_END_HOUR) daytime++;
  }
  return daytime;
}

const hhmm = (sec: number, tz?: string): string =>
  new Date(sec * 1000).toLocaleString("sv-SE", { timeZone: tz, hour12: false }).slice(0, 16);

export function assessInbound(input: {
  now: number;
  lastInboundMsgTs: number | null;
  health: InboundHealth;
  tz?: string;
}): InboundAssessment {
  const { now, lastInboundMsgTs, health, tz } = input;

  const silent = lastInboundMsgTs === null ? 0 : daytimeMinutesBetween(lastInboundMsgTs, now, tz);
  const since = lastInboundMsgTs === null ? "nunca" : hhmm(lastInboundMsgTs, tz);
  const horas = lastInboundMsgTs === null ? null : Math.round((now - lastInboundMsgTs) / 3600);

  const broken = (reason: string): InboundAssessment => ({
    verdict: "quebrado",
    daytimeMinutesSilent: silent,
    reason,
  });

  if (health.bufferingSinceMs !== null && health.bufferingSinceMs >= BROKEN_BUFFERING_MS) {
    return broken(
      `buffer de eventos travado há ${Math.round(health.bufferingSinceMs / 60_000)} min — ` +
        `nada recebido está sendo entregue. Última recebida: ${since}.`,
    );
  }

  if (
    health.undecryptableLastHour >= BROKEN_UNDECRYPTABLE_PER_HOUR &&
    health.decryptedLastHour === 0
  ) {
    return broken(
      `${health.undecryptableLastHour} mensagens chegaram e nenhuma foi decifrada na última hora. ` +
        `Última recebida: ${since}${horas === null ? "" : ` (há ${horas}h)`}.`,
    );
  }

  if (silent >= BROKEN_AFTER_DAYTIME_MIN) {
    return broken(
      `${Math.round(silent / 60)}h de silêncio em horário diurno. Última recebida: ${since}.`,
    );
  }

  if (silent >= SUSPECT_AFTER_DAYTIME_MIN) {
    return {
      verdict: "suspeito",
      daytimeMinutesSilent: silent,
      reason: `${Math.round(silent / 60)}h sem receber nada em horário diurno. Última recebida: ${since}.`,
    };
  }

  return {
    verdict: "ok",
    daytimeMinutesSilent: silent,
    reason:
      lastInboundMsgTs === null
        ? "nenhuma mensagem recebida ainda."
        : `última recebida ${since}.`,
  };
}
