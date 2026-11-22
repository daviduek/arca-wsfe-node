/**
 * Armado, validacion y serializacion de comprobantes.
 *
 * Las validaciones locales de `validateDraft()` existen para no gastar
 * intentos contra ARCA: cada rechazo consume una llamada y, cuando el error es
 * de datos, el mensaje de ARCA suele ser poco claro. Lo que se puede verificar
 * antes, se verifica antes.
 */
import { D, round2, money as money2, type MoneyInput } from "./money.js";
import { diffArcaDays } from "./dates.js";
import { isValidCuit } from "./cuit.js";

/** Tipos de comprobante (tabla FEParamGetTiposCbte). */
export const CBTE_TIPOS = {
  FACTURA_A: 1,
  ND_A: 2,
  NC_A: 3,
  FACTURA_B: 6,
  ND_B: 7,
  NC_B: 8,
  FACTURA_C: 11,
  ND_C: 12,
  NC_C: 13,
} as const;

export const CLASE_A = new Set<number>([1, 2, 3]);
export const CLASE_B = new Set<number>([6, 7, 8]);
/** Incluye 15 (Recibo C). */
export const CLASE_C = new Set<number>([11, 12, 13, 15]);
/** Notas de credito y debito: exigen comprobante asociado. */
export const NOTAS = new Set<number>([2, 3, 7, 8, 12, 13]);
/** Notas de credito. */
export const NOTAS_CREDITO = new Set<number>([3, 8, 13]);

/** Alicuotas de IVA (tabla FEParamGetTiposIva): id -> tasa. */
export const ALICUOTAS_IVA = {
  /** 0% */
  CERO: { id: 3, rate: 0 },
  /** 10,5% */
  DIEZ_CINCO: { id: 4, rate: 10.5 },
  /** 21% */
  VEINTIUNO: { id: 5, rate: 21 },
  /** 27% */
  VEINTISIETE: { id: 6, rate: 27 },
  /** 5% */
  CINCO: { id: 8, rate: 5 },
  /** 2,5% */
  DOS_CINCO: { id: 9, rate: 2.5 },
} as const;

export type Concepto = 1 | 2 | 3;
export const CONCEPTO = { PRODUCTOS: 1, SERVICIOS: 2, AMBOS: 3 } as const;

export function cbteClase(cbteTipo: number): "A" | "B" | "C" {
  if (CLASE_A.has(cbteTipo)) return "A";
  if (CLASE_B.has(cbteTipo)) return "B";
  return "C";
}

export function cbteLabel(cbteTipo: number): string {
  const map: Record<number, string> = {
    1: "Factura A",
    2: "Nota de Débito A",
    3: "Nota de Crédito A",
    6: "Factura B",
    7: "Nota de Débito B",
    8: "Nota de Crédito B",
    11: "Factura C",
    12: "Nota de Débito C",
    13: "Nota de Crédito C",
    15: "Recibo C",
  };
  return map[cbteTipo] ?? `Comprobante ${cbteTipo}`;
}

/** Nota de credito correspondiente a un tipo de factura. */
export function notaCreditoPara(cbteTipo: number): number {
  const map: Record<number, number> = { 1: 3, 6: 8, 11: 13 };
  const nc = map[cbteTipo];
  if (!nc) throw new Error(`No hay nota de credito definida para el tipo ${cbteTipo}`);
  return nc;
}

/** Nota de debito correspondiente a un tipo de factura. */
export function notaDebitoPara(cbteTipo: number): number {
  const map: Record<number, number> = { 1: 2, 6: 7, 11: 12 };
  const nd = map[cbteTipo];
  if (!nd) throw new Error(`No hay nota de debito definida para el tipo ${cbteTipo}`);
  return nd;
}

export interface IvaItem {
  /** Id de la alicuota (ver ALICUOTAS_IVA). */
  Id: number;
  /** Base imponible, 2 decimales. */
  BaseImp: string;
  /** IVA de esa base, 2 decimales. */
  Importe: string;
}

export interface TributoItem {
  /** Id del tributo (tabla FEParamGetTiposTributos). */
  Id: number;
  Desc?: string;
  BaseImp: string;
  Alic: string;
  Importe: string;
}

