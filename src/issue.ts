/**
 * Emision de comprobantes con numeracion serializada y conciliacion.
 *
 * El problema que resuelve este archivo: `FECAESolicitar` no es idempotente.
 * Si la llamada se corta por timeout, el comprobante pudo haberse autorizado
 * igual. Reintentar a ciegas duplica el comprobante, y un comprobante de mas
 * en produccion solo se arregla con una nota de credito.
 *
 * La secuencia es:
 *
 * 1. Lock por (CUIT, punto de venta, tipo): nunca dos emisiones a la vez.
 * 2. Conciliar intentos anteriores que quedaron sin resolver.
 * 3. Numerar preguntandole a ARCA el ultimo autorizado (nunca un contador local).
 * 4. Validar local.
 * 5. Guardar el intento ANTES de llamar.
 * 6. Llamar a FECAESolicitar, sin reintentos.
 * 7. Si hubo timeout, preguntarle a ARCA si ese numero existe y con que importe.
 */
import { createHash } from "node:crypto";
import { ArcaError } from "./errors.js";
import { ENDPOINTS, assertEnvironmentAllowed, type ArcaEnvironment } from "./endpoints.js";
import { WsfeClient, consultVoucher, lastAuthorized } from "./client.js";
import { getCondicionIvaReceptor, type ParamsContext } from "./params.js";
import { asArray } from "./xml.js";
import { D } from "./money.js";
import { todayArcaDate } from "./dates.js";
import { noopLogger, redactXml, type Logger } from "./logger.js";
import {
  buildVoucher,
  cbteClase,
  draftToXml,
  validateDraft,
  type BuildVoucherInput,
  type VoucherDraft,
} from "./voucher.js";
import { buildQrPayload, qrUrl, type QrPayload } from "./qr.js";
import type { ArcaAdapters, IssueAttempt } from "./adapters/types.js";

export interface ArcaMessage {
  Code: string;
  Msg: string;
}

export interface IssueResult {
  status: "AUTORIZADA" | "RECHAZADA" | "CONCILIANDO";
  cae?: string;
  /** Vencimiento del CAE, YYYYMMDD. */
  caeExpiry?: string;
  cbteNro?: number;
  /** Fecha con la que quedo emitido, YYYYMMDD. */
  cbteFch?: string;
  ptoVta: number;
  cbteTipo: number;
  /** Observaciones de ARCA: el comprobante vale, pero revisalas. */
  observations?: ArcaMessage[];
  errors?: ArcaMessage[];
  /** `true` si el resultado salio de conciliar, no de esta llamada. */
  reconciled?: boolean;
  attemptId: string;
  /** Datos del QR fiscal, si quedo autorizado. */
  qr?: { payload: QrPayload; url: string };
  /** XML enviado, con el token y el sign enmascarados. Para auditoria. */
  requestXml: string;
}

export type IssueInput = Omit<BuildVoucherInput, "cbteNro" | "ptoVta" | "fecha"> & {
  ptoVta?: number;
  /** YYYYMMDD. Por defecto, hoy en hora de Argentina. */
  fecha?: string;
  /**
   * Tu identificador de esta venta (id de factura, de orden, lo que uses).
   *
   * Es lo que hace la emision idempotente de punta a punta: si un intento
   * anterior con este mismo id quedo sin resolver y en ARCA ya existe el
   * comprobante, se devuelve ese resultado en vez de emitir uno nuevo.
   */
  externalId?: string;
};

export interface IssueContext {
  environment: ArcaEnvironment;
  /** CUIT emisor (el representado, si usas delegacion). */
  cuit: string;
  client: WsfeClient;
  adapters: ArcaAdapters;
  /** Punto de venta por defecto. */
  ptoVta?: number;
  logger?: Logger;
  allowProduction?: boolean;
  /** Si es `false`, no se consulta la tabla de condiciones de IVA. Por defecto `true`. */
  validateCondIva?: boolean;
}

