export type LogLevel = "debug" | "info" | "warn" | "error";

/** Logger inyectable. Por defecto la libreria no escribe nada. */
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

export const noopLogger: Logger = () => {};

/** Logger simple a consola, util en desarrollo y en los ejemplos. */
export const consoleLogger: Logger = (level, message, meta) => {
  const line = `[arca-wsfe] ${level.toUpperCase()} ${message}`;
  if (meta && Object.keys(meta).length) console[level === "debug" ? "log" : level](line, meta);
  else console[level === "debug" ? "log" : level](line);
};

/**
 * Enmascara material sensible antes de loguear o persistir XML.
 *
 * El Token y el Sign del Ticket de Acceso son credenciales validas por 12
 * horas: con esos dos valores cualquiera puede emitir comprobantes en nombre
 * del CUIT. Nunca los dejes en un log, un dump de XML ni una tabla de
 * auditoria sin enmascarar.
 */
export function redactXml(xml: string): string {
  return xml
    .replace(/(<(?:\w+:)?Token>)[\s\S]*?(<\/(?:\w+:)?Token>)/g, "$1[REDACTED]$2")
    .replace(/(<(?:\w+:)?Sign>)[\s\S]*?(<\/(?:\w+:)?Sign>)/g, "$1[REDACTED]$2")
    .replace(/(<(?:\w+:)?in0>)[\s\S]*?(<\/(?:\w+:)?in0>)/g, "$1[REDACTED]$2");
}