export interface AssocVoucher {
  Tipo: number;
  PtoVta: number;
  Nro: number;
  /** CUIT del emisor del comprobante asociado, si es de otro contribuyente. */
  Cuit?: string;
  /** Fecha del comprobante asociado, YYYYMMDD. */
  CbteFch?: string;
}

/** Comprobante listo para serializar. Los importes ya son strings con 2 decimales. */
export interface VoucherDraft {
  CbteTipo: number;
  PtoVta: number;
  Concepto: Concepto;
  DocTipo: number;
  DocNro: string;
  CbteNro: number;
  /** YYYYMMDD */
  CbteFch: string;
  ImpTotal: string;
  ImpTotConc: string;
  ImpNeto: string;
  ImpOpEx: string;
  ImpTrib: string;
  ImpIVA: string;
  FchServDesde?: string;
  FchServHasta?: string;
  FchVtoPago?: string;
  MonId: string;
  MonCotiz: number;
  CanMisMonExt?: "S" | "N";
  /** RG 5616: obligatorio. */
  CondicionIVAReceptorId?: number;
  CbtesAsoc?: AssocVoucher[];
  Tributos?: TributoItem[];
  Iva?: IvaItem[];
}

export interface BuildVoucherInput {
  cbteTipo: number;
  ptoVta: number;
  cbteNro: number;
  concept: Concepto;
  docType: number;
  docNumber: string;
  /** YYYYMMDD */
  fecha: string;
  netAmount: MoneyInput;
  ivaAmount?: MoneyInput;
  exemptAmount?: MoneyInput;
  untaxedAmount?: MoneyInput;
  tributesAmount?: MoneyInput;
  totalAmount: MoneyInput;
  currency?: string;
  exchangeRate?: number;
  condIvaReceptorId?: number;
  /** YYYYMMDD, obligatorias con concepto 2 o 3. */
  serviceFrom?: string;
  serviceTo?: string;
  paymentDue?: string;
  ivaItems?: IvaItem[];
  tributos?: TributoItem[];
  assoc?: AssocVoucher[];
  /** "S" si se cobra en la misma moneda extranjera (RG 5616). */
  sameForeignCurrency?: boolean;
}

export function buildVoucher(i: BuildVoucherInput): VoucherDraft {
  const d: VoucherDraft = {
    CbteTipo: i.cbteTipo,
    PtoVta: i.ptoVta,
    Concepto: i.concept,
    DocTipo: i.docType,
    DocNro: i.docNumber,
    CbteNro: i.cbteNro,
    CbteFch: i.fecha,
    ImpTotal: money2(i.totalAmount),
    ImpTotConc: money2(i.untaxedAmount ?? 0),
    ImpNeto: money2(i.netAmount),
    ImpOpEx: money2(i.exemptAmount ?? 0),
    ImpTrib: money2(i.tributesAmount ?? 0),
    ImpIVA: money2(i.ivaAmount ?? 0),
    MonId: i.currency ?? "PES",
    MonCotiz: i.exchangeRate ?? 1,
    CanMisMonExt: i.sameForeignCurrency ? "S" : "N",
    CondicionIVAReceptorId: i.condIvaReceptorId,
  };
  if (i.concept === 2 || i.concept === 3) {
    d.FchServDesde = i.serviceFrom;
    d.FchServHasta = i.serviceTo;
    d.FchVtoPago = i.paymentDue;
  }
  if (i.ivaItems?.length) d.Iva = i.ivaItems;
  if (i.tributos?.length) d.Tributos = i.tributos;
  if (i.assoc?.length) d.CbtesAsoc = i.assoc;
  return d;
}

/**
 * Calcula el item de IVA a partir del neto y la alicuota.
 * `ivaFromNet(1000, ALICUOTAS_IVA.VEINTIUNO)` -> base 1000.00, importe 210.00
 */
export function ivaFromNet(
  net: MoneyInput,
  aliquot: { id: number; rate: number },
): { item: IvaItem; iva: string } {
  const base = round2(D(net));
  const iva = round2(base.times(aliquot.rate).dividedBy(100));
  return {
    item: { Id: aliquot.id, BaseImp: base.toFixed(2), Importe: iva.toFixed(2) },
    iva: iva.toFixed(2),
  };
}

/**
 * Chequeos locales previos al envio. Devuelve la lista de problemas: vacia
 * significa que el comprobante esta listo para mandarse.
 */