interface CaeResponse {
  resultado: string;
  cae?: string;
  caeFchVto?: string;
  cbteNro?: number;
  cbteFch?: string;
  observaciones: ArcaMessage[];
  errores: ArcaMessage[];
}

function parseCaeResponse(r: any): CaeResponse {
  const det = asArray<any>(r?.FeDetResp?.FECAEDetResponse)[0] ?? {};
  return {
    resultado: det.Resultado ?? r?.FeCabResp?.Resultado,
    cae: det.CAE || undefined,
    caeFchVto: det.CAEFchVto || undefined,
    cbteNro: det.CbteDesde !== undefined ? Number(det.CbteDesde) : undefined,
    cbteFch: det.CbteFch || undefined,
    observaciones: asArray<ArcaMessage>(det?.Observaciones?.Obs),
    errores: asArray<ArcaMessage>(r?.Errors?.Err),
  };
}

/** Datos de un comprobante autorizado por ARCA. */
export interface AuthorizedVoucher {
  cae: string;
  caeFchVto?: string;
  cbteNro: number;
  cbteFch: string;
  observaciones: ArcaMessage[];
}

/**
 * Pregunta a ARCA si un numero concreto existe, y verifica que el importe sea
 * el esperado. Devuelve null si no se emitio.
 *
 * Si el numero existe con OTRO importe, alguien mas uso ese numero: eso no se
 * resuelve automaticamente y se lanza AMBIGUOUS_RESULT para que lo revise una
 * persona.
 */
async function reconcile(
  client: WsfeClient,
  ptoVta: number,
  cbteTipo: number,
  cbteNro: number,
  expectedTotal: string,
): Promise<AuthorizedVoucher | null> {
  const last = await lastAuthorized(client, ptoVta, cbteTipo);
  if (last < cbteNro) return null; // ARCA nunca llego a autorizarlo

  const g = await consultVoucher(client, ptoVta, cbteTipo, cbteNro);
  if (!g) return null;

  if (!D(String(g.ImpTotal)).equals(D(expectedTotal))) {
    throw new ArcaError(
      "AMBIGUOUS_RESULT",
      `El comprobante ${cbteTipo}-${ptoVta}-${cbteNro} existe en ARCA con un importe distinto ` +
        `(ARCA: ${g.ImpTotal}, esperado: ${expectedTotal}). Requiere revision manual.`,
      g,
    );
  }

  return {
    cae: String(g.CodAutorizacion),
    caeFchVto: g.FchVto ? String(g.FchVto) : undefined,
    // Conocemos el numero que consultamos: si la respuesta no lo repite, vale el pedido.
    cbteNro: g.CbteDesde !== undefined ? Number(g.CbteDesde) : cbteNro,
    cbteFch: String(g.CbteFch),
    observaciones: asArray<ArcaMessage>(g?.Observaciones?.Obs),
  };
}

function authorizedResult(
  ctx: IssueContext,
  draft: VoucherDraft,
  auth: AuthorizedVoucher,
  attemptId: string,
  requestXml: string,
  reconciled: boolean,
): IssueResult {
  const payload = buildQrPayload({
    cuit: ctx.cuit,
    cbteFch: auth.cbteFch,
    ptoVta: draft.PtoVta,
    cbteTipo: draft.CbteTipo,
    cbteNro: auth.cbteNro,
    impTotal: draft.ImpTotal,
    monId: draft.MonId,
    monCotiz: draft.MonCotiz,
    docTipo: draft.DocTipo,
    docNro: draft.DocNro,
    cae: auth.cae,
  });
  return {
    status: "AUTORIZADA",
    cae: auth.cae,
    caeExpiry: auth.caeFchVto,
    cbteNro: auth.cbteNro,
    cbteFch: auth.cbteFch,
    ptoVta: draft.PtoVta,
    cbteTipo: draft.CbteTipo,
    observations: auth.observaciones,
    reconciled: reconciled || undefined,
    attemptId,
    qr: { payload, url: qrUrl(payload) },
    requestXml,
  };
}

