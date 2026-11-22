/**
 * arca-wsfe — cliente de facturacion electronica de ARCA (ex AFIP) para Node.
 *
 * Punto de entrada recomendado: la clase `ArcaClient`.
 *
 * ```ts
 * import { ArcaClient, CBTE_TIPOS, DOC_TIPOS } from "arca-wsfe";
 *
 * const arca = new ArcaClient({
 *   environment: "HOMOLOGACION",
 *   cuit: "20123456789",
 *   certificate: { id: "mi-cert", certPem, keyPem },
 *   ptoVta: 1,
 * });
 *
 * const r = await arca.issue({
 *   cbteTipo: CBTE_TIPOS.FACTURA_C,
 *   concept: 1,
 *   docType: DOC_TIPOS.CONSUMIDOR_FINAL,
 *   docNumber: "0",
 *   netAmount: "1000.00",
 *   totalAmount: "1000.00",
 *   externalId: "venta-123",
 * });
 * ```
 */

// API de alto nivel
export { ArcaClient } from "./arca.js";
export type { ArcaClientConfig, HealthReport } from "./arca.js";

// Emision
export { issueVoucher, reconcileAttempt } from "./issue.js";
export type { IssueContext, IssueInput, IssueResult, ArcaMessage } from "./issue.js";

// WSAA
export {
  CERT_EXPIRY_WARNING_DAYS,
  assertCertificateUsable,
  createTra,
  getTicket,
  signTraCms,
  WSFE_SERVICE,
} from "./wsaa.js";
export type { ArcaCertificate, GetTicketOptions, Ticket } from "./wsaa.js";

// WSFE
export { WsfeClient, consultVoucher, feDummy, lastAuthorized } from "./client.js";
export type { DummyStatus, WsfeClientOptions, WsfeErr } from "./client.js";

// Comprobantes
export {
  ALICUOTAS_IVA,
  CBTE_TIPOS,
  CLASE_A,
  CLASE_B,
  CLASE_C,
  CONCEPTO,
  NOTAS,
  NOTAS_CREDITO,
  buildVoucher,
  cbteClase,
  cbteLabel,
  draftToXml,
  ivaFromNet,
  notaCreditoPara,
  notaDebitoPara,
  validateDraft,
} from "./voucher.js";
export type {
  AssocVoucher,
  BuildVoucherInput,
  Concepto,
  IvaItem,
  TributoItem,
  VoucherDraft,
} from "./voucher.js";

// Parametros
export {
  DEFAULT_PARAM_TTL_MS,
  getCondicionIvaReceptor,
  getCotizacion,
  getPtosVenta,
  getTiposCbte,
  getTiposConcepto,
  getTiposDoc,
  getTiposIva,
  getTiposMonedas,
  getTiposTributos,
  invalidateParamCache,
  usablePtosVenta,
} from "./params.js";
export type { ParamRow, ParamsContext } from "./params.js";

// Certificados
export { generateKeyAndCsr, inspectCertificate } from "./csr.js";
export type { CertInfo, GenerateCsrOptions, KeyAndCsr } from "./csr.js";

// QR fiscal
export { QR_BASE_URL, buildQrPayload, qrDataUrl, qrPngBuffer, qrUrl } from "./qr.js";
export type { BuildQrInput, QrPayload } from "./qr.js";

// Errores
export { ArcaError, humanArcaMessage } from "./errors.js";
export type { ArcaErrorKind } from "./errors.js";

// Endpoints y ambientes
export { ENDPOINTS, assertEnvironmentAllowed } from "./endpoints.js";
export type { ArcaEnvironment, EnvironmentEndpoints } from "./endpoints.js";

// Utilidades
export { COND_IVA_RECEPTOR, DOC_TIPOS, formatCuit, isValidCuit, normalizeCuit } from "./cuit.js";
export { D, Decimal, ZERO, money, round2, sumMoney } from "./money.js";
export type { MoneyInput } from "./money.js";
export {
  arcaDateToDate,
  diffArcaDays,
  fromArcaDate,
  isoArgentina,
  toArcaDate,
  todayArcaDate,
  todayArg,
} from "./dates.js";
export { consoleLogger, noopLogger, redactXml } from "./logger.js";
export type { LogLevel, Logger } from "./logger.js";

// Adapters
export { memoryAdapters } from "./adapters/memory.js";
export type {
  ArcaAdapters,
  AttemptStatus,
  AttemptStore,
  CachedParams,
  IssueAttempt,
  Lock,
  NewIssueAttempt,
  ParamCache,
  StoredTicket,
  TicketStore,
} from "./adapters/types.js";

export type { AuthorizedVoucher } from "./issue.js";