export function validateDraft(d: VoucherDraft, todayArcaDate: string): string[] {
  const p: string[] = [];
  const dec = (s: string) => D(s);

  // El total tiene que ser exactamente la suma de los subtotales.
  const sum = round2(
    dec(d.ImpTotConc)
      .plus(dec(d.ImpNeto))
      .plus(dec(d.ImpOpEx))
      .plus(dec(d.ImpTrib))
      .plus(dec(d.ImpIVA)),
  );
  if (!sum.equals(round2(dec(d.ImpTotal)))) {
    p.push(
      `ImpTotal (${d.ImpTotal}) != ImpTotConc+ImpNeto+ImpOpEx+ImpTrib+ImpIVA (${sum.toFixed(2)})`,
    );
  }
  if (dec(d.ImpTotal).lte(0)) p.push("ImpTotal debe ser > 0");

  if (CLASE_C.has(d.CbteTipo)) {
    // Los comprobantes C no discriminan IVA.
    if (!dec(d.ImpIVA).isZero()) p.push("Comprobante C: ImpIVA debe ser 0");
    if (!dec(d.ImpTotConc).isZero()) p.push("Comprobante C: ImpTotConc debe ser 0");
    if (!dec(d.ImpOpEx).isZero()) p.push("Comprobante C: ImpOpEx debe ser 0");
    if (d.Iva?.length) p.push("Comprobante C: no lleva detalle de alicuotas");
  } else if (d.Iva?.length) {
    const ivaSum = round2(d.Iva.reduce((a, it) => a.plus(D(it.Importe)), D(0)));
    if (!ivaSum.equals(round2(dec(d.ImpIVA)))) {
      p.push(`Suma de alicuotas IVA (${ivaSum.toFixed(2)}) != ImpIVA (${d.ImpIVA})`);
    }
    const baseSum = round2(d.Iva.reduce((a, it) => a.plus(D(it.BaseImp)), D(0)));
    if (!baseSum.equals(round2(dec(d.ImpNeto)))) {
      p.push(`Suma de bases IVA (${baseSum.toFixed(2)}) != ImpNeto (${d.ImpNeto})`);
    }
  } else if (dec(d.ImpIVA).gt(0)) {
    p.push("Comprobante A/B con ImpIVA > 0 requiere el detalle de alicuotas");
  }

  if (d.Tributos?.length) {
    const tribSum = round2(d.Tributos.reduce((a, it) => a.plus(D(it.Importe)), D(0)));
    if (!tribSum.equals(round2(dec(d.ImpTrib)))) {
      p.push(`Suma de tributos (${tribSum.toFixed(2)}) != ImpTrib (${d.ImpTrib})`);
    }
  } else if (dec(d.ImpTrib).gt(0)) {
    p.push("ImpTrib > 0 requiere el detalle de tributos");
  }

  if (NOTAS.has(d.CbteTipo) && !d.CbtesAsoc?.length) {
    p.push("Las notas de credito/debito requieren comprobante asociado");
  }

  if (!/^\d{8}$/.test(d.CbteFch)) {
    p.push("CbteFch debe ser YYYYMMDD");
  } else if (d.Concepto === 1) {
    // Productos: ARCA acepta la fecha en una ventana de +/- 5 dias.
    const days = diffArcaDays(d.CbteFch, todayArcaDate);
    if (days < -5 || days > 5) p.push("Concepto 1 (productos): CbteFch debe estar entre N-5 y N+5");
  }

  if (d.Concepto === 2 || d.Concepto === 3) {
    if (!d.FchServDesde || !d.FchServHasta) {
      p.push("Concepto servicios: requiere el periodo del servicio (desde y hasta)");
    }
    if (!d.FchVtoPago) p.push("Concepto servicios: requiere fecha de vencimiento de pago");
  }

  if (d.DocTipo === 99 && d.DocNro !== "0") {
    p.push("DocTipo 99 (consumidor final) requiere DocNro 0");
  }
  if (d.DocTipo === 80 && !isValidCuit(d.DocNro)) {
    p.push("DocNro no es un CUIT valido (digito verificador)");
  }
  if (d.MonId === "PES" && d.MonCotiz !== 1) p.push("MonId PES requiere MonCotiz 1");
  if (!Number.isInteger(d.CbteNro) || d.CbteNro < 1) p.push("CbteNro invalido");
  if (d.CondicionIVAReceptorId === undefined) {
    p.push("Falta CondicionIVAReceptorId (RG 5616)");
  }
  return p;
}

