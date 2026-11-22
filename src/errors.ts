/**
 * Clasificacion de errores de ARCA.
 *
 * La clase del error dice que puede hacer el llamador, y es la pieza mas
 * importante para no duplicar comprobantes:
 *
 * - TRANSPORT en una consulta  -> se puede reintentar.
 * - TRANSPORT en FECAESolicitar -> NO se puede reintentar a ciegas: el
 *   comprobante pudo haberse emitido igual. Hay que conciliar.
 * - VALIDATION / REJECTED      -> no se emitio nada; corregir los datos.
 * - AMBIGUOUS_RESULT           -> requiere intervencion humana.
 */
export type ArcaErrorKind =
  /** Falla de red, timeout o HTTP != 200. */
  | "TRANSPORT"
  /** SOAP Fault devuelto por el servicio. */
  | "SOAP_FAULT"
  /** Falla al obtener el Ticket de Acceso en WSAA (cert, clave o relacion). */
  | "WSAA_AUTH"
  /** ARCA rechazo la autorizacion (codigos 600/601/602). */
  | "AUTHORIZATION"
  /** ARCA rechazo los datos del comprobante. */
  | "VALIDATION"
  /** FECAESolicitar devolvio Resultado = R (rechazado). */
  | "REJECTED"
  /** Validacion local: los datos no pasaron los chequeos previos al envio. */
  | "LOCAL"
  /** No se pudo determinar si el comprobante se emitio: revisar a mano. */
  | "AMBIGUOUS_RESULT";

export class ArcaError extends Error {
  constructor(
    public readonly kind: ArcaErrorKind,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`[${kind}] ${message}`);
    this.name = "ArcaError";
  }

  /** `true` si la operacion se puede reintentar sin riesgo de duplicar. */
  get retryable(): boolean {
    return this.kind === "TRANSPORT";
  }
}

/**
 * Mensaje en castellano apto para mostrarle a un usuario final, sin jerga.
 * Pensado para una UI; adaptalo a tu producto si necesitas otro tono.
 */
export function humanArcaMessage(e: unknown): string {
  if (!(e instanceof ArcaError)) {
    return "No pudimos completar la operacion con ARCA. No se genero ningun comprobante.";
  }
  switch (e.kind) {
    case "TRANSPORT":
      return "No pudimos conectarnos con ARCA. Puede ser un problema temporal: probá de nuevo en unos minutos.";
    case "SOAP_FAULT":
      return "ARCA devolvió una respuesta inesperada. No se generó ningún comprobante.";
    case "WSAA_AUTH":
      return "Hubo un problema al autenticarnos con ARCA. Revisá el certificado y la relación del CUIT con el servicio de facturación electrónica.";
    case "AUTHORIZATION":
      return "ARCA no autorizó la operación para este CUIT. Verificá la relación con el servicio y que el punto de venta esté habilitado.";
    case "VALIDATION":
      return "ARCA rechazó los datos del comprobante. Revisá los importes y los datos del receptor.";
    case "REJECTED":
      return "ARCA rechazó este comprobante. No se generó ningún comprobante válido.";
    case "AMBIGUOUS_RESULT":
      return "La respuesta de ARCA quedó incompleta. Verificá en ARCA si el comprobante se emitió antes de volver a emitirlo.";
    case "LOCAL":
      return `Los datos no pasaron la validación: ${e.message.replace(/^\[LOCAL\] /, "")}`;
    default:
      return "No pudimos emitir el comprobante.";
  }
}
