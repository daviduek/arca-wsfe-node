import { describe, expect, it } from "vitest";
import { issueVoucher, type IssueContext } from "../src/issue.js";
import { ArcaError } from "../src/errors.js";
import { CBTE_TIPOS } from "../src/voucher.js";
import { MemoryAttemptStore, memoryAdapters } from "../src/adapters/memory.js";
import type { WsfeClient } from "../src/client.js";
import type { ArcaAdapters } from "../src/adapters/types.js";

/**
 * WSFE falso: permite fijar el ultimo numero autorizado, lo que contesta
 * FECAESolicitar y que comprobantes "existen" en ARCA.
 */
function fakeWsfe(opts: {
  /** Ultimo numero autorizado. Puede cambiar entre llamadas. */
  last?: number | (() => number);
  /** Respuesta de FECAESolicitar, o un error para simular un corte. */
  cae?: (xml: string) => any;
  /** Comprobantes que ARCA dice tener, por numero. */
  existing?: Record<number, { ImpTotal: string; CodAutorizacion: string; CbteFch: string }>;
  onConsult?: () => void;
}) {
  const calls: string[] = [];
  const client = {
    call(method: string, inner: string) {
      calls.push(method);
      switch (method) {
        case "FEParamGetCondicionIvaReceptor":
          return Promise.resolve({
            ResultGet: { CondicionIvaReceptor: [{ Id: "5", Desc: "Consumidor Final" }, { Id: "1" }] },
          });
        case "FECompUltimoAutorizado":
          return Promise.resolve({
            CbteNro: String(typeof opts.last === "function" ? opts.last() : (opts.last ?? 0)),
          });
        case "FECAESolicitar":
          if (!opts.cae) throw new Error("FECAESolicitar inesperado en este test");
          return Promise.resolve(opts.cae(inner));
        case "FECompConsultar": {
          opts.onConsult?.();
          const nro = Number(/<ar:CbteNro>(\d+)<\/ar:CbteNro>/.exec(inner)?.[1]);
          const found = opts.existing?.[nro];
          // ARCA devuelve el numero en CbteDesde, como el resto de las respuestas.
          return Promise.resolve({
            ResultGet: found ? { ...found, CbteDesde: String(nro) } : null,
          });
        }
        default:
          throw new Error(`metodo no simulado: ${method}`);
      }
    },
  };
  return { client: client as unknown as WsfeClient, calls };
}

function ctxFor(client: WsfeClient, adapters: ArcaAdapters = memoryAdapters()): IssueContext {
  return {
    environment: "HOMOLOGACION",
    cuit: "20111111112",
    client,
    adapters,
    ptoVta: 1,
  };
}

const facturaC = {
  cbteTipo: CBTE_TIPOS.FACTURA_C,
  concept: 1 as const,
  docType: 99,
  docNumber: "0",
  netAmount: "1000.00",
  totalAmount: "1000.00",
};

const caeOk = () => ({
  FeCabResp: { Resultado: "A" },
  FeDetResp: {
    FECAEDetResponse: {
      Resultado: "A",
      CAE: "12345678901234",
      CAEFchVto: "20261201",
      CbteDesde: "8",
      CbteFch: "20261121",
    },
  },
});

