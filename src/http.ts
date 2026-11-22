import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { ArcaError } from "./errors.js";
import { noopLogger, type Logger } from "./logger.js";

/**
 * El endpoint de produccion de WSFE (servicios1.afip.gov.ar) negocia un grupo
 * Diffie-Hellman que OpenSSL 3 rechaza por chico: la conexion muere con
 * ERR_SSL_DH_KEY_TOO_SMALL.
 *
 * Ante ese error exacto bajamos a SECLEVEL=1 y reintentamos. El downgrade
 * aplica SOLO a las conexiones que hace esta libreria (su propio dispatcher de
 * undici), nunca al resto del proceso, y se recuerda para no pagar el primer
 * fallo en cada request. Se puede forzar desde el arranque con
 * ARCA_TLS_LEGACY=1.
 */
const LEGACY_CIPHERS = { ciphers: "DEFAULT@SECLEVEL=1" };

let legacyTls = process.env.ARCA_TLS_LEGACY === "1";
const dispatchers = new Map<string, Dispatcher>();

function getDispatcher(): Dispatcher {
  const key = legacyTls ? "legacy" : "default";
  const cached = dispatchers.get(key);
  if (cached) return cached;
  const connect = legacyTls ? LEGACY_CIPHERS : {};
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const d = proxy ? new ProxyAgent({ uri: proxy, requestTls: connect }) : new Agent({ connect });
  dispatchers.set(key, d);
  return d;
}

function isWeakDhError(e: unknown): boolean {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const s = `${err?.message ?? ""} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`;
  return /DH_KEY_TOO_SMALL|dh key too small|SSL routines/i.test(s);
}

export interface SoapCallOpts {
  url: string;
  soapAction: string;
  body: string;
  timeoutMs?: number;
  /**
   * Cantidad de reintentos. SOLO para operaciones idempotentes (consultas).
   * FECAESolicitar va siempre con 0: un reintento a ciegas puede autorizar dos
   * comprobantes para la misma venta.
   */
  retries?: number;
  label: string;
  logger?: Logger;
}

export async function soapPost(o: SoapCallOpts): Promise<string> {
  const log = o.logger ?? noopLogger;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const retries = o.retries ?? 0;
  let attempt = 0;

  for (;;) {
    attempt++;
    const t0 = Date.now();
    try {
      const res = await undiciFetch(o.url, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${o.soapAction}"`,
        },
        body: o.body,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getDispatcher(),
      });
      const text = await res.text();
      log("debug", "respuesta SOAP", { label: o.label, status: res.status, ms: Date.now() - t0 });
      // Los SOAP Fault llegan con HTTP 500: se devuelven para que el parser los clasifique.
      if (res.status !== 200 && !/Fault>/.test(text)) {
        throw new ArcaError("TRANSPORT", `HTTP ${res.status} en ${o.label}`, text.slice(0, 500));
      }
      return text;
    } catch (e: unknown) {
      const err = e as { message?: string; name?: string; cause?: { code?: string; message?: string } };
      const isTransport = !(e instanceof ArcaError) || e.kind === "TRANSPORT";
      const cause = err?.cause?.code ?? err?.cause?.message ?? err?.name;
      log("warn", "falla en llamada SOAP", {
        label: o.label,
        attempt,
        error: String(err?.message ?? e),
        cause,
      });

      if (!legacyTls && isWeakDhError(e)) {
        log("warn", "TLS legacy activado para ARCA (DH key too small)", { label: o.label });
        legacyTls = true;
        continue; // misma operacion: el handshake fallo, ARCA no recibio nada
      }
      if (isTransport && attempt <= retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      if (e instanceof ArcaError) throw e;
      throw new ArcaError(
        "TRANSPORT",
        `${o.label}: ${err?.message ?? e} (${cause ?? "sin causa"})`,
      );
    }
  }
}
