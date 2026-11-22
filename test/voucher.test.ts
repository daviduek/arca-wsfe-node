import { describe, expect, it } from "vitest";
import {
  ALICUOTAS_IVA,
  CBTE_TIPOS,
  buildVoucher,
  cbteClase,
  draftToXml,
  ivaFromNet,
  notaCreditoPara,
  validateDraft,
} from "../src/voucher.js";

const HOY = "20261121";

function facturaC(over: Partial<Parameters<typeof buildVoucher>[0]> = {}) {
  return buildVoucher({
    cbteTipo: CBTE_TIPOS.FACTURA_C,
    ptoVta: 1,
    cbteNro: 1,
    concept: 1,
    docType: 99,
    docNumber: "0",
    fecha: HOY,
    netAmount: "1000.00",
    totalAmount: "1000.00",
    condIvaReceptorId: 5,
    ...over,
  });
}

describe("clase de comprobante", () => {
  it("clasifica A, B y C", () => {
    expect(cbteClase(CBTE_TIPOS.FACTURA_A)).toBe("A");
    expect(cbteClase(CBTE_TIPOS.NC_B)).toBe("B");
    expect(cbteClase(CBTE_TIPOS.FACTURA_C)).toBe("C");
  });

  it("deriva la nota de credito del tipo de factura", () => {
    expect(notaCreditoPara(CBTE_TIPOS.FACTURA_A)).toBe(CBTE_TIPOS.NC_A);
    expect(notaCreditoPara(CBTE_TIPOS.FACTURA_B)).toBe(CBTE_TIPOS.NC_B);
    expect(notaCreditoPara(CBTE_TIPOS.FACTURA_C)).toBe(CBTE_TIPOS.NC_C);
    expect(() => notaCreditoPara(99)).toThrow();
  });
});

describe("validateDraft", () => {
  it("acepta una factura C valida", () => {
    expect(validateDraft(facturaC(), HOY)).toEqual([]);
  });

  it("exige que el total sea la suma de los subtotales", () => {
    const d = facturaC({ totalAmount: "1200.00" });
    expect(validateDraft(d, HOY).join(" ")).toMatch(/ImpTotal/);
  });

  it("no permite IVA discriminado en un comprobante C", () => {
    const d = facturaC();
    d.ImpIVA = "210.00";
    d.ImpTotal = "1210.00";
    expect(validateDraft(d, HOY).join(" ")).toMatch(/ImpIVA debe ser 0/);
  });

  it("exige detalle de alicuotas en A/B con IVA", () => {
    const d = buildVoucher({
      cbteTipo: CBTE_TIPOS.FACTURA_A,
      ptoVta: 1,
      cbteNro: 1,
      concept: 1,
      docType: 80,
      docNumber: "30111111118",
      fecha: HOY,
      netAmount: "1000.00",
      ivaAmount: "210.00",
      totalAmount: "1210.00",
      condIvaReceptorId: 1,
    });
    expect(validateDraft(d, HOY).join(" ")).toMatch(/requiere el detalle de alicuotas/);
  });

  it("acepta A con alicuotas que cuadran", () => {
    const { item, iva } = ivaFromNet("1000.00", ALICUOTAS_IVA.VEINTIUNO);
    expect(iva).toBe("210.00");
    const d = buildVoucher({
      cbteTipo: CBTE_TIPOS.FACTURA_A,
      ptoVta: 1,
      cbteNro: 1,
      concept: 1,
      docType: 80,
      docNumber: "30111111118",
      fecha: HOY,
      netAmount: "1000.00",
      ivaAmount: iva,
      totalAmount: "1210.00",
      condIvaReceptorId: 1,
      ivaItems: [item],
    });
    expect(validateDraft(d, HOY)).toEqual([]);
  });

  it("detecta alicuotas que no cuadran con ImpIVA", () => {
    const d = buildVoucher({
      cbteTipo: CBTE_TIPOS.FACTURA_A,
      ptoVta: 1,
      cbteNro: 1,
      concept: 1,
      docType: 80,
      docNumber: "30111111118",
      fecha: HOY,
      netAmount: "1000.00",
      ivaAmount: "210.00",
      totalAmount: "1210.00",
      condIvaReceptorId: 1,
      ivaItems: [{ Id: 5, BaseImp: "1000.00", Importe: "105.00" }],
    });
    expect(validateDraft(d, HOY).join(" ")).toMatch(/Suma de alicuotas/);
  });

  it("exige comprobante asociado en una nota de credito", () => {
    const nc = facturaC({ cbteTipo: CBTE_TIPOS.NC_C });
    expect(validateDraft(nc, HOY).join(" ")).toMatch(/requieren comprobante asociado/);

    const ncOk = facturaC({
      cbteTipo: CBTE_TIPOS.NC_C,
      assoc: [{ Tipo: CBTE_TIPOS.FACTURA_C, PtoVta: 1, Nro: 7 }],
    });
    expect(validateDraft(ncOk, HOY)).toEqual([]);
  });

  it("exige periodo y vencimiento con concepto servicios", () => {
    const d = facturaC({ concept: 2 });
    const problems = validateDraft(d, HOY).join(" ");
    expect(problems).toMatch(/periodo del servicio/);
    expect(problems).toMatch(/vencimiento de pago/);
  });

  it("valida la ventana de +/- 5 dias para productos", () => {
    expect(validateDraft(facturaC({ fecha: "20261116" }), HOY)).toEqual([]);
    expect(validateDraft(facturaC({ fecha: "20261110" }), HOY).join(" ")).toMatch(/N-5 y N\+5/);
    expect(validateDraft(facturaC({ fecha: "20261201" }), HOY).join(" ")).toMatch(/N-5 y N\+5/);
  });

  it("no valida la ventana de fechas con concepto servicios", () => {
    const d = facturaC({
      concept: 2,
      fecha: "20261001",
      serviceFrom: "20260901",
      serviceTo: "20260930",
      paymentDue: "20261010",
    });
    expect(validateDraft(d, HOY)).toEqual([]);
  });

  it("valida el CUIT del receptor y el consumidor final", () => {
    expect(validateDraft(facturaC({ docType: 99, docNumber: "123" }), HOY).join(" ")).toMatch(
      /DocNro 0/,
    );
    expect(
      validateDraft(facturaC({ docType: 80, docNumber: "20111111111" }), HOY).join(" "),
    ).toMatch(/CUIT valido/);
  });

  it("exige CondicionIVAReceptorId (RG 5616)", () => {
    const d = facturaC();
    delete d.CondicionIVAReceptorId;
    expect(validateDraft(d, HOY).join(" ")).toMatch(/CondicionIVAReceptorId/);
  });

  it("exige detalle cuando hay tributos", () => {
    const d = facturaC({ tributesAmount: "50.00", totalAmount: "1050.00" });
    expect(validateDraft(d, HOY).join(" ")).toMatch(/detalle de tributos/);
  });
});