/**
 * Serializa el comprobante al XML de FECAESolicitar.
 *
 * El orden de los elementos NO es arbitrario: el WSDL lo define como
 * secuencia y ARCA rechaza el pedido si se altera. El orden correcto al final
 * del detalle es MonId, MonCotiz, CanMisMonExt, CondicionIVAReceptorId,
 * CbtesAsoc, Tributos, Iva.
 */
export function draftToXml(d: VoucherDraft): string {
  const opt = (tag: string, v: string | number | undefined) =>
    v !== undefined && v !== "" ? `\n<ar:${tag}>${v}</ar:${tag}>` : "";

  const cbtesAsoc = d.CbtesAsoc?.length
    ? `\n<ar:CbtesAsoc>${d.CbtesAsoc.map(
        (a) =>
          `<ar:CbteAsoc><ar:Tipo>${a.Tipo}</ar:Tipo><ar:PtoVta>${a.PtoVta}</ar:PtoVta><ar:Nro>${a.Nro}</ar:Nro>` +
          `${a.Cuit ? `<ar:Cuit>${a.Cuit}</ar:Cuit>` : ""}` +
          `${a.CbteFch ? `<ar:CbteFch>${a.CbteFch}</ar:CbteFch>` : ""}</ar:CbteAsoc>`,
      ).join("")}</ar:CbtesAsoc>`
    : "";

  const tributos = d.Tributos?.length
    ? `\n<ar:Tributos>${d.Tributos.map(
        (t) =>
          `<ar:Tributo><ar:Id>${t.Id}</ar:Id>${t.Desc ? `<ar:Desc>${t.Desc}</ar:Desc>` : ""}` +
          `<ar:BaseImp>${t.BaseImp}</ar:BaseImp><ar:Alic>${t.Alic}</ar:Alic><ar:Importe>${t.Importe}</ar:Importe></ar:Tributo>`,
      ).join("")}</ar:Tributos>`
    : "";

  const iva = d.Iva?.length
    ? `\n<ar:Iva>${d.Iva.map(
        (it) =>
          `<ar:AlicIva><ar:Id>${it.Id}</ar:Id><ar:BaseImp>${it.BaseImp}</ar:BaseImp><ar:Importe>${it.Importe}</ar:Importe></ar:AlicIva>`,
      ).join("")}</ar:Iva>`
    : "";

  return `<ar:FeCAEReq>
<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${d.PtoVta}</ar:PtoVta><ar:CbteTipo>${d.CbteTipo}</ar:CbteTipo></ar:FeCabReq>
<ar:FeDetReq><ar:FECAEDetRequest>
<ar:Concepto>${d.Concepto}</ar:Concepto>
<ar:DocTipo>${d.DocTipo}</ar:DocTipo>
<ar:DocNro>${d.DocNro}</ar:DocNro>
<ar:CbteDesde>${d.CbteNro}</ar:CbteDesde>
<ar:CbteHasta>${d.CbteNro}</ar:CbteHasta>
<ar:CbteFch>${d.CbteFch}</ar:CbteFch>
<ar:ImpTotal>${d.ImpTotal}</ar:ImpTotal>
<ar:ImpTotConc>${d.ImpTotConc}</ar:ImpTotConc>
<ar:ImpNeto>${d.ImpNeto}</ar:ImpNeto>
<ar:ImpOpEx>${d.ImpOpEx}</ar:ImpOpEx>
<ar:ImpTrib>${d.ImpTrib}</ar:ImpTrib>
<ar:ImpIVA>${d.ImpIVA}</ar:ImpIVA>${opt("FchServDesde", d.FchServDesde)}${opt("FchServHasta", d.FchServHasta)}${opt("FchVtoPago", d.FchVtoPago)}
<ar:MonId>${d.MonId}</ar:MonId>
<ar:MonCotiz>${d.MonCotiz}</ar:MonCotiz>${opt("CanMisMonExt", d.CanMisMonExt)}${opt("CondicionIVAReceptorId", d.CondicionIVAReceptorId)}${cbtesAsoc}${tributos}${iva}
</ar:FECAEDetRequest></ar:FeDetReq>
</ar:FeCAEReq>`;
}
