# arca-wsfe

Cliente Node.js/TypeScript para la facturación electrónica de **ARCA** (ex AFIP): autenticación WSAA, emisión de comprobantes con CAE por WSFEv1, notas de crédito y débito, y el QR fiscal.

Está pensado para lo que suele salir mal en producción, no sólo para el camino feliz: el Ticket de Acceso se comparte entre instancias, la numeración se pide siempre a ARCA, y si `FECAESolicitar` se corta por timeout la librería **concilia contra ARCA en lugar de reintentar a ciegas** — que es la forma más común de terminar con dos comprobantes autorizados para la misma venta.

```bash
npm install arca-wsfe
```

Node >= 22.19 (lo exige `undici`, que es necesario para el ajuste de TLS del endpoint de producción). Sin dependencias de base de datos: la persistencia entra por interfaces.

---

## Qué hace y qué no

**Hace**

- WSAA: TRA, firma CMS, `loginCms`, cache del Ticket de Acceso.
- WSFEv1: `FECAESolicitar`, `FECompUltimoAutorizado`, `FECompConsultar`, `FEDummy` y las tablas de parámetros.
- Comprobantes A, B y C: facturas, notas de crédito y notas de débito (con comprobantes asociados).
- IVA discriminado por alícuota, tributos, moneda extranjera con cotización, conceptos productos / servicios / ambos.
- Condición de IVA del receptor (RG 5616), validada contra la tabla de ARCA.
- QR fiscal (RG 4892) como payload, URL, PNG o data URL.
- Generación del CSR para pedir el certificado, e inspección del certificado.
- Emisión idempotente, con registro de intentos y conciliación.

**No hace**

- **No genera el PDF del comprobante.** Devuelve todos los datos y el QR; el diseño del PDF queda de tu lado.
- **No automatiza el login con CUIT y clave fiscal.** El acceso es por certificado, que es el mecanismo que ARCA provee para esto.
- No implementa CAEA (comprobantes en lote por contingencia), ni FEX (exportación), ni el padrón de contribuyentes (el servicio público `sr-padron` está dado de baja).
- No es un ERP: no lleva cuentas corrientes ni stock.

---

## Preparar ARCA (una vez por CUIT)

1. **Generá la clave privada y el CSR.**

   ```ts
   import { generateKeyAndCsr } from "arca-wsfe";

   const { keyPem, csrPem } = generateKeyAndCsr({
     cuit: "20123456789",
     alias: "mi-sistema-prod",
     org: "Mi Empresa SRL",
   });
   ```

   La clave privada no vuelve a salir de tu sistema y **no se puede recuperar**: guardala cifrada. Si la perdés hay que empezar de nuevo.

2. **Subí el CSR en ARCA** y descargá el certificado.
   - Homologación: servicio *Certificados Homologación* (WSASS).
   - Producción: *Administración de Certificados Digitales*.

3. **Asociá el certificado al servicio `wsfe`** en *Administrador de Relaciones*. Sin esta relación, WSAA autentica pero WSFE devuelve error 600.

4. **Creá un punto de venta de tipo "Web Services"** en *Regímenes de Facturación y Registración (REAR/RECE/RFI)*. Los puntos de venta del portal web no sirven para web services: son numeraciones distintas.

5. Verificá todo junto:

   ```ts
   const report = await arca.health();
   // { ok, service, certificate: { daysToExpiry }, ticket, puntosDeVenta, problems: [] }
   ```

El certificado **vence** (dos años en producción). `health()` avisa 30 días antes; conviene monitorearlo, porque cuando vence se corta la emisión.

---

## Uso

```ts
import { ArcaClient, CBTE_TIPOS, DOC_TIPOS } from "arca-wsfe";

const arca = new ArcaClient({
  environment: "HOMOLOGACION",
  cuit: "20123456789",
  certificate: { id: "mi-cert-homo", certPem, keyPem },
  ptoVta: 1,
});
```

### Factura C (monotributo: sin IVA discriminado)

```ts
const r = await arca.issue({
  cbteTipo: CBTE_TIPOS.FACTURA_C,
  concept: 1,                                  // 1 productos, 2 servicios, 3 ambos
  docType: DOC_TIPOS.CONSUMIDOR_FINAL,
  docNumber: "0",
  netAmount: "1000.00",
  totalAmount: "1000.00",
  externalId: "venta-123",                     // tu id de la venta: ver idempotencia
});

if (r.status === "AUTORIZADA") {
  console.log(r.cae, r.cbteNro, r.caeExpiry, r.qr!.url);
}
```

### Factura A con IVA discriminado

