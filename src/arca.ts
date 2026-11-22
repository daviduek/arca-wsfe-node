/**
 * API de alto nivel. Es la forma recomendada de usar la libreria.
 *
 * Las funciones sueltas (`getTicket`, `issueVoucher`, `WsfeClient`) quedan
 * expuestas para casos que necesiten armar el flujo a mano.
 */
import { ENDPOINTS, assertEnvironmentAllowed, type ArcaEnvironment } from "./endpoints.js";
import { WsfeClient, consultVoucher, feDummy, lastAuthorized, type DummyStatus } from "./client.js";
import { getTicket, type ArcaCertificate, type Ticket } from "./wsaa.js";
import { inspectCertificate, type CertInfo } from "./csr.js";
import {
  getCondicionIvaReceptor,
  getCotizacion,
  getPtosVenta,
  getTiposCbte,
  getTiposDoc,
  getTiposIva,
  getTiposMonedas,
  getTiposTributos,
  usablePtosVenta,
  type ParamRow,
  type ParamsContext,
} from "./params.js";
import { issueVoucher, reconcileAttempt, type IssueContext, type IssueInput, type IssueResult } from "./issue.js";
import { cbteClase, notaCreditoPara, notaDebitoPara, type AssocVoucher } from "./voucher.js";
import { memoryAdapters } from "./adapters/memory.js";
import { noopLogger, type Logger } from "./logger.js";
import { ArcaError } from "./errors.js";
import { normalizeCuit } from "./cuit.js";
import type { ArcaAdapters, IssueAttempt } from "./adapters/types.js";

export interface ArcaClientConfig {
  environment: ArcaEnvironment;
  /** Certificado emitido por ARCA y su clave privada. */
  certificate: ArcaCertificate;
  /** CUIT titular del certificado. */
  cuit: string;
  /**
   * CUIT por el que se factura, cuando NO es el del certificado.
   *
   * Es el modelo de delegacion: un tercero te delega el servicio de
   * facturacion electronica en el Administrador de Relaciones de ARCA, y vos
   * firmas con tu certificado pero emitis en su nombre. El Auth de WSFE lleva
   * este CUIT.
   *
   * Si no lo pasas, se factura por `cuit`.
   */
  representedCuit?: string;
  /** Punto de venta por defecto. */
  ptoVta?: number;
  /** Persistencia e infraestructura. Por defecto, en memoria (solo para pruebas). */
  adapters?: ArcaAdapters;
  logger?: Logger;
  /** Habilita PRODUCCION. Ver `assertEnvironmentAllowed`. */
  allowProduction?: boolean;
  timeoutMs?: number;
  /** Reintentos de las consultas. Nunca aplican a la emision. */
  retries?: number;
}

export interface HealthReport {
  ok: boolean;
  environment: ArcaEnvironment;
  cuit: string;
  service?: DummyStatus;
  certificate?: CertInfo;
  ticket?: { source: Ticket["source"]; expirationTime: string };
  puntosDeVenta?: ParamRow[];
  problems: string[];
}

export class ArcaClient {
  readonly environment: ArcaEnvironment;
  /** CUIT por el que se emite. */
  readonly cuit: string;
  private readonly adapters: ArcaAdapters;
  private readonly logger: Logger;

  constructor(private readonly config: ArcaClientConfig) {
    assertEnvironmentAllowed(config.environment, config.allowProduction);
    this.environment = config.environment;
    this.cuit = normalizeCuit(config.representedCuit ?? config.cuit);
    this.adapters = config.adapters ?? memoryAdapters();
    this.logger = config.logger ?? noopLogger;
  }

  /** Ticket de Acceso vigente (del cache o nuevo). */
  ticket(): Promise<Ticket> {
    return getTicket({
      certificate: this.config.certificate,
      environment: this.environment,
      tickets: this.adapters.tickets,
      lock: this.adapters.lock,
      logger: this.logger,
      allowProduction: this.config.allowProduction,
    });
  }

