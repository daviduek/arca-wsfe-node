/**
 * WSAA: autenticacion contra ARCA.
 *
 * El flujo es: se arma un LoginTicketRequest (TRA), se lo firma como CMS con el
 * certificado y su clave privada, y se lo manda a `loginCms`. ARCA devuelve un
 * Ticket de Acceso (token + sign) valido por 12 horas, que despues viaja en el
 * header Auth de cada llamada a WSFE.
 *
 * Dos cosas que importan en produccion:
 *
 * 1. ARCA rechaza un nuevo login mientras el TA anterior siga vigente
 *    (`coe.alreadyAuthenticated`). El TA se cachea y se comparte entre
 *    instancias: eso es el `TicketStore`.
 * 2. `loginCms` no se reintenta: se llama una sola vez, bajo lock.
 */
import forge from "node-forge";
import { ArcaError } from "./errors.js";
import { ENDPOINTS, assertEnvironmentAllowed, type ArcaEnvironment } from "./endpoints.js";
import { isoArgentina } from "./dates.js";
import { soapPost } from "./http.js";
import { parseSoapBody, parser } from "./xml.js";
import { noopLogger, type Logger } from "./logger.js";
import { inspectCertificate, type CertInfo } from "./csr.js";
import type { Lock, StoredTicket, TicketStore } from "./adapters/types.js";

/** Certificado de ARCA con su clave privada. Material sensible. */
export interface ArcaCertificate {
  /**
   * Identificador estable de este certificado en tu sistema. Se usa como clave
   * del cache del Ticket de Acceso: dos certificados distintos no pueden
   * compartir id.
   */
  id: string;
  /** Certificado emitido por ARCA, en PEM. */
  certPem: string;
  /** Clave privada que genero el CSR, en PEM. NUNCA la loguees ni la commitees. */
  keyPem: string;
}

export interface Ticket {
  token: string;
  sign: string;
  expirationTime: string;
  /** De donde salio: del cache o de un login nuevo contra WSAA. */
  source: "cache" | "wsaa";
}

/** Se renueva el TA si le quedan menos de 10 minutos de vida. */
const SAFETY_MS = 10 * 60 * 1000;

/** Servicio de facturacion electronica. Es el unico que usa esta libreria. */
export const WSFE_SERVICE = "wsfe";

/**
 * Arma el LoginTicketRequest. La ventana es de +/- 10 minutos alrededor de
 * ahora: si el reloj del servidor esta corrido mas que eso, ARCA rechaza el
 * TRA. Si ves fallas intermitentes de autenticacion, revisá el NTP.
 */
export function createTra(service: string = WSFE_SERVICE, now: Date = new Date()): string {
  const gen = new Date(now.getTime() - 10 * 60 * 1000);
  const exp = new Date(now.getTime() + 10 * 60 * 1000);
  const uniqueId = Math.floor(now.getTime() / 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${isoArgentina(gen)}</generationTime>
    <expirationTime>${isoArgentina(exp)}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

/** Firma el TRA como CMS/PKCS#7 SignedData con SHA-256 y lo devuelve en Base64 (DER). */
export function signTraCms(tra: string, certPem: string, keyPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key: key as forge.pki.rsa.PrivateKey,
    certificate: cert,
    // La tabla de OIDs de node-forge esta tipada como indice abierto; estos
    // cuatro existen siempre.
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

function fresh(t: StoredTicket | null): Ticket | null {
  if (!t) return null;
  if (t.expirationTime.getTime() - Date.now() < SAFETY_MS) return null;
  return {
    token: t.token,
    sign: t.sign,
    expirationTime: t.expirationTime.toISOString(),
    source: "cache",
  };
}

/** Dias antes del vencimiento a partir de los cuales se avisa por el logger. */
export const CERT_EXPIRY_WARNING_DAYS = 30;

/**
 * Valida que el certificado sirva para autenticarse: que la clave privada le
 * corresponda y que no este vencido. Avisa por el logger si esta por vencer.
 *
 * Un certificado vencido corta la emision de golpe, y el error que devuelve
 * ARCA no menciona el vencimiento, asi que conviene detectarlo de este lado.
 * Se llama en cada renovacion del Ticket de Acceso, y se puede usar en un
 * health check.
 */
export function assertCertificateUsable(
  certificate: ArcaCertificate,
  logger: Logger = noopLogger,
): CertInfo {
  const info = inspectCertificate(certificate.certPem, certificate.keyPem);
  const vence = info.notAfter.toISOString().slice(0, 10);

  if (info.daysToExpiry < 0) {
    throw new ArcaError(
      "WSAA_AUTH",
      `El certificado de ARCA vencio hace ${Math.abs(info.daysToExpiry)} dias (${vence}). Hay que renovarlo en ARCA.`,
      { certificateId: certificate.id, notAfter: vence },
    );
  }
  if (info.daysToExpiry < CERT_EXPIRY_WARNING_DAYS) {
    logger("warn", "El certificado de ARCA esta por vencer", {
      certificateId: certificate.id,
      daysToExpiry: info.daysToExpiry,
      notAfter: vence,
    });
  }
  return info;
}

export interface GetTicketOptions {
  certificate: ArcaCertificate;
  environment: ArcaEnvironment;
  tickets: TicketStore;
  lock: Lock;
  service?: string;
  logger?: Logger;
  allowProduction?: boolean;
}

/**
 * Devuelve un Ticket de Acceso vigente: del cache si sirve, si no hace login.
 * El login corre bajo lock para que dos procesos no pidan un TA a la vez.
 */
export async function getTicket(o: GetTicketOptions): Promise<Ticket> {
  assertEnvironmentAllowed(o.environment, o.allowProduction);
  const log = o.logger ?? noopLogger;
  const service = o.service ?? WSFE_SERVICE;
  const key = `${o.certificate.id}:${o.environment}:${service}`;

  const cached = fresh(await o.tickets.get(key));
  if (cached) return cached;

  return o.lock(`wsaa:${key}`, async () => {
    // Revalidar dentro del lock: otro proceso pudo renovarlo mientras esperabamos.
    const again = fresh(await o.tickets.get(key));
    if (again) return again;

    // Se valida al renovar el TA (dos veces por dia), no en cada request.
    assertCertificateUsable(o.certificate, log);

    const tra = createTra(service);
    const cms = signTraCms(tra, o.certificate.certPem, o.certificate.keyPem);
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

    const xml = await soapPost({
      url: ENDPOINTS[o.environment].wsaa,
      soapAction: "",
      body: envelope,
      retries: 0, // loginCms no se reintenta
      label: "WSAA.loginCms",
      logger: log,
    });

    const body = parseSoapBody(xml, "WSAA_AUTH");
    const ret = body?.loginCmsResponse?.loginCmsReturn;
    if (!ret) throw new ArcaError("WSAA_AUTH", "loginCmsReturn vacio", body);

    const ta = parser.parse(ret)?.loginTicketResponse;
    const token = ta?.credentials?.token;
    const sign = ta?.credentials?.sign;
    const expirationTime = ta?.header?.expirationTime;
    if (!token || !sign || !expirationTime) {
      throw new ArcaError("WSAA_AUTH", "El Ticket de Acceso vino sin token, sign o vencimiento");
    }

    await o.tickets.set(key, {
      token,
      sign,
      generationTime: new Date(ta?.header?.generationTime ?? Date.now()),
      expirationTime: new Date(expirationTime),
    });

    log("info", "WSAA: Ticket de Acceso renovado", {
      certificateId: o.certificate.id,
      environment: o.environment,
      expirationTime,
    });

    return { token, sign, expirationTime, source: "wsaa" as const };
  });
}