/**
 * Emite un comprobante y devuelve el CAE.
 *
 * Nunca lanza por un rechazo de ARCA: un rechazo es un resultado
 * (`status: "RECHAZADA"`) con el detalle en `errors`. Si lanza, es porque la
 * validacion local fallo o porque no se pudo saber que paso.
 *
 * `status: "CONCILIANDO"` significa que la llamada se corto y ARCA todavia no
 * registra el comprobante. NO vuelvas a emitir con otro numero: llama de nuevo
 * con el mismo `externalId` y la libreria concilia.
 */
export async function issueVoucher(ctx: IssueContext, input: IssueInput): Promise<IssueResult> {
  assertEnvironmentAllowed(ctx.environment, ctx.allowProduction);
  const log = ctx.logger ?? noopLogger;
  const { attempts, lock, params } = ctx.adapters;

  const ptoVta = input.ptoVta ?? ctx.ptoVta;
  if (!ptoVta) throw new ArcaError("LOCAL", "Falta el punto de venta (ptoVta)");
  const fecha = input.fecha ?? todayArcaDate();
  const lockName = `issue:${ctx.environment}:${ctx.cuit}:${ptoVta}:${input.cbteTipo}`;

  return lock(lockName, async () => {
    // 1. Intentos anteriores sin resolver para esta misma serie.
    const pending = await attempts.findUnresolved({
      cuit: ctx.cuit,
      ptoVta,
      cbteTipo: input.cbteTipo,
    });

    if (pending) {
      const resolved = await resolvePending(ctx, pending, log);
      // Si el intento colgado era de ESTA venta y ya existe en ARCA, no se reemite.
      if (
        resolved &&
        input.externalId !== undefined &&
        pending.externalId === input.externalId
      ) {
        const draft = buildVoucher({
          ...input,
          ptoVta: pending.ptoVta,
          cbteNro: resolved.cbteNro,
          fecha: resolved.cbteFch,
        });
        log("warn", "El comprobante ya estaba emitido en ARCA: no se reemite", {
          externalId: input.externalId,
          cbteNro: resolved.cbteNro,
        });
        return authorizedResult(
          ctx,
          draft,
          resolved,
          pending.id,
          redactXml(draftToXml(draft)),
          true,
        );
      }
    }

    // 2. Condicion de IVA del receptor (RG 5616).
    const clase = cbteClase(input.cbteTipo);
    let condId = input.condIvaReceptorId;
    if (condId === undefined && clase === "C") condId = 5; // consumidor final
    if (ctx.validateCondIva !== false) {
      const paramsCtx: ParamsContext = {
        environment: ctx.environment,
        client: ctx.client,
        cache: params,
      };
      const conds = await getCondicionIvaReceptor(paramsCtx, clase);
      if (condId === undefined || !conds.some((c) => Number(c.Id) === condId)) {
        throw new ArcaError(
          "LOCAL",
          `Condicion de IVA del receptor invalida para un comprobante clase ${clase}: ${condId}`,
        );
      }
    }

    // 3. Numeracion: siempre contra ARCA.
    const last = await lastAuthorized(ctx.client, ptoVta, input.cbteTipo);
    const cbteNro = last + 1;

    // 4. Validacion local.
    const draft = buildVoucher({ ...input, ptoVta, cbteNro, fecha, condIvaReceptorId: condId });
    const problems = validateDraft(draft, todayArcaDate());
    if (problems.length) throw new ArcaError("LOCAL", problems.join("; "));

    const xml = draftToXml(draft);
    const safeXml = redactXml(xml);

    // 5. El intento se persiste ANTES de llamar.
    const attempt = await attempts.create({
      cuit: ctx.cuit,
      ptoVta,
      cbteTipo: input.cbteTipo,
      cbteNro,
      total: draft.ImpTotal,
      requestHash: createHash("sha256").update(xml).digest("hex"),
      externalId: input.externalId ?? null,
    });

    // 6. FECAESolicitar, sin reintentos.
    let raw: any;
    try {
      raw = await ctx.client.call("FECAESolicitar", xml, { idempotent: false });
    } catch (e) {
      if (e instanceof ArcaError && e.kind === "TRANSPORT") {
        log("warn", "FECAESolicitar quedo sin respuesta: conciliando antes de reintentar", {
          cbteNro,
          externalId: input.externalId,
        });
        await attempts.update(attempt.id, {
          status: "AMBIGUO",
          errorClass: "TRANSPORT",
          errorDetail: String(e.message).slice(0, 500),
        });

        // 7. Preguntarle a ARCA si entro.
        const found = await reconcile(
          ctx.client,
          ptoVta,
          input.cbteTipo,
          cbteNro,
          draft.ImpTotal,
        ).catch(() => null);

        if (found) {
          await attempts.update(attempt.id, { status: "CONCILIADO", resolvedAt: new Date() });
          return authorizedResult(ctx, draft, found, attempt.id, safeXml, true);
        }
        return {
          status: "CONCILIANDO",
          ptoVta,
          cbteTipo: input.cbteTipo,
          attemptId: attempt.id,
          requestXml: safeXml,
        };
      }
      await attempts.update(attempt.id, {
        status: "FALLIDO",
        resolvedAt: new Date(),
        errorClass: e instanceof ArcaError ? e.kind : "UNKNOWN",
        errorDetail: String((e as Error)?.message).slice(0, 500),
      });
      throw e;
    }

    const parsed = parseCaeResponse(raw);

    if (parsed.resultado === "A" && parsed.cae) {
      await attempts.update(attempt.id, { status: "EXITO", resolvedAt: new Date() });
      return authorizedResult(
        ctx,
        draft,
        {
          cae: parsed.cae,
          caeFchVto: parsed.caeFchVto,
          cbteNro: parsed.cbteNro ?? cbteNro,
          cbteFch: parsed.cbteFch ?? draft.CbteFch,
          observaciones: parsed.observaciones,
        },
        attempt.id,
        safeXml,
        false,
      );
    }

    // Rechazado: no se emitio nada.
    const allErrors = [...parsed.errores, ...parsed.observaciones];
    await attempts.update(attempt.id, {
      status: "FALLIDO",
      resolvedAt: new Date(),
      errorClass: "REJECTED",
      errorDetail: JSON.stringify(allErrors).slice(0, 1000),
    });
    return {
      status: "RECHAZADA",
      ptoVta,
      cbteTipo: input.cbteTipo,
      errors: allErrors,
      attemptId: attempt.id,
      requestXml: safeXml,
    };
  });
}

