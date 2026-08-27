import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTtlCache } from "../src/shared/ttl-cache.js";

afterEach(() => vi.useRealTimers());

describe("makeTtlCache", () => {
  it("guarda e devolve", () => {
    const c = makeTtlCache(1000);
    c.set("a", 7);
    expect(c.get<number>("a")).toBe(7);
  });

  it("esquece depois do TTL", () => {
    vi.useFakeTimers();
    const c = makeTtlCache(1000);
    c.set("a", 7);
    vi.advanceTimersByTime(1001);
    expect(c.get("a")).toBeUndefined();
  });

  it("del e flushAll limpam", () => {
    const c = makeTtlCache(1000);
    c.set("a", 1);
    c.set("b", 2);
    c.del("a");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    c.flushAll();
    expect(c.get("b")).toBeUndefined();
  });

  it("renova o prazo ao reescrever a mesma chave", () => {
    vi.useFakeTimers();
    const c = makeTtlCache(1000);
    c.set("a", 1);
    vi.advanceTimersByTime(900);
    c.set("a", 2);
    vi.advanceTimersByTime(900); // 1800 desde o primeiro set, 900 desde o segundo
    expect(c.get<number>("a")).toBe(2);
  });

  // O contador de retry é escrito por mensagem recebida. Sem teto, uma conta com
  // muito tráfego prende memória para sempre, já que nada mais varre o mapa.
  it("respeita o teto de entradas", () => {
    const c = makeTtlCache(60_000, 3);
    for (const k of ["a", "b", "c", "d", "e"]) c.set(k, k);
    const vivos = ["a", "b", "c", "d", "e"].filter((k) => c.get(k) !== undefined);
    expect(vivos.length).toBeLessThanOrEqual(3);
    expect(c.get("e")).toBe("e"); // o mais novo sempre sobrevive
  });

  it("prefere descartar o que já venceu antes de derrubar entrada viva", () => {
    vi.useFakeTimers();
    const c = makeTtlCache(1000, 2);
    c.set("velha", 1);
    vi.advanceTimersByTime(1001); // "velha" vence
    c.set("nova", 2);
    c.set("outra", 3); // cabe, porque "velha" podia sair
    expect(c.get("nova")).toBe(2);
    expect(c.get("outra")).toBe(3);
  });
});