describe("issueVoucher", () => {
  it("emite y devuelve el CAE con el QR", async () => {
    const { client, calls } = fakeWsfe({ last: 7, cae: caeOk });
    const r = await issueVoucher(ctxFor(client), facturaC);

    expect(r.status).toBe("AUTORIZADA");
    expect(r.cae).toBe("12345678901234");
    expect(r.cbteNro).toBe(8);
    expect(r.qr?.url).toContain("arca.gob.ar/fe/qr");
    expect(r.reconciled).toBeUndefined();
    // Numero pedido a ARCA, no contado localmente.
    expect(calls).toContain("FECompUltimoAutorizado");
  });

  it("numera con el ultimo autorizado + 1", async () => {
    let enviado = "";
    const { client } = fakeWsfe({
      last: 41,
      cae: (xml) => {
        enviado = xml;
        return {
          FeDetResp: {
            FECAEDetResponse: {
              Resultado: "A",
              CAE: "12345678901234",
              CbteDesde: "42",
              CbteFch: "20261121",
            },
          },
        };
      },
    });
    const r = await issueVoucher(ctxFor(client), facturaC);
    expect(enviado).toContain("<ar:CbteDesde>42</ar:CbteDesde>");
    expect(r.cbteNro).toBe(42);
  });

  it("devuelve RECHAZADA sin lanzar, con el detalle de ARCA", async () => {
    const { client } = fakeWsfe({
      last: 7,
      cae: () => ({
        FeCabResp: { Resultado: "R" },
        FeDetResp: { FECAEDetResponse: { Resultado: "R" } },
        Errors: { Err: { Code: "10015", Msg: "Punto de venta no autorizado" } },
      }),
    });
    const r = await issueVoucher(ctxFor(client), facturaC);
    expect(r.status).toBe("RECHAZADA");
    expect(r.errors?.[0]?.Code).toBe("10015");
    expect(r.cae).toBeUndefined();
  });

  it("lanza antes de llamar a ARCA si la validacion local falla", async () => {
    const { client, calls } = fakeWsfe({ last: 7 });
    await expect(
      issueVoucher(ctxFor(client), { ...facturaC, totalAmount: "1500.00" }),
    ).rejects.toThrow(/ImpTotal/);
    expect(calls).not.toContain("FECAESolicitar");
  });

  it("no reintenta FECAESolicitar y concilia cuando ARCA ya lo habia autorizado", async () => {
    let intentos = 0;
    let ultimo = 7;

    const { client } = fakeWsfe({
      // Antes de emitir el ultimo autorizado es 7; despues del corte ARCA ya
      // tiene el 8, porque la autorizacion entro y se perdio la respuesta.
      last: () => ultimo,
      cae: () => {
        intentos++;
        ultimo = 8;
        throw new ArcaError("TRANSPORT", "socket hang up");
      },
      existing: {
        8: { ImpTotal: "1000.00", CodAutorizacion: "12345678901234", CbteFch: "20261121" },
      },
    });

    const r = await issueVoucher(ctxFor(client), facturaC);
    expect(intentos).toBe(1); // una sola llamada: nunca se reintenta
    expect(r.status).toBe("AUTORIZADA");
    expect(r.reconciled).toBe(true);
    expect(r.cae).toBe("12345678901234");
    expect(r.cbteNro).toBe(8);
  });

  it("queda en CONCILIANDO cuando no se puede confirmar", async () => {
    const adapters = memoryAdapters();
    const { client } = fakeWsfe({
      last: 7,
      cae: () => {
        throw new ArcaError("TRANSPORT", "timeout");
      },
      onConsult: () => {
        throw new ArcaError("TRANSPORT", "timeout en la consulta");
      },
    });

    const r = await issueVoucher(ctxFor(client, adapters), { ...facturaC, externalId: "venta-1" });
    expect(r.status).toBe("CONCILIANDO");
    expect(r.cae).toBeUndefined();

    const attempt = (adapters.attempts as MemoryAttemptStore).all()[0]!;
    expect(attempt.status).toBe("AMBIGUO");
    expect(attempt.externalId).toBe("venta-1");
  });

  it("no reemite la misma venta: con el mismo externalId devuelve el comprobante ya emitido", async () => {
    const adapters = memoryAdapters();

    // 1er intento: se corta y tampoco se puede consultar.
    const primero = fakeWsfe({
      last: 7,
      cae: () => {
        throw new ArcaError("TRANSPORT", "timeout");
      },
      onConsult: () => {
        throw new ArcaError("TRANSPORT", "timeout");
      },
    });
    const r1 = await issueVoucher(ctxFor(primero.client, adapters), {
      ...facturaC,
      externalId: "venta-7",
    });
    expect(r1.status).toBe("CONCILIANDO");

    // 2do intento: ARCA ya responde y el comprobante 8 existe con el mismo importe.
    const segundo = fakeWsfe({
      last: 8,
      existing: {
        8: { ImpTotal: "1000.00", CodAutorizacion: "12345678901234", CbteFch: "20261121" },
      },
      // Si se llamara, el test falla: no debe reemitir.
    });
    const r2 = await issueVoucher(ctxFor(segundo.client, adapters), {
      ...facturaC,
      externalId: "venta-7",
    });

    expect(r2.status).toBe("AUTORIZADA");
    expect(r2.reconciled).toBe(true);
    expect(r2.cae).toBe("12345678901234");
    expect(r2.cbteNro).toBe(8);
    expect(segundo.calls).not.toContain("FECAESolicitar");
  });

  it("marca AMBIGUOUS_RESULT si el numero existe en ARCA con otro importe", async () => {
    const { client } = fakeWsfe({
      last: 8,
      cae: () => {
        throw new ArcaError("TRANSPORT", "timeout");
      },
      existing: { 8: { ImpTotal: "999.00", CodAutorizacion: "111", CbteFch: "20261121" } },
    });
    // La conciliacion detecta el desvio y deja el intento sin resolver.
    const r = await issueVoucher(ctxFor(client), facturaC);
    expect(r.status).toBe("CONCILIANDO");
  });

  it("rechaza una condicion de IVA que ARCA no acepta para esa clase", async () => {
    const { client } = fakeWsfe({ last: 7, cae: caeOk });
    await expect(
      issueVoucher(ctxFor(client), { ...facturaC, condIvaReceptorId: 77 }),
    ).rejects.toThrow(/Condicion de IVA/);
  });

  it("serializa las emisiones concurrentes de la misma serie", async () => {
    const adapters = memoryAdapters();
    let concurrentes = 0;
    let max = 0;
    let numero = 7;

    const client = {
      async call(method: string, inner: string) {
        if (method === "FEParamGetCondicionIvaReceptor") {
          return { ResultGet: { CondicionIvaReceptor: [{ Id: "5" }] } };
        }
        if (method === "FECompUltimoAutorizado") return { CbteNro: String(numero) };
        if (method === "FECAESolicitar") {
          max = Math.max(max, ++concurrentes);
          await new Promise((r) => setTimeout(r, 10));
          concurrentes--;
          numero++;
          return {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "12345678901234",
                CbteDesde: String(numero),
                CbteFch: "20261121",
              },
            },
          };
        }
        if (method === "FECompConsultar") return { ResultGet: null };
        throw new Error(method);
      },
    } as unknown as WsfeClient;

    const ctx = ctxFor(client, adapters);
    const results = await Promise.all([
      issueVoucher(ctx, { ...facturaC, externalId: "a" }),
      issueVoucher(ctx, { ...facturaC, externalId: "b" }),
      issueVoucher(ctx, { ...facturaC, externalId: "c" }),
    ]);

    expect(max).toBe(1);
    expect(results.every((r) => r.status === "AUTORIZADA")).toBe(true);
    expect(new Set(results.map((r) => r.cbteNro)).size).toBe(3);
  });

  it("bloquea PRODUCCION si no se habilito explicitamente", async () => {
    const { client } = fakeWsfe({ last: 7, cae: caeOk });
    await expect(
      issueVoucher({ ...ctxFor(client), environment: "PRODUCCION" }, facturaC),
    ).rejects.toThrow(/PRODUCCION esta bloqueado/);
  });
});