/** Cierra un intento colgado: lo concilia contra ARCA y actualiza su estado. */
async function resolvePending(
  ctx: IssueContext,
  pending: IssueAttempt,
  log: Logger,
): Promise<AuthorizedVoucher | null> {
  const found = await reconcile(
    ctx.client,
    pending.ptoVta,
    pending.cbteTipo,
    pending.cbteNro,
    pending.total,
  );

  if (found) {
    await ctx.adapters.attempts.update(pending.id, {
      status: "CONCILIADO",
      resolvedAt: new Date(),
    });
    return found;
  }

  await ctx.adapters.attempts.update(pending.id, {
    status: "FALLIDO",
    resolvedAt: new Date(),
    errorDetail: "Conciliado: el comprobante no se emitio en ARCA",
  });
  log("info", "Intento anterior conciliado: no se habia emitido", {
    attemptId: pending.id,
    cbteNro: pending.cbteNro,
  });
  return null;
}

/**
 * Concilia un intento que quedo en CONCILIANDO, sin emitir nada.
 * Util desde un job: resuelve los intentos ambiguos que quedaron pendientes.
 */
export async function reconcileAttempt(
  ctx: IssueContext,
  attempt: IssueAttempt,
): Promise<AuthorizedVoucher | null> {
  assertEnvironmentAllowed(ctx.environment, ctx.allowProduction);
  return resolvePending(ctx, attempt, ctx.logger ?? noopLogger);
}

export { ENDPOINTS };
