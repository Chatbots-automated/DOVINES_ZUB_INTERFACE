import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { config } from "./config.js";

// DelPro Gateway SOAP client (local only: http://127.0.0.1:28080/GatewaySoapService).
//
// Verified on the farm's Gateway (PowerShell, 2026-10):
//   * SOAP 1.1, operation namespace http://tempuri.org/,
//     SOAPAction "http://tempuri.org/IGatewayService/<Operation>"
//   * body <Operation xmlns="http://tempuri.org/"> with clientId, user, password,
//     xmlData — xmlData is an XML document sent as escaped element TEXT
//   * GetData request:  <requestData><object name=".." top="N"><property name=".."/>
//                       <where><equal name="..">value</equal></where></object></requestData>
//   * GetData result:   <ddmData><object name=".."><property name=".." [objectType=".."]>value</property>
//                       ... — empty element = no value; references carry objectType and
//                       list references are comma-separated keys
//   * CreateData result: <Response status="OK"><CreatedObject type=".." keyProperty=".."
//                       keyValue=".." id=".."/></Response>
// The result document comes back as the text of <OperationResult> inside
// <OperationResponse>; it is located by local name, so namespace prefixes
// don't matter. Not verified yet: UpdateData / DeleteData result shapes,
// GetMetadata's parameters, and any comparison operator other than <equal>.
//
// Credentials only ever go into the request body — never into errors or logs.

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const SERVICE_NS = "http://tempuri.org/";
const ACTION_PREFIX = "http://tempuri.org/IGatewayService/";
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export class GatewayError extends Error {
  /**
   * @param {string} code  stable machine code (SOAP_FAULT, TIMEOUT, UNREACHABLE, HTTP_500, BAD_RESPONSE, WRITE_REJECTED, WRITES_DISABLED)
   * @param {{ retryable?: boolean, outcomeUnknown?: boolean, details?: object }} [opts]
   *   outcomeUnknown — a write may have been applied (e.g. timeout after sending): verify by reading back, never blindly resend.
   */
  constructor(code, message, { retryable = false, outcomeUnknown = false, details } = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
    this.details = details;
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === "object" || name === "property" || name === "CreatedObject",
});

function parseXml(text, what) {
  try {
    return parser.parse(text);
  } catch (err) {
    throw new GatewayError("BAD_RESPONSE", `${what}: netinkamas XML (${err.message})`, { details: { snippet: String(text).slice(0, 300) } });
  }
}

const textOf = (node) => {
  if (node == null) return null;
  if (typeof node === "string") return node === "" ? null : node;
  const t = node["#text"];
  return t == null || t === "" ? null : String(t);
};

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function assertXmlName(name, what) {
  if (typeof name !== "string" || !XML_NAME.test(name)) throw new Error(`Netinkamas ${what}: ${JSON.stringify(name)}`);
  return name;
}

/**
 * GetData request document.
 * @param {{ objectName: string, properties: string[], where?: { op?: string, name: string, value: unknown }[], top?: number }} q
 *   `where` conditions are ANDed in one <where>; only op "equal" (the default) is verified on the Gateway.
 */
export function buildRequestData({ objectName, properties, where = [], top }) {
  assertXmlName(objectName, "objekto pavadinimas");
  const topAttr = top == null ? "" : ` top="${Math.trunc(Number(top))}"`;
  if (top != null && !(Math.trunc(Number(top)) > 0)) throw new Error(`Netinkamas top: ${top}`);
  const props = properties.map((p) => `<property name="${assertXmlName(p, "savybė")}"/>`).join("");
  const conditions = where
    .map((c) => {
      const op = assertXmlName(c.op ?? "equal", "sąlyga");
      return `<${op} name="${assertXmlName(c.name, "savybė")}">${escapeXml(c.value)}</${op}>`;
    })
    .join("");
  return `<requestData><object name="${objectName}"${topAttr}>${props}${conditions ? `<where>${conditions}</where>` : ""}</object></requestData>`;
}

