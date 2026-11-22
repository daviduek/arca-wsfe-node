/** Ambiente de ARCA. Homologacion es el entorno de pruebas. */
export type ArcaEnvironment = "HOMOLOGACION" | "PRODUCCION";

export interface EnvironmentEndpoints {
  wsaa: string;
  wsfe: string;
}

export const ENDPOINTS: Record<ArcaEnvironment, EnvironmentEndpoints> = {
  HOMOLOGACION: {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  },
  PRODUCCION: {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
  },
};

/**
 * Guardia anti-produccion.
 *
 * En produccion cada comprobante autorizado es un hecho fiscal real e
 * irreversible (una factura se anula con una nota de credito, no se borra).
 * Por eso PRODUCCION esta bloqueado salvo que se habilite explicitamente:
 * pasando `allowProduction: true` al crear el cliente, o seteando la variable
 * de entorno ARCA_ALLOW_PRODUCTION=1 unicamente en el entorno productivo.
 *
 * No habilites produccion en desarrollo ni en tests.
 */
export function assertEnvironmentAllowed(
  env: ArcaEnvironment,
  allowProduction?: boolean,
): void {
  if (env !== "PRODUCCION") return;
  const allowed = allowProduction ?? process.env.ARCA_ALLOW_PRODUCTION === "1";
  if (!allowed) {
    throw new Error(
      "ARCA PRODUCCION esta bloqueado en este entorno. Para habilitarlo pasá " +
        "allowProduction: true al cliente o seteá ARCA_ALLOW_PRODUCTION=1.",
    );
  }
}
