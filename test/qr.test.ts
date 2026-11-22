import { describe, expect, it } from "vitest";
import { QR_BASE_URL, buildQrPayload, qrUrl } from "../src/qr.js";

const base = {
  cuit: "20111111112",
  cbteFch: "20261121",
  ptoVta: 2,
  cbteTipo: 11,
  cbteNro: 5,
  impTotal: "1000.00",
  monId: "PES",
  monCotiz: 1,
  docTipo: 99,
  docNro: "0",
  cae: "12345678901234",
};

describe("QR fiscal", () => {
  it("arma el payload con el formato de la especificacion", () => {
    const p = buildQrPayload(base);
    expect(p).toMatchObject({
      ver: 1,
      fecha: "2026-11-21",
      cuit: 20111111112,
      ptoVta: 2,
      tipoCmp: 11,
      nroCmp: 5,
      importe: 1000,
      moneda: "PES",
      ctz: 1,
      tipoCodAut: "E",
      codAut: 12345678901234,
    });
  });

  it("no incluye al receptor cuando es consumidor final sin identificar", () => {
    const p = buildQrPayload(base);
    expect(p.tipoDocRec).toBeUndefined();
    expect(p.nroDocRec).toBeUndefined();
  });

  it("incluye al receptor cuando esta identificado", () => {
    const p = buildQrPayload({ ...base, docTipo: 80, docNro: "30111111118" });
    expect(p.tipoDocRec).toBe(80);
    expect(p.nroDocRec).toBe(30111111118);
  });

  it("codifica el payload en base64 sobre la URL de ARCA", () => {
    const p = buildQrPayload(base);
    const url = qrUrl(p);
    expect(url.startsWith(QR_BASE_URL)).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(url.slice(QR_BASE_URL.length), "base64").toString("utf8"),
    );
    expect(decoded.codAut).toBe(12345678901234);
    expect(decoded.cuit).toBe(20111111112);
  });

  it("rechaza un CAE que no tenga 14 digitos", () => {
    expect(() => buildQrPayload({ ...base, cae: "123" })).toThrow(/14 digitos/);
  });

  it("rechaza una fecha con formato distinto de YYYYMMDD", () => {
    expect(() => buildQrPayload({ ...base, cbteFch: "2026-11-21" })).toThrow(/YYYYMMDD/);
  });

  it("no pierde precision en el CAE ni en el CUIT", () => {
    // 14 y 11 digitos entran en un double sin perder enteros, pero el parser
    // XML igual los trae como string: este test fija ese contrato.
    const p = buildQrPayload({ ...base, cae: "99999999999999" });
    expect(String(p.codAut)).toBe("99999999999999");
  });
});
