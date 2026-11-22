/**
 * QR fiscal obligatorio en el comprobante (RG 4892).
 * Especificacion: https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf
 */
import QRCode from "qrcode";
import { D } from "./money.js";

export const QR_BASE_URL = "https://www.arca.gob.ar/fe/qr/?p=";

export interface QrPayload {
  ver: 1;
  /** YYYY-MM-DD */
  fecha: string;
  cuit: number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda: string;
  ctz: number;
  tipoDocRec?: number;
  nroDocRec?: number;
  /** "E" = CAE, "A" = CAEA. */
  tipoCodAut: "E" | "A";
  codAut: number;
}

export interface BuildQrInput {
  cuit: string;
  /** Fecha del comprobante en formato ARCA: YYYYMMDD. */
  cbteFch: string;
  ptoVta: number;
  cbteTipo: number;
  cbteNro: number;
  impTotal: string | number;
  monId: string;
  monCotiz: number;
  docTipo: number;
  docNro: string;
  /** CAE de 14 digitos. */
  cae: string;
  tipoCodAut?: "E" | "A";
}

export function buildQrPayload(i: BuildQrInput): QrPayload {
  if (!/^\d{14}$/.test(i.cae)) {
    throw new Error("CAE invalido para el QR: se esperan 14 digitos");
  }
  if (!/^\d{8}$/.test(i.cbteFch)) {
    throw new Error("cbteFch invalida para el QR: se espera YYYYMMDD");
  }

  const p: QrPayload = {
    ver: 1,
    fecha: `${i.cbteFch.slice(0, 4)}-${i.cbteFch.slice(4, 6)}-${i.cbteFch.slice(6, 8)}`,
    cuit: Number(i.cuit),
    ptoVta: i.ptoVta,
    tipoCmp: i.cbteTipo,
    nroCmp: i.cbteNro,
    importe: Number(D(i.impTotal).toFixed(2)),
    moneda: i.monId,
    ctz: i.monCotiz,
    tipoCodAut: i.tipoCodAut ?? "E",
    codAut: Number(i.cae),
  };

  // Consumidor final sin identificar: el receptor no va en el QR.
  if (i.docTipo !== 99 && i.docNro && i.docNro !== "0") {
    p.tipoDocRec = i.docTipo;
    p.nroDocRec = Number(i.docNro);
  }
  return p;
}

/** URL que codifica el QR: el payload va en base64. */
export function qrUrl(p: QrPayload): string {
  return QR_BASE_URL + Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

/** PNG del QR, para incrustar en el PDF del comprobante. */
export function qrPngBuffer(p: QrPayload): Promise<Buffer> {
  return QRCode.toBuffer(qrUrl(p), { errorCorrectionLevel: "M", margin: 2, width: 360 });
}

/** QR como data URL, para mostrarlo en una pagina. */
export function qrDataUrl(p: QrPayload): Promise<string> {
  return QRCode.toDataURL(qrUrl(p), { errorCorrectionLevel: "M", margin: 2, width: 360 });
}