```ts
import { ALICUOTAS_IVA, ivaFromNet, COND_IVA_RECEPTOR } from "arca-wsfe";

const { item, iva } = ivaFromNet("1000.00", ALICUOTAS_IVA.VEINTIUNO); // 210.00

await arca.issue({
  cbteTipo: CBTE_TIPOS.FACTURA_A,
  concept: 1,
  docType: DOC_TIPOS.CUIT,
  docNumber: "30111111118",
  condIvaReceptorId: COND_IVA_RECEPTOR.RESPONSABLE_INSCRIPTO,
  netAmount: "1000.00",
  ivaAmount: iva,
  totalAmount: "1210.00",
  ivaItems: [item],
  externalId: "venta-124",
});
```

### Servicios (requiere período y vencimiento)

```ts
await arca.issue({
  cbteTipo: CBTE_TIPOS.FACTURA_C,
  concept: 2,
  docType: DOC_TIPOS.CUIT,
  docNumber: "30111111118",
  condIvaReceptorId: COND_IVA_RECEPTOR.RESPONSABLE_INSCRIPTO,
  netAmount: "50000.00",
  totalAmount: "50000.00",
  serviceFrom: "20261101",
  serviceTo: "20261130",
  paymentDue: "20261210",
  externalId: "alquiler-nov",
});
```

### Nota de crédito (anular una factura)

El tipo se deriva del original (Factura A → NC A) y el comprobante asociado se arma solo:

```ts
await arca.creditNote({
  original: { cbteTipo: CBTE_TIPOS.FACTURA_C, ptoVta: 1, cbteNro: 42 },
  amounts: {
    docType: DOC_TIPOS.CONSUMIDOR_FINAL,
    docNumber: "0",
    netAmount: "1000.00",
    totalAmount: "1000.00",
  },
  externalId: "nc-venta-123",
});
```

En ARCA un comprobante autorizado no se borra ni se edita: se anula con una nota de crédito. `debitNote()` funciona igual.

### Errores

Un rechazo de ARCA **no es una excepción**: es un resultado.

```ts
const r = await arca.issue({ /* ... */ });

switch (r.status) {
  case "AUTORIZADA":  // r.cae, r.cbteNro, r.qr
  case "RECHAZADA":   // r.errors — los datos no pasaron; corregir y reintentar
  case "CONCILIANDO": // no se sabe si entró — ver abajo
}
```

Las excepciones (`ArcaError`) son para fallas de validación local, de red, de autenticación o resultados ambiguos. `humanArcaMessage(e)` devuelve un texto en castellano para mostrarle a un usuario final, y `e.kind` sirve para decidir en código. `e.retryable` es `true` sólo cuando reintentar es seguro.

---

## Emisión segura: lo importante

`FECAESolicitar` **no es idempotente** y la numeración de ARCA es secuencial y sin huecos. Si la llamada se corta, el comprobante pudo haberse autorizado igual: desde el cliente no hay forma de distinguir "no llegó" de "llegó y se perdió la respuesta". Reintentar ahí duplica el comprobante, y un comprobante de más en producción sólo se arregla con una nota de crédito.

La librería hace esto en cada emisión:

1. Toma un lock por `(CUIT, punto de venta, tipo de comprobante)`.
2. Concilia los intentos anteriores que quedaron sin resolver.
3. Pide el número a ARCA con `FECompUltimoAutorizado` — **nunca** un contador local.
4. Valida los datos localmente (totales, IVA, fechas, CUIT, campos obligatorios).
5. Guarda el intento **antes** de llamar.
6. Llama a `FECAESolicitar` **sin reintentos**.
7. Si se cortó: pregunta a ARCA por ese número exacto y compara el importe.

Para que eso funcione tenés que pasar **`externalId`**: tu identificador de la venta. Si un intento con el mismo `externalId` quedó colgado y en ARCA el comprobante existe, la librería devuelve ese resultado (`reconciled: true`) en lugar de emitir otro.

Cuando una emisión vuelve con `status: "CONCILIANDO"`, ARCA todavía no registra el comprobante. **No emitas de nuevo con otro número**: volvé a llamar con el mismo `externalId`, o resolvé el intento desde un job con `arca.reconcile(attempt)`.

Si el número aparece en ARCA **con otro importe**, la librería lanza `AMBIGUOUS_RESULT` y no toca nada: eso necesita que lo mire una persona.

---

## Producción

### 1. Habilitar el ambiente explícitamente

`PRODUCCION` está bloqueado por defecto. Se habilita con `allowProduction: true` o con `ARCA_ALLOW_PRODUCTION=1`, y conviene setearlo **sólo** en el entorno productivo: en producción cada comprobante es un hecho fiscal real.