  /** Cliente SOAP autenticado. */
  private async wsfe(): Promise<WsfeClient> {
    return new WsfeClient({
      url: ENDPOINTS[this.environment].wsfe,
      cuit: this.cuit,
      ticket: await this.ticket(),
      timeoutMs: this.config.timeoutMs,
      retries: this.config.retries,
      logger: this.logger,
    });
  }

  private async paramsCtx(): Promise<ParamsContext> {
    return {
      environment: this.environment,
      client: await this.wsfe(),
      cache: this.adapters.params,
    };
  }

  private async issueCtx(): Promise<IssueContext> {
    return {
      environment: this.environment,
      cuit: this.cuit,
      client: await this.wsfe(),
      adapters: this.adapters,
      ptoVta: this.config.ptoVta,
      logger: this.logger,
      allowProduction: this.config.allowProduction,
    };
  }

  /** FEDummy: estado del servicio. No requiere autenticacion. */
  async status(): Promise<DummyStatus> {
    const c = new WsfeClient({
      url: ENDPOINTS[this.environment].wsfe,
      cuit: this.cuit,
      logger: this.logger,
    });
    return feDummy(c);
  }

  /**
   * Chequeo completo de la conexion: servicio arriba, certificado valido y
   * vigente, Ticket de Acceso, puntos de venta habilitados. Pensado para un
   * endpoint de health o para la pantalla de configuracion de una app.
   */
  async health(): Promise<HealthReport> {
    const problems: string[] = [];
    const report: HealthReport = {
      ok: false,
      environment: this.environment,
      cuit: this.cuit,
      problems,
    };

    try {
      report.certificate = inspectCertificate(
        this.config.certificate.certPem,
        this.config.certificate.keyPem,
      );
      if (report.certificate.daysToExpiry < 0) {
        problems.push("El certificado esta vencido.");
      } else if (report.certificate.daysToExpiry < 30) {
        problems.push(`El certificado vence en ${report.certificate.daysToExpiry} dias.`);
      }
    } catch (e) {
      problems.push(`Certificado: ${(e as Error).message}`);
    }

    try {
      report.service = await this.status();
      for (const [k, v] of Object.entries(report.service)) {
        if (String(v).toLowerCase() !== "ok") problems.push(`${k} de ARCA responde "${v}".`);
      }
    } catch (e) {
      problems.push(`Servicio: ${(e as Error).message}`);
    }

    try {
      const t = await this.ticket();
      report.ticket = { source: t.source, expirationTime: t.expirationTime };
    } catch (e) {
      problems.push(`Autenticacion: ${(e as Error).message}`);
      report.ok = false;
      return report;
    }

    try {
      const pv = usablePtosVenta(await this.puntosDeVenta());
      report.puntosDeVenta = pv;
      if (!pv.length) {
        problems.push(
          "El CUIT no tiene puntos de venta de tipo Web Services habilitados: hay que crear uno en ARCA.",
        );
      }
    } catch (e) {
      problems.push(`Puntos de venta: ${(e as Error).message}`);
    }

    report.ok = problems.length === 0;
    return report;
  }

  /** Ultimo numero autorizado para un tipo de comprobante. */
  async lastNumber(cbteTipo: number, ptoVta?: number): Promise<number> {
    const pv = ptoVta ?? this.config.ptoVta;
    if (!pv) throw new ArcaError("LOCAL", "Falta el punto de venta");
    return lastAuthorized(await this.wsfe(), pv, cbteTipo);
  }

  /** Trae un comprobante ya emitido. */
  async getVoucher(cbteTipo: number, cbteNro: number, ptoVta?: number): Promise<any> {
    const pv = ptoVta ?? this.config.ptoVta;
    if (!pv) throw new ArcaError("LOCAL", "Falta el punto de venta");
    return consultVoucher(await this.wsfe(), pv, cbteTipo, cbteNro);
  }