describe("draftToXml", () => {
  it("respeta el orden del WSDL al final del detalle", () => {
    const d = facturaC({
      cbteTipo: CBTE_TIPOS.NC_C,
      assoc: [{ Tipo: CBTE_TIPOS.FACTURA_C, PtoVta: 1, Nro: 7 }],
    });
    const xml = draftToXml(d);
    const order = ["MonId", "MonCotiz", "CanMisMonExt", "CondicionIVAReceptorId", "CbtesAsoc"].map(
      (t) => xml.indexOf(`<ar:${t}>`),
    );
    expect(order.every((v, i) => i === 0 || v > order[i - 1]!)).toBe(true);
  });

  it("serializa Tributos antes de Iva", () => {
    const { item } = ivaFromNet("1000.00", ALICUOTAS_IVA.VEINTIUNO);
    const d = buildVoucher({
      cbteTipo: CBTE_TIPOS.FACTURA_A,
      ptoVta: 1,
      cbteNro: 1,
      concept: 1,
      docType: 80,
      docNumber: "30111111118",
      fecha: HOY,
      netAmount: "1000.00",
      ivaAmount: "210.00",
      tributesAmount: "30.00",
      totalAmount: "1240.00",
      condIvaReceptorId: 1,
      ivaItems: [item],
      tributos: [{ Id: 99, Desc: "Otro", BaseImp: "1000.00", Alic: "3.00", Importe: "30.00" }],
    });
    expect(validateDraft(d, HOY)).toEqual([]);
    const xml = draftToXml(d);
    expect(xml.indexOf("<ar:Tributos>")).toBeLessThan(xml.indexOf("<ar:Iva>"));
  });

  it("emite un unico comprobante por request (CbteDesde = CbteHasta)", () => {
    const xml = draftToXml(facturaC({ cbteNro: 42 }));
    expect(xml).toContain("<ar:CbteDesde>42</ar:CbteDesde>");
    expect(xml).toContain("<ar:CbteHasta>42</ar:CbteHasta>");
    expect(xml).toContain("<ar:CantReg>1</ar:CantReg>");
  });

  it("omite los campos de servicio cuando el concepto es productos", () => {
    const xml = draftToXml(facturaC());
    expect(xml).not.toContain("FchServDesde");
    expect(xml).not.toContain("FchVtoPago");
  });
});
