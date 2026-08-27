import { describe, it, expect } from "vitest";
import { shouldReplenishPreKeys, PREKEY_FLOOR, PREKEY_BATCH } from "../src/daemon/socket.js";

describe("shouldReplenishPreKeys", () => {
  it("repõe quando o pool está abaixo do piso", () => {
    expect(shouldReplenishPreKeys(0)).toBe(true);
    expect(shouldReplenishPreKeys(6)).toBe(true);
    expect(shouldReplenishPreKeys(PREKEY_FLOOR - 1)).toBe(true);
  });

  it("não repõe quando o pool está saudável", () => {
    expect(shouldReplenishPreKeys(PREKEY_FLOOR)).toBe(false);
    expect(shouldReplenishPreKeys(50)).toBe(false);
    expect(shouldReplenishPreKeys(812)).toBe(false);
  });

  it("repõe quando o servidor não informou a contagem", () => {
    expect(shouldReplenishPreKeys(null)).toBe(true);
  });

  // O bug que motivou a mudança: o limiar do Baileys é <= 5, então uma conta que
  // estaciona em 6 nunca repõe e nenhuma sessão Signal nova consegue ser aberta.
  it("cobre o ponto cego do limiar do Baileys (6 chaves)", () => {
    expect(shouldReplenishPreKeys(6)).toBe(true);
  });

  it("o lote é maior que o piso, senão a reposição não sairia do vermelho", () => {
    expect(PREKEY_BATCH).toBeGreaterThan(PREKEY_FLOOR);
  });
});
