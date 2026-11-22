/**
 * Ejemplo de punta a punta en HOMOLOGACION (el entorno de pruebas de ARCA).
 *
 * Paso 1 — generar la clave y el pedido de certificado:
 *
 *   npx tsx examples/homologacion.ts csr --cuit 20123456789 --org "Mi Empresa"
 *
 *   Deja ./arca-homo.key y ./arca-homo.csr. Subí el .csr en ARCA
 *   ("Certificados Homologacion"), descargá el certificado como
 *   ./arca-homo.crt y dale permiso al servicio wsfe en el Administrador de
 *   Relaciones. Despues creá un punto de venta de tipo Web Services.
 *
 * Paso 2 — revisar la conexion:
 *
 *   npx tsx examples/homologacion.ts health --cuit 20123456789
 *
 * Paso 3 — emitir una factura C de prueba:
 *
 *   npx tsx examples/homologacion.ts factura --cuit 20123456789 --pv 1 --total 1000
 *
 * Paso 4 — anularla con una nota de credito:
 *
 *   npx tsx examples/homologacion.ts nc --cuit 20123456789 --pv 1 --nro 1 --total 1000
 *
 * Este ejemplo NUNCA toca produccion: el ambiente esta fijo en HOMOLOGACION.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  ArcaClient,
  CBTE_TIPOS,
  DOC_TIPOS,
  consoleLogger,
  generateKeyAndCsr,
  humanArcaMessage,
} from "../src/index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "health";

function flag(name: string, fallback?: string): string {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Falta --${name}`);
  }
  return v;
}

const KEY = "./arca-homo.key";
const CSR = "./arca-homo.csr";
const CRT = "./arca-homo.crt";

function client(): ArcaClient {
  const cuit = flag("cuit");
  return new ArcaClient({
    environment: "HOMOLOGACION",
    cuit,
    certificate: {
      id: `homo-${cuit}`,
      certPem: readFileSync(CRT, "utf8"),
      keyPem: readFileSync(KEY, "utf8"),
    },
    ptoVta: Number(flag("pv", "1")),
    logger: consoleLogger,
    // Sin `adapters`, la libreria usa los de memoria: alcanza para un script.
  });
}

async function main() {
  switch (command) {
    case "csr": {
      const { keyPem, csrPem } = generateKeyAndCsr({
        cuit: flag("cuit"),
        alias: flag("alias", "arca-wsfe-homo"),
        org: flag("org", "Mi Empresa"),
      });
      writeFileSync(KEY, keyPem, { mode: 0o600 });
      writeFileSync(CSR, csrPem);
      console.log(`Clave privada: ${KEY}  <-- guardala, no se puede recuperar`);
      console.log(`CSR:           ${CSR}  <-- subilo en ARCA`);
      return;
    }

    case "health": {
      const report = await client().health();
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) {
        console.error("\nProblemas:");
        for (const p of report.problems) console.error(` - ${p}`);
        process.exitCode = 1;
      }
      return;
    }

    case "factura": {
      const total = flag("total", "1000.00");
      const r = await client().issue({
        cbteTipo: CBTE_TIPOS.FACTURA_C,
        concept: 1, // productos
        docType: DOC_TIPOS.CONSUMIDOR_FINAL,
        docNumber: "0",
        netAmount: total,
        totalAmount: total,
        externalId: `ejemplo-${Date.now()}`,
      });
      console.log(JSON.stringify({ ...r, requestXml: undefined }, null, 2));
      if (r.status === "AUTORIZADA") {
        console.log(`\nCAE ${r.cae} — comprobante ${r.ptoVta}-${r.cbteNro}`);
        console.log(`QR: ${r.qr?.url}`);
      }
      return;
    }

    case "nc": {
      const total = flag("total", "1000.00");
      const r = await client().creditNote({
        original: {
          cbteTipo: CBTE_TIPOS.FACTURA_C,
          ptoVta: Number(flag("pv", "1")),
          cbteNro: Number(flag("nro")),
        },
        amounts: {
          docType: DOC_TIPOS.CONSUMIDOR_FINAL,
          docNumber: "0",
          netAmount: total,
          totalAmount: total,
        },
        externalId: `nc-ejemplo-${Date.now()}`,
      });
      console.log(JSON.stringify({ ...r, requestXml: undefined }, null, 2));
      return;
    }

    default:
      console.error(`Comando desconocido: ${command}`);
      console.error("Usá: csr | health | factura | nc");
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n${humanArcaMessage(e)}\n`);
  console.error(e);
  process.exitCode = 1;
});