/** SOAP 1.1 envelope exactly as verified: fields in the given order, values escaped as element text. */
export function soapEnvelope(operation, fields) {
  assertXmlName(operation, "operacija");
  const body = Object.entries(fields)
    .map(([k, v]) => `<${assertXmlName(k, "parametras")}>${escapeXml(v)}</${k}>`)
    .join("");
  return `<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><${operation} xmlns="${SERVICE_NS}">${body}</${operation}></s:Body></s:Envelope>`;
}

/** The decoded <OperationResult> text of a SOAP response, or a GatewayError (SOAP Fault included). */
export function extractSoapResult(operation, responseText) {
  const doc = parseXml(responseText, `Gateway ${operation} atsakymas`);
  const body = doc?.Envelope?.Body;
  if (body == null || typeof body !== "object") {
    throw new GatewayError("BAD_RESPONSE", `Gateway ${operation}: atsakymas nėra SOAP vokas`, { details: { snippet: String(responseText).slice(0, 300) } });
  }
  if (body.Fault) {
    const f = body.Fault;
    const reason = textOf(f.faultstring) ?? textOf(f.Reason?.Text) ?? "SOAP Fault";
    throw new GatewayError("SOAP_FAULT", `Gateway ${operation}: ${reason}`, { details: { faultcode: textOf(f.faultcode) } });
  }
  const response = body[`${operation}Response`];
  if (response == null || typeof response !== "object" || !(`${operation}Result` in response)) {
    throw new GatewayError("BAD_RESPONSE", `Gateway ${operation}: nėra ${operation}Result`, { details: { snippet: String(responseText).slice(0, 300) } });
  }
  return textOf(response[`${operation}Result`]) ?? "";
}

/**
 * <ddmData> -> [{ objectName, properties: { Name: { value: string|null, objectType: string|null } } }]
 * Values stay strings; typing happens per catalog field (catalog.js).
 */
export function parseDdmData(xml) {
  if (!xml || !String(xml).trim()) throw new GatewayError("BAD_RESPONSE", "Gateway grąžino tuščią rezultatą");
  const doc = parseXml(xml, "ddmData");
  if (!("ddmData" in doc)) {
    if (doc.Response) {
      throw new GatewayError("GATEWAY_ERROR", `Gateway atsakė status=${doc.Response["@_status"] ?? "?"}`, { details: { snippet: String(xml).slice(0, 500) } });
    }
    throw new GatewayError("BAD_RESPONSE", "Gateway rezultatas nėra ddmData", { details: { snippet: String(xml).slice(0, 300) } });
  }
  const root = doc.ddmData;
  const objects = root && typeof root === "object" ? (root.object ?? []) : [];
  return objects.map((o) => ({
    objectName: o["@_name"] ?? null,
    properties: Object.fromEntries(
      (o.property ?? []).map((p) => [p["@_name"], { value: textOf(p), objectType: (p && p["@_objectType"]) || null }]),
    ),
  }));
}

/** CreateData / UpdateData result: <Response status=".."><CreatedObject .../></Response>. Anything but OK throws. */
export function parseWriteResponse(xml) {
  const doc = parseXml(xml, "Gateway rašymo atsakymas");
  const r = doc.Response;
  if (r == null || typeof r !== "object") {
    throw new GatewayError("BAD_RESPONSE", "Gateway rašymo atsakymas nėra <Response>", { details: { snippet: String(xml).slice(0, 500) } });
  }
  const status = r["@_status"] ?? null;
  const created = (r.CreatedObject ?? []).map((o) => ({
    type: o["@_type"] ?? null,
    keyProperty: o["@_keyProperty"] ?? null,
    keyValue: o["@_keyValue"] ?? null,
    id: o["@_id"] ?? null,
  }));
  if (status !== "OK") {
    throw new GatewayError("WRITE_REJECTED", `Gateway atmetė įrašymą (status=${status ?? "?"})`, { details: { snippet: String(xml).slice(0, 1000) } });
  }
  return { status, created };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowWrites=false] CreateData / UpdateData refuse unless explicitly enabled.
 * @param {(operation: string, responseText: string) => void} [opts.onResponse] raw SOAP response hook (discovery only).
 *   Catalog writes additionally need CATALOG_WRITE_ENABLED + a validated write path (not built yet).
 */
