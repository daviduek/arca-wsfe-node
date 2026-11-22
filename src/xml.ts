import { XMLParser } from "fast-xml-parser";
import { ArcaError } from "./errors.js";

/**
 * Parser XML para las respuestas de ARCA.
 *
 * `parseTagValue: false` es deliberado y NO se debe cambiar: los CAE (14
 * digitos) y los CUIT (11 digitos) exceden la precision de un number de
 * JavaScript, y al convertirlos automaticamente se pierden digitos.
 * Todo llega como string y se convierte a mano donde corresponde.
 */
export const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Devuelve el Body del sobre SOAP, o lanza si vino un Fault. */
export function parseSoapBody(
  xml: string,
  faultKind: "SOAP_FAULT" | "WSAA_AUTH" = "SOAP_FAULT",
): any {
  const doc = parser.parse(xml);
  const body = doc?.Envelope?.Body;
  if (!body) {
    throw new ArcaError("TRANSPORT", "Respuesta sin SOAP Body", xml.slice(0, 300));
  }
  if (body.Fault) {
    const f = body.Fault;
    throw new ArcaError(faultKind, `${f.faultcode ?? ""} ${f.faultstring ?? ""}`.trim(), f);
  }
  return body;
}

/**
 * Normaliza los nodos que ARCA devuelve como objeto cuando hay uno solo y
 * como array cuando hay varios.
 */
export function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null || (x as unknown) === "") return [];
  return Array.isArray(x) ? x : [x];
}