  async puntosDeVenta(): Promise<ParamRow[]> {
    return getPtosVenta(await this.paramsCtx());
  }
  async tiposComprobante(): Promise<ParamRow[]> {
    return getTiposCbte(await this.paramsCtx());
  }
  async tiposDocumento(): Promise<ParamRow[]> {
    return getTiposDoc(await this.paramsCtx());
  }
  async tiposIva(): Promise<ParamRow[]> {
    return getTiposIva(await this.paramsCtx());
  }
  async tiposTributos(): Promise<ParamRow[]> {
    return getTiposTributos(await this.paramsCtx());
  }
  async monedas(): Promise<ParamRow[]> {
    return getTiposMonedas(await this.paramsCtx());
  }
  async cotizacion(monId: string): Promise<number> {
    return getCotizacion(await this.paramsCtx(), monId);
  }
  async condicionesIvaReceptor(clase: "A" | "B" | "C"): Promise<ParamRow[]> {
    return getCondicionIvaReceptor(await this.paramsCtx(), clase);
  }

  /** Emite un comprobante. Ver `issueVoucher` para el detalle del flujo. */
  async issue(input: IssueInput): Promise<IssueResult> {
    return issueVoucher(await this.issueCtx(), input);
  }

  /**
   * Emite una nota de credito que anula (total o parcialmente) un comprobante
   * ya autorizado. El tipo se deriva del original: Factura A -> NC A, etc.
   */
  async creditNote(opts: {
    /** Comprobante que se esta anulando. Debe estar autorizado. */
    original: { cbteTipo: number; ptoVta: number; cbteNro: number; cbteFch?: string };
    /** Importes de la nota. Si se omiten, se usa `total` como neto (comprobantes C). */
    amounts: Omit<IssueInput, "cbteTipo" | "assoc" | "concept" | "docType" | "docNumber"> & {
      concept?: IssueInput["concept"];
      docType: number;
      docNumber: string;
    };
    externalId?: string;
  }): Promise<IssueResult> {
    const cbteTipo = notaCreditoPara(opts.original.cbteTipo);
    const assoc: AssocVoucher[] = [
      {
        Tipo: opts.original.cbteTipo,
        PtoVta: opts.original.ptoVta,
        Nro: opts.original.cbteNro,
        CbteFch: opts.original.cbteFch,
      },
    ];
    return this.issue({
      ...opts.amounts,
      cbteTipo,
      concept: opts.amounts.concept ?? 1,
      assoc,
      externalId: opts.externalId,
    });
  }

  /** Nota de debito asociada a un comprobante ya autorizado. */
  async debitNote(opts: {
    original: { cbteTipo: number; ptoVta: number; cbteNro: number; cbteFch?: string };
    amounts: Omit<IssueInput, "cbteTipo" | "assoc" | "concept" | "docType" | "docNumber"> & {
      concept?: IssueInput["concept"];
      docType: number;
      docNumber: string;
    };
    externalId?: string;
  }): Promise<IssueResult> {
    return this.issue({
      ...opts.amounts,
      cbteTipo: notaDebitoPara(opts.original.cbteTipo),
      concept: opts.amounts.concept ?? 1,
      assoc: [
        {
          Tipo: opts.original.cbteTipo,
          PtoVta: opts.original.ptoVta,
          Nro: opts.original.cbteNro,
          CbteFch: opts.original.cbteFch,
        },
      ],
      externalId: opts.externalId,
    });
  }

  /**
   * Resuelve un intento que quedo en CONCILIANDO. Devuelve los datos del
   * comprobante si en ARCA existe, o null si no se emitio.
   */
  async reconcile(attempt: IssueAttempt) {
    return reconcileAttempt(await this.issueCtx(), attempt);
  }

  /** Clase (A, B o C) de un tipo de comprobante. */
  static clase(cbteTipo: number): "A" | "B" | "C" {
    return cbteClase(cbteTipo);
  }
}
