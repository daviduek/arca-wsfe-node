/**
 * Generacion de la clave privada y el pedido de certificado (CSR) para ARCA.
 *
 * Como se usa:
 *
 * 1. `generateKeyAndCsr()` devuelve la clave privada y el CSR.
 * 2. Guardá la clave privada en un lugar seguro (cifrada). No vuelve a salir
 *    de tu sistema y no se puede recuperar: si la perdes hay que empezar de
 *    nuevo.
 * 3. Subí el CSR en ARCA (en homologacion con "Certificados Homologacion"; en
 *    produccion con "Administracion de Certificados Digitales") y descargá el
 *    certificado.
 * 4. En ARCA, asociá el certificado al servicio de facturacion electronica
 *    (`wsfe`) en "Administrador de Relaciones".
 * 5. `inspectCertificate()` verifica que el certificado corresponda a la clave
 *    y muestra el CUIT y las fechas de validez.
 */
import forge from "node-forge";

export interface GenerateCsrOptions {
  /** CUIT sin guiones, 11 digitos. Va en el DN como `serialNumber`. */
  cuit: string;
  /** Alias del certificado; va como Common Name. Ej: "mi-sistema-prod". */
  alias: string;
  /** Razon social u organizacion. */
  org: string;
  /** Tamaño de la clave RSA. ARCA acepta 2048. */
  keySize?: number;
}

export interface KeyAndCsr {
  keyPem: string;
  csrPem: string;
}

/** Genera una clave RSA nueva y el CSR con el DN que pide ARCA. */
export function generateKeyAndCsr(opts: GenerateCsrOptions): KeyAndCsr {
  const keys = forge.pki.rsa.generateKeyPair(opts.keySize ?? 2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: opts.org },
    { name: "commonName", value: opts.alias },
    { name: "serialNumber", value: `CUIT ${opts.cuit}` },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr),
  };
}

export interface CertInfo {
  subject: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  /** CUIT leido del `serialNumber` del subject, si esta. */
  cuitInSubject: string | null;
  /** Dias hasta el vencimiento (negativo si ya vencio). */
  daysToExpiry: number;
}

/**
 * Valida el certificado y que corresponda a la clave privada.
 * Los certificados de ARCA vencen (2 años en produccion): conviene chequear
 * `daysToExpiry` en un health check y avisar antes de que se caiga la emision.
 */
export function inspectCertificate(certPem: string, keyPem: string): CertInfo {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  const certPub = cert.publicKey as forge.pki.rsa.PublicKey;

  if (certPub.n.compareTo(key.n) !== 0) {
    throw new Error("El certificado no corresponde a esta clave privada.");
  }

  const subject = cert.subject.attributes
    .map((a) => `${a.shortName ?? a.name}=${a.value}`)
    .join(", ");
  const serialAttr = cert.subject.attributes.find(
    (a) => a.name === "serialNumber" || a.shortName === "serialNumber",
  );
  const cuitMatch = String(serialAttr?.value ?? "").match(/(\d{11})/);

  return {
    subject,
    serial: cert.serialNumber,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    cuitInSubject: cuitMatch ? cuitMatch[1]! : null,
    daysToExpiry: Math.floor((cert.validity.notAfter.getTime() - Date.now()) / 86_400_000),
  };
}
