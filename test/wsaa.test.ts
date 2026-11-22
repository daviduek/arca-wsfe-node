import { describe, expect, it } from "vitest";
import forge from "node-forge";
import { createTra, signTraCms } from "../src/wsaa.js";
import { generateKeyAndCsr, inspectCertificate } from "../src/csr.js";

/** Certificado autofirmado para probar la firma sin pegarle a ARCA. */
function selfSigned(cuit = "20111111112") {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: "Test" },
    { name: "commonName", value: "test-cert" },
    { name: "serialNumber", value: `CUIT ${cuit}` },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe("TRA", () => {
  it("usa una ventana de +/- 10 minutos con offset de Argentina", () => {
    const now = new Date("2026-11-21T15:00:00Z");
    const tra = createTra("wsfe", now);
    expect(tra).toContain("<service>wsfe</service>");
    expect(tra).toContain("<generationTime>2026-11-21T11:50:00-03:00</generationTime>");
    expect(tra).toContain("<expirationTime>2026-11-21T12:10:00-03:00</expirationTime>");
    expect(tra).toContain(`<uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>`);
  });

  it("cambia el uniqueId entre pedidos", () => {
    const a = createTra("wsfe", new Date("2026-11-21T15:00:00Z"));
    const b = createTra("wsfe", new Date("2026-11-21T15:00:05Z"));
    expect(a).not.toBe(b);
  });
});

describe("firma CMS", () => {
  it("produce un PKCS#7 SignedData en base64 que contiene el TRA", () => {
    const { certPem, keyPem } = selfSigned();
    const tra = createTra("wsfe");
    const cms = signTraCms(tra, certPem, keyPem);

    expect(cms).toMatch(/^[A-Za-z0-9+/=]+$/);

    const der = forge.util.decode64(cms);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as any;
    expect(p7.type).toBe(forge.pki.oids.signedData);
    // El contenido firmado es el TRA tal cual.
    const content = p7.rawCapture.content.value[0].value;
    expect(content).toContain("<loginTicketRequest");
    expect(content).toContain("<service>wsfe</service>");
  });

  it("node-forge NO valida que la clave corresponda al certificado: hay que chequearlo antes", () => {
    const a = selfSigned();
    const b = selfSigned("30111111118");

    // La firma se produce igual, con un par que no corresponde. ARCA la
    // rechazaria con un error poco claro, asi que el chequeo se hace antes,
    // al cargar el certificado.
    expect(() => signTraCms(createTra(), a.certPem, b.keyPem)).not.toThrow();
    expect(() => inspectCertificate(a.certPem, b.keyPem)).toThrow(/no corresponde/);
  });
});

describe("CSR y certificado", () => {
  it("genera el CSR con el DN que pide ARCA", () => {
    const { keyPem, csrPem } = generateKeyAndCsr({
      cuit: "20111111112",
      alias: "mi-sistema",
      org: "Mi Empresa SRL",
    });
    expect(keyPem).toContain("PRIVATE KEY");
    expect(csrPem).toContain("CERTIFICATE REQUEST");

    const csr = forge.pki.certificationRequestFromPem(csrPem);
    const sn = csr.subject.attributes.find((a) => a.shortName === "serialNumber" || a.name === "serialNumber");
    expect(String(sn?.value)).toBe("CUIT 20111111112");
    expect(csr.verify()).toBe(true);
  });

  it("inspecciona el certificado y detecta el par incorrecto", () => {
    const { certPem, keyPem } = selfSigned();
    const info = inspectCertificate(certPem, keyPem);
    expect(info.cuitInSubject).toBe("20111111112");
    expect(info.daysToExpiry).toBeGreaterThan(300);

    const otro = selfSigned("30111111118");
    expect(() => inspectCertificate(certPem, otro.keyPem)).toThrow(/no corresponde/);
  });
});
