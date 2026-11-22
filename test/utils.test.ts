import { describe, expect, it } from "vitest";
import { formatCuit, isValidCuit, normalizeCuit } from "../src/cuit.js";
import { diffArcaDays, fromArcaDate, isoArgentina, toArcaDate, todayArg } from "../src/dates.js";
import { D, money, round2, sumMoney } from "../src/money.js";
import { redactXml } from "../src/logger.js";
import { createInProcessLock } from "../src/adapters/memory.js";

describe("CUIT", () => {
  it("valida el digito verificador", () => {
    expect(isValidCuit("20111111112")).toBe(true);
    expect(isValidCuit("30111111118")).toBe(true);
    expect(isValidCuit("20111111111")).toBe(false); // digito verificador erroneo
    expect(isValidCuit("2011111111")).toBe(false); // 10 digitos
    expect(isValidCuit("abcdefghijk")).toBe(false);
  });

  it("normaliza y formatea", () => {
    expect(normalizeCuit("20-11111111-2")).toBe("20111111112");
    expect(formatCuit("20111111112")).toBe("20-11111111-2");
  });
});

describe("fechas", () => {
  it("convierte entre YYYY-MM-DD y el formato de ARCA", () => {
    expect(toArcaDate("2026-11-21")).toBe("20261121");
    expect(fromArcaDate("20261121")).toBe("2026-11-21");
    expect(() => toArcaDate("21/11/2026")).toThrow();
  });

  it("usa el dia de Argentina, no el del servidor en UTC", () => {
    // 2026-11-22T01:30:00Z son las 22:30 del 21 en Argentina.
    expect(todayArg(new Date("2026-11-22T01:30:00Z"))).toBe("2026-11-21");
    expect(todayArg(new Date("2026-11-22T04:30:00Z"))).toBe("2026-11-22");
  });

  it("escribe el TRA con offset -03:00", () => {
    expect(isoArgentina(new Date("2026-11-21T15:00:00Z"))).toBe("2026-11-21T12:00:00-03:00");
  });

  it("calcula diferencias de dias", () => {
    expect(diffArcaDays("20261121", "20261116")).toBe(5);
    expect(diffArcaDays("20261116", "20261121")).toBe(-5);
    expect(diffArcaDays("20270101", "20261231")).toBe(1);
  });
});

describe("dinero", () => {
  it("no usa floating point", () => {
    expect(sumMoney(["0.1", "0.2"]).toFixed(2)).toBe("0.30");
    expect(money(1000)).toBe("1000.00");
  });

  it("redondea half-up a 2 decimales", () => {
    expect(round2(D("10.005")).toFixed(2)).toBe("10.01");
    expect(round2(D("10.004")).toFixed(2)).toBe("10.00");
  });
});

describe("redactXml", () => {
  it("enmascara el token y el sign del Ticket de Acceso", () => {
    const xml =
      "<ar:Auth><ar:Token>PD94bWw...secreto</ar:Token><ar:Sign>firmasecreta</ar:Sign><ar:Cuit>20111111112</ar:Cuit></ar:Auth>";
    const safe = redactXml(xml);
    expect(safe).not.toContain("secreto");
    expect(safe).not.toContain("firmasecreta");
    expect(safe).toContain("[REDACTED]");
    expect(safe).toContain("20111111112");
  });

  it("enmascara el CMS firmado del login de WSAA", () => {
    expect(redactXml("<wsaa:in0>MIIFcms</wsaa:in0>")).not.toContain("MIIFcms");
  });
});

describe("lock en memoria", () => {
  it("serializa las secciones con el mismo nombre", async () => {
    const lock = createInProcessLock();
    const order: string[] = [];
    const task = (name: string, ms: number) =>
      lock("serie", async () => {
        order.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:out`);
      });

    await Promise.all([task("a", 20), task("b", 1)]);
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });

  it("no corre en paralelo distintas claves de la misma serie", async () => {
    const lock = createInProcessLock();
    let running = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        lock("x", async () => {
          max = Math.max(max, ++running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(max).toBe(1);
  });

  it("libera el turno aunque la seccion falle", async () => {
    const lock = createInProcessLock();
    await expect(lock("y", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lock("y", async () => "ok")).resolves.toBe("ok");
  });

  it("permite paralelismo entre nombres distintos", async () => {
    const lock = createInProcessLock();
    let running = 0;
    let max = 0;
    await Promise.all(
      ["a", "b", "c"].map((n) =>
        lock(n, async () => {
          max = Math.max(max, ++running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(max).toBe(3);
  });
});
