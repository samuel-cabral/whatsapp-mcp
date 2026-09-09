/**
 * How a message's body reaches the model.
 *
 * A voice note is the one case where the words on the line were not written by a
 * person: whisper guessed them. The marker is inline rather than in a footnote per
 * message because this line is what gets copied into a summary, and a caveat that
 * travels separately from the claim does not travel at all.
 */
export interface Renderable {
  id: string;
  type: string;
  text: string | null;
  transcript: string | null;
  transcriptStatus: string | null;
  transcriptError: string | null;
}

/** Enough of the id for transcribe_audio, without spending a line on it. */
const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

export function renderBody(m: Renderable): string {
  if (m.text !== null && m.text !== "") return m.text;
  if (m.type !== "audio") return `(${m.type})`;

  switch (m.transcriptStatus) {
    case "done":
      // "" is the recorded outcome of listening and hearing nothing, which is a
      // different fact from nobody having tried.
      return m.transcript ? `(áudio, transcrito) ${m.transcript}` : "(áudio, sem fala reconhecida)";
    case "pending":
    case "running":
      return `(áudio, transcrevendo, id ${shortId(m.id)})`;
    case "failed":
      return `(áudio, transcrição falhou: ${m.transcriptError ?? "motivo desconhecido"}, id ${shortId(m.id)})`;
    default:
      // Everything from before this feature, and every audio that is not a voice note.
      // Unchanged on purpose: there is no transcript and none is coming.
      return "(audio)";
  }
}

const CAVEAT =
  "\n\nℹ️ (áudio, transcrito) é transcrição automática de máquina; erra nome, número e valor — " +
  "confirme antes de agir sobre horário, endereço ou dinheiro.";

/**
 * Appended once per response, and only when a transcript is actually in it. A warning
 * that shows up on every read is a warning nobody reads by the third time.
 */
export function transcriptCaveat(rendered: string[]): string {
  return rendered.some((line) => line.includes("(áudio, transcrito)")) ? CAVEAT : "";
}