export function createGatewayClient(opts = {}) {
  const g = { ...config.gateway, ...opts };
  const clientId = g.clientId || randomUUID();

  // One SOAP call: credentials first, then the operation's own parameters.
  async function send(operation, params, { idempotent }) {
    const fields = { clientId, user: g.user ?? "", password: g.password ?? "" };
    for (const [k, v] of Object.entries(params)) fields[assertXmlName(k, "parametras")] = v;
    const body = soapEnvelope(operation, fields);
    const attempts = idempotent ? 1 + g.readRetries : 1;
    for (let attempt = 1; ; attempt += 1) {
      let res;
      let text;
      try {
        res = await fetch(g.url, {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${ACTION_PREFIX}${operation}"` },
          body,
          signal: AbortSignal.timeout(g.timeoutMs),
        });
        text = await res.text();
        g.onResponse?.(operation, text);
      } catch (err) {
        const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        const refused = err?.cause?.code === "ECONNREFUSED";
        if (attempt < attempts) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new GatewayError(timeout ? "TIMEOUT" : "UNREACHABLE", `Gateway ${operation}: ${timeout ? "baigėsi laukimo laikas" : (err?.cause?.code ?? err.message)}`, {
          retryable: true,
          // a write that timed out may have been applied
          outcomeUnknown: !idempotent && !refused,
        });
      }
      // SOAP faults arrive as HTTP 500 with a Fault body — extractSoapResult turns them into SOAP_FAULT.
      if (!res.ok && !/Fault/i.test(text)) {
        if (attempt < attempts && res.status >= 500) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new GatewayError(`HTTP_${res.status}`, `Gateway ${operation}: HTTP ${res.status}`, {
          retryable: res.status >= 500,
          outcomeUnknown: !idempotent && res.status >= 500,
          details: { snippet: text.slice(0, 300) },
        });
      }
      return extractSoapResult(operation, text);
    }
  }

  function requireWrites(operation) {
    if (!g.allowWrites) throw new GatewayError("WRITES_DISABLED", `Gateway ${operation} išjungtas (rašymas į DelPro neleidžiamas šiam klientui).`);
  }

  return {
    clientId,
    /** Raw GetData: request document in, decoded result document out. Reads are retried. */
    getDataXml: (requestXml) => send("GetData", { xmlData: requestXml }, { idempotent: true }),
    /** getData("Animal", ["ObjectGuid", "Number"], [{ name: "Number", value: "337" }], { top: 1 }) */
    async getData(objectName, properties, filters = [], { top } = {}) {
      const xmlData = buildRequestData({ objectName, properties, where: filters, top });
      return parseDdmData(await send("GetData", { xmlData }, { idempotent: true }));
    },
    /** Never retried automatically: on outcomeUnknown read the record back before trying again. */
    async createData(ddmXml) {
      requireWrites("CreateData");
      return parseWriteResponse(await send("CreateData", { xmlData: ddmXml }, { idempotent: false }));
    },
    async updateData(ddmXml) {
      requireWrites("UpdateData");
      return parseWriteResponse(await send("UpdateData", { xmlData: ddmXml }, { idempotent: false }));
    },
    /**
     * GetMetadata with the caller's parameters after the credentials, e.g. getMetadata({ objectName: "Drug" }).
     * The parameter names are NOT verified — take them from the WSDL saved by `npm run gateway-discover`.
     * Returns the decoded result document as-is.
     */
    getMetadata: (params = {}) => send("GetMetadata", params, { idempotent: true }),
  };
}

/** The WSDL as text (discovery only). */
export async function fetchWsdl(url = `${config.gateway.url}?wsdl`) {
  const res = await fetch(url, { signal: AbortSignal.timeout(config.gateway.timeoutMs) });
  if (!res.ok) throw new GatewayError(`HTTP_${res.status}`, `WSDL: HTTP ${res.status}`);
  return res.text();
}
