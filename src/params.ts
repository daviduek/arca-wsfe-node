/**
 * Tablas de parametros de WSFE (tipos de comprobante, de documento, alicuotas
 * de IVA, puntos de venta, condiciones de IVA del receptor).
 *
 * Cambian muy poco, asi que se cachean: por defecto 24 horas. Sirven para
 * validar antes de emitir (por ejemplo, que el punto de venta exista y no este
 * bloqueado) y para armar los selectores de una UI.
 */
import { WsfeClient } from "./client.js";
import { asArray } from "./xml.js";
import type { ArcaEnvironment } from "./endpoints.js";
import type { ParamCache } from "./adapters/types.js";

export type ParamRow = Record<string, string>;

export const DEFAULT_PARAM_TTL_MS = 24 * 3600 * 1000;

export interface ParamsContext {
  environment: ArcaEnvironment;
  client: WsfeClient;
  cache: ParamCache;
  ttlMs?: number;
}

async function listRemote(
  c: WsfeClient,
  method: string,
  path: string[],
  inner = "",
): Promise<ParamRow[]> {
  const r = await c.call(method, inner);
  WsfeClient.throwOnErrors(method, r);
  let node: any = r?.ResultGet;
  for (const p of path) node = node?.[p];
  return asArray<ParamRow>(node);
}

async function cachedList(
  ctx: ParamsContext,
  method: string,
  path: string[],
  variant = "",
  inner = "",
): Promise<ParamRow[]> {
  const key = `${ctx.environment}:${method}:${variant}`;
  const ttl = ctx.ttlMs ?? DEFAULT_PARAM_TTL_MS;

  const hit = await ctx.cache.get(key);
  if (hit && Date.now() - hit.fetchedAt.getTime() < ttl) return hit.rows;

  const rows = await listRemote(ctx.client, method, path, inner);
  await ctx.cache.set(key, { rows, fetchedAt: new Date() });
  return rows;
}

/**
 * Puntos de venta habilitados para web services.
 *
 * Si devuelve vacio, el CUIT no tiene ningun punto de venta de tipo
 * "Web Services" dado de alta: hay que crearlo en ARCA antes de poder emitir.
 * El codigo 602 ("sin resultados") se trata como lista vacia, no como error.
 */
export const getPtosVenta = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetPtosVenta", ["PtoVenta"]).catch((e: unknown) => {
    if (/602/.test(String((e as Error)?.message))) return [] as ParamRow[];
    throw e;
  });

export const getTiposCbte = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetTiposCbte", ["CbteTipo"]);

export const getTiposDoc = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetTiposDoc", ["DocTipo"]);

export const getTiposConcepto = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetTiposConcepto", ["ConceptoTipo"]);

export const getTiposIva = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetTiposIva", ["IvaTipo"]);

export const getTiposTributos = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetTiposTributos", ["TributoTipo"]);

export const getTiposMonedas = (ctx: ParamsContext) =>
  cachedList(ctx, "FEParamGetTiposMonedas", ["Moneda"]);

/** Cotizacion oficial de una moneda segun ARCA. */
export const getCotizacion = async (ctx: ParamsContext, monId: string): Promise<number> => {
  const r = await ctx.client.call("FEParamGetCotizacion", `<ar:MonId>${monId}</ar:MonId>`);
  WsfeClient.throwOnErrors("FEParamGetCotizacion", r);
  return Number(r?.ResultGet?.MonCotiz);
};

/** Condiciones de IVA del receptor por clase de comprobante (RG 5616). */
export const getCondicionIvaReceptor = (ctx: ParamsContext, claseCmp: "A" | "B" | "C") =>
  cachedList(
    ctx,
    "FEParamGetCondicionIvaReceptor",
    ["CondicionIvaReceptor"],
    claseCmp,
    `<ar:ClaseCmp>${claseCmp}</ar:ClaseCmp>`,
  );

/** Filtra los puntos de venta usables: no bloqueados y sin fecha de baja. */
export function usablePtosVenta(rows: ParamRow[]): ParamRow[] {
  return rows.filter(
    (p) =>
      String(p.Bloqueado).toUpperCase() !== "S" && (!p.FchBaja || p.FchBaja === "NULL"),
  );
}

/** Borra el cache de parametros de un ambiente. */
export function invalidateParamCache(cache: ParamCache, environment?: ArcaEnvironment) {
  return cache.clear(environment ? `${environment}:` : undefined);
}
