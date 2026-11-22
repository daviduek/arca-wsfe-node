/** Cliente SOAP de WSFEv1 (facturacion electronica de ARCA). */
import { soapPost } from "./http.js";
import { parseSoapBody, asArray } from "./xml.js";
import { ArcaError } from "./errors.js";
import { noopLogger, type Logger } from "./logger.js";
import type { Ticket } from "./wsaa.js";

const NS = "http://ar.gov.afip.dif.FEV1/";

export interface WsfeErr {
  Code: string;
  Msg: string;
}

export interface WsfeClientOptions {
  url: string;
  /**
   * CUIT que va en el header Auth. En el modelo de delegacion es el CUIT
   * REPRESENTADO (el del contribuyente que factura), que puede ser distinto
   * del CUIT dueño del certificado.
   */
  cuit: string;
  ticket?: Ticket;
  timeoutMs?: number;
  /** Reintentos para operaciones de consulta. Nunca se aplican a FECAESolicitar. */
  retries?: number;
  logger?: Logger;
}

export class WsfeClient {
  constructor(private readonly opts: WsfeClientOptions) {}

  private auth(): string {
    const t = this.opts.ticket;
    if (!t) throw new ArcaError("LOCAL", "WSFE requiere un Ticket de Acceso");
    return `<ar:Auth><ar:Token>${t.token}</ar:Token><ar:Sign>${t.sign}</ar:Sign><ar:Cuit>${this.opts.cuit}</ar:Cuit></ar:Auth>`;
  }

  /**
   * Llama un metodo de WSFEv1.
   *
   * `idempotent: false` desactiva los reintentos y es obligatorio para
   * FECAESolicitar: si la respuesta se pierde, el comprobante pudo haberse
   * autorizado igual y un reintento lo duplicaria.
   */
  async call(
    method: string,
    inner: string,
    { withAuth = true, idempotent = true }: { withAuth?: boolean; idempotent?: boolean } = {},
  ): Promise<any> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">
  <soap:Header/>
  <soap:Body>
    <ar:${method}>${withAuth ? this.auth() : ""}${inner}</ar:${method}>
  </soap:Body>
</soap:Envelope>`;

    const xml = await soapPost({
      url: this.opts.url,
      soapAction: `${NS}${method}`,
      body: envelope,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      retries: idempotent ? (this.opts.retries ?? 2) : 0,
      label: `WSFE.${method}`,
      logger: this.opts.logger ?? noopLogger,
    });

    const body = parseSoapBody(xml);
    const result = body?.[`${method}Response`]?.[`${method}Result`];
    if (result === undefined) {
      throw new ArcaError("SOAP_FAULT", `${method}: respuesta sin ${method}Result`);
    }
    return result;
  }

  /**
   * Lanza si la respuesta trae errores. Los codigos 600/601/602 son de
   * autenticacion o autorizacion; el resto son de validacion de datos.
   */
  static throwOnErrors(method: string, result: any): void {
    const errs = asArray<WsfeErr>(result?.Errors?.Err);
    if (!errs.length) return;
    const authCodes = new Set(["600", "601", "602"]);
    const kind = errs.some((e) => authCodes.has(String(e.Code))) ? "AUTHORIZATION" : "VALIDATION";
    throw new ArcaError(
      kind,
      `${method}: ${errs.map((e) => `${e.Code} ${e.Msg}`).join(" | ")}`,
      errs,
    );
  }
}

export interface DummyStatus {
  AppServer: string;
  DbServer: string;
  AuthServer: string;
}

/** FEDummy: estado del servicio. No necesita autenticacion. */
export function feDummy(c: WsfeClient): Promise<DummyStatus> {
  return c.call("FEDummy", "", { withAuth: false });
}

/** FECompUltimoAutorizado: ultimo numero autorizado para un punto de venta y tipo. */
export async function lastAuthorized(
  c: WsfeClient,
  ptoVta: number,
  cbteTipo: number,
): Promise<number> {
  const r = await c.call(
    "FECompUltimoAutorizado",
    `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`,
  );
  WsfeClient.throwOnErrors("FECompUltimoAutorizado", r);
  return Number(r.CbteNro);
}

/**
 * FECompConsultar: trae un comprobante ya emitido. Es la consulta que permite
 * conciliar cuando FECAESolicitar quedo sin respuesta.
 */
export async function consultVoucher(
  c: WsfeClient,
  ptoVta: number,
  cbteTipo: number,
  nro: number,
): Promise<any> {
  const r = await c.call(
    "FECompConsultar",
    `<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${nro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`,
  );
  WsfeClient.throwOnErrors("FECompConsultar", r);
  return r.ResultGet;
}