### 2. Reemplazar los adapters en memoria

Los adapters por defecto son de memoria y sirven para un script o los tests. En una app con más de una instancia (o en serverless) hay que persistirlos:

| Adapter | Para qué | Qué pasa si queda en memoria |
|---|---|---|
| `TicketStore` | Cachear el Ticket de Acceso | WSAA rechaza el segundo login con `coe.alreadyAuthenticated` |
| `Lock` | Serializar login y emisión | Dos emisiones a la vez piden el mismo número |
| `AttemptStore` | Registrar intentos | Se pierde la posibilidad de conciliar: riesgo de duplicar |
| `ParamCache` | Cachear tablas de parámetros | Llamadas de más a ARCA en cada emisión |

Ejemplo con Postgres (locks por `pg_advisory_xact_lock`):

```ts
import type { ArcaAdapters } from "arca-wsfe";

const adapters: ArcaAdapters = {
  tickets: {
    async get(key) {
      const row = await db.ticket.findUnique({ where: { key } });
      if (!row) return null;
      return {
        token: decrypt(row.encToken),          // guardalo CIFRADO
        sign: decrypt(row.encSign),
        generationTime: row.generationTime,
        expirationTime: row.expirationTime,
      };
    },
    async set(key, t) {
      await db.ticket.upsert({
        where: { key },
        create: { key, encToken: encrypt(t.token), encSign: encrypt(t.sign), ...t },
        update: { encToken: encrypt(t.token), encSign: encrypt(t.sign), ...t },
      });
    },
  },

  lock: (name, fn) =>
    db.$transaction(async (tx) => {
      const key = hash63(name);               // bigint estable desde el nombre
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${key})`);
      return fn();
    }, { timeout: 60_000 }),

  attempts: {
    create: (a) => db.issueAttempt.create({ data: a }),
    findUnresolved: ({ cuit, ptoVta, cbteTipo }) =>
      db.issueAttempt.findFirst({
        where: { cuit, ptoVta, cbteTipo, status: { in: ["PENDIENTE", "AMBIGUO"] } },
        orderBy: { createdAt: "desc" },
      }),
    update: (id, patch) => db.issueAttempt.update({ where: { id }, data: patch }),
  },

  params: { /* get / set / clear sobre una tabla con payload JSON */ },
};
```

### 3. No loguear credenciales

El `Token` y el `Sign` del Ticket de Acceso son credenciales válidas por 12 horas: con esos dos valores se pueden emitir comprobantes en nombre del CUIT. `IssueResult.requestXml` ya viene enmascarado; si guardás otros XML, pasalos por `redactXml()` antes.

### 4. TLS

El endpoint de producción de WSFE negocia un grupo Diffie-Hellman que OpenSSL 3 rechaza (`ERR_SSL_DH_KEY_TOO_SMALL`). La librería lo detecta y baja a `SECLEVEL=1` **sólo para sus propias conexiones**, sin tocar el resto del proceso. Se puede forzar desde el arranque con `ARCA_TLS_LEGACY=1`.

### 5. Reloj

WSAA valida la ventana del TRA (±10 minutos). Si el reloj del servidor está corrido, la autenticación falla de manera intermitente. Tené NTP activo.

---

## Facturar en nombre de otro CUIT (delegación)

Un tercero puede delegarte el servicio de facturación electrónica en *Administrador de Relaciones*: vos firmás con **tu** certificado y emitís en nombre de **su** CUIT. Es el modelo que usan las plataformas que facturan para sus clientes.

```ts
const arca = new ArcaClient({
  environment: "PRODUCCION",
  allowProduction: true,
  cuit: "<TU_CUIT_DE_PLATAFORMA>",     // dueño del certificado
  representedCuit: "<CUIT_DEL_CLIENTE>", // por quien se factura
  certificate: { id: "plataforma-prod", certPem, keyPem },
});
```

Un solo certificado sirve para todos los CUITs que te hayan delegado el servicio, y el Ticket de Acceso se comparte (depende del certificado, no del representado).

Lo que le pedís a cada cliente es: delegar *Facturación Electrónica* a **tu** CUIT y tener un punto de venta de tipo Web Services.

> **Si publicás una guía o un onboarding basado en esto, poné tu propio CUIT.** Quien siga esas instrucciones va a delegarte el servicio a vos: quedás vinculado a su CUIT en ARCA y habilitado a emitir comprobantes en su nombre. No copies el CUIT de otro integrador.

### Lo que tenés que saber antes de operar como plataforma

Este modelo es cómodo para el cliente y concentra riesgo en vos. Cuatro cosas, en orden de importancia:

1. **Tu certificado es una llave maestra.** Uno solo puede emitir en nombre de *todos* los CUITs que te delegaron. Si se filtra, el daño es colectivo y no hay forma de limitarlo por cliente. Guardalo cifrado, fuera del repo y fuera de las variables de build; rotalo; y tratá su clave privada como tratarías la de tu propia identidad fiscal.
2. **No uses tu CUIT personal.** Usá el de una sociedad. Es lo que separa tu patrimonio del riesgo operativo del servicio, y cambiar el CUIT de plataforma después es caro: las delegaciones apuntan a un CUIT concreto, así que **cada cliente tiene que volver a delegar a mano** (no se migra por API). Decidilo antes de tener clientes.
3. **En ARCA queda registrado que vos operaste.** Si un cliente emite algo irregular, el rastro técnico pasa por tu CUIT. Guardá por cada emisión quién la pidió, cuándo y con qué datos — el `AttemptStore` ya te da la mitad (CUIT, punto de venta, tipo, número, total, tu `externalId`); sumale el usuario de tu aplicación.
4. **Dejá por escrito de quién es la responsabilidad fiscal.** El comprobante es del cliente; la plataforma es la herramienta. Y no le pidas nunca la Clave Fiscal: la delegación no la necesita, y pedirla te convierte en custodio de la credencial maestra de otra persona.

Si cualquiera de estos cuatro puntos te incomoda, el otro camino es que **cada cliente use su propio certificado** (`cuit` sin `representedCuit`): tu CUIT no participa en nada y el riesgo vuelve a cada dueño. Se paga en fricción de onboarding.

---

## Ejemplo ejecutable

`examples/homologacion.ts` hace el circuito completo contra homologación (nunca toca producción):

```bash
npx tsx examples/homologacion.ts csr --cuit 20123456789 --org "Mi Empresa"
# subí el .csr en ARCA, bajá el .crt, asociá wsfe y creá el punto de venta
npx tsx examples/homologacion.ts health  --cuit 20123456789
npx tsx examples/homologacion.ts factura --cuit 20123456789 --pv 1 --total 1000
npx tsx examples/homologacion.ts nc      --cuit 20123456789 --pv 1 --nro 1 --total 1000
```

---

## Notas sueltas, de las que cuestan una tarde

- **El orden del XML no es negociable.** El WSDL define el detalle como secuencia: `MonId, MonCotiz, CanMisMonExt, CondicionIVAReceptorId, CbtesAsoc, Tributos, Iva`. Fuera de orden, ARCA rechaza.
- **Los importes nunca van en `number`.** La librería usa `decimal.js` y acepta strings. ARCA valida que el total sea exactamente la suma de los subtotales, al centavo.
- **El parser XML no convierte números.** Un CAE tiene 14 dígitos y un CUIT 11: convertirlos automáticamente pierde dígitos. Todo llega como string.
- **La fecha es la de Argentina (UTC-3, sin horario de verano).** Un servidor en UTC después de las 21:00 ART ya está en el día siguiente y emite con fecha futura.
- **`CondicionIVAReceptorId` es obligatorio** desde la RG 5616, también en comprobantes C (consumidor final = 5).
- **Concepto 1 (productos)** acepta la fecha del comprobante en una ventana de ±5 días. Conceptos 2 y 3 exigen período del servicio y vencimiento de pago.
- **En homologación, el padrón es de prueba.** Un CUIT real válido puede ser rechazado con "no registrado en los padrones" sólo porque el padrón de homologación no lo tiene. En producción sale bien.
- **Si `FEParamGetPtosVenta` vuelve vacío**, no hay punto de venta de tipo Web Services dado de alta. El código 602 ("sin resultados") se trata como lista vacía, no como error.
- **El detalle de tributos (`Tributos`)** está implementado y validado localmente, pero no fue probado contra ARCA de punta a punta. Si lo usás, probalo primero en homologación.

---

## Desarrollo

```bash
npm install
npm test          # 57 tests, sin red: WSFE mockeado
npm run typecheck
npm run build
```

Los tests cubren las validaciones de comprobantes, el orden del XML, el QR, la firma CMS, el lock, y los caminos de timeout, conciliación e idempotencia.

---

## Aviso

Esta librería es una herramienta técnica, no asesoramiento fiscal o contable. Qué comprobante corresponde emitir, con qué alícuotas y en qué condición frente al IVA es responsabilidad de quien la usa y de su contador. Se entrega sin garantía (ver [LICENSE](LICENSE)): **probá siempre en homologación antes de pasar a producción**.

Proyecto independiente, sin relación con ARCA ni con AFIP.

## Licencia

MIT
