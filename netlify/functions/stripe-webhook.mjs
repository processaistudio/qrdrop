// QR Drop: Stripe paga → aquesta funció genera el codi d'activació i l'envia per correu. Cap intervenció humana.
//
// Variables d'entorn (Netlify → Site configuration → Environment variables):
//   STRIPE_WEBHOOK_SECRET  signatura del webhook (whsec_…), per verificar que l'avís ve de Stripe
//   QRDROP_PRIVATE_KEY     clau privada Ed25519 (32 bytes en base64), la mateixa de license_tool.py
//   GMAIL_USER             compte que envia (studiosprocessai@gmail.com)
//   GMAIL_APP_PASSWORD     contrasenya d'aplicació de Google (no la del compte)
//   SELLER_BCC             (opcional) còpia de cada codi emès; per defecte, GMAIL_USER
import { createPrivateKey, sign } from "node:crypto";
import nodemailer from "nodemailer";
import Stripe from "stripe";

const MACHINE = /^QRD(-[A-Z2-7]{4}){4}$/;

const TEXT = {
  ca: {
    subject: "El teu codi d'activació de QR Drop",
    body: (n, m, c) => `Hola ${n},

Gràcies per comprar QR Drop complet. Aquest és el teu codi d'activació. Només val per a l'ordinador amb el codi de màquina ${m}:

${c}

A QR Drop → Activació, enganxa'l i prem «Activa». Si canvies d'ordinador, respon a aquest correu amb el codi de màquina nou i te n'enviem un altre.

Salut,
QR Drop · ProcessAI Studio`,
  },
  es: {
    subject: "Tu código de activación de QR Drop",
    body: (n, m, c) => `Hola ${n},

Gracias por comprar QR Drop completo. Este es tu código de activación. Solo vale para el ordenador con el código de máquina ${m}:

${c}

En QR Drop → Activación, pégalo y pulsa «Activar». Si cambias de ordenador, responde a este correo con el nuevo código de máquina y te enviamos otro.

Un saludo,
QR Drop · ProcessAI Studio`,
  },
  en: {
    subject: "Your QR Drop activation code",
    body: (n, m, c) => `Hi ${n},

Thanks for buying QR Drop Full. This is your activation code. It only works on the computer with machine code ${m}:

${c}

In QR Drop → Activation, paste it and click "Activate". If you change computers, reply to this email with the new machine code and we'll send you another one.

Best,
QR Drop · ProcessAI Studio`,
  },
};

// Mateix format que license_tool.py: JSON amb claus ordenades i sense espais, signat amb Ed25519, base64url sense "=".
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function issueCode(machine, name, seedB64) {
  const today = new Date().toISOString().slice(0, 10);
  const payload = JSON.stringify({ e: null, i: today, m: machine, n: name, v: 1 }); // ordre alfabètic: e, i, m, n, v
  const seed = Buffer.from(seedB64.trim(), "base64");
  if (seed.length !== 32) throw new Error("QRDROP_PRIVATE_KEY ha de ser la clau de 32 bytes en base64");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const sig = sign(null, Buffer.from(payload, "utf8"), key);
  return `QRDROP1.${b64url(Buffer.from(payload, "utf8"))}.${b64url(sig)}`;
}

function lang(session) {
  const l = (session.locale || "").toLowerCase();
  if (l.startsWith("ca")) return "ca";
  if (l.startsWith("es")) return "es";
  if (l.startsWith("en")) return "en";
  return null; // desconegut: correu en els tres idiomes
}

function compose(session, name, machine, code) {
  const l = lang(session);
  if (l) return { subject: TEXT[l].subject, text: TEXT[l].body(name, machine, code) };
  return {
    subject: `${TEXT.ca.subject} · ${TEXT.es.subject} · ${TEXT.en.subject}`,
    text: [TEXT.ca, TEXT.es, TEXT.en].map((t) => t.body(name, machine, code)).join("\n\n————————————————\n\n"),
  };
}

export default async (req) => {
  if (req.method !== "POST") return new Response("QR Drop webhook", { status: 200 });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_none", { apiVersion: "2024-06-20" });
  let event;
  try {
    event = stripe.webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`Signatura no vàlida: ${e.message}`, { status: 400 });
  }
  if (event.type !== "checkout.session.completed") return Response.json({ ignored: event.type });

  const s = event.data.object;
  if ((s.metadata || {}).product !== "qrdrop" || s.payment_status !== "paid") return Response.json({ ignored: "no és QR Drop pagat" });

  const email = s.customer_details?.email;
  const name = s.customer_details?.name || (email || "").split("@")[0];
  // El botó «Compra» de dins l'app passa el codi de màquina com a client_reference_id (el client no escriu res);
  // el camp del checkout queda com a reserva per a qui compra des de la web.
  const raw = s.client_reference_id || (s.custom_fields || []).find((f) => f.key === "codi_maquina")?.text?.value || "";
  const machine = raw.toUpperCase().replace(/\s+/g, "");
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const from = `"QR Drop" <${process.env.GMAIL_USER}>`;
  const bcc = process.env.SELLER_BCC || process.env.GMAIL_USER;

  if (!MACHINE.test(machine)) {
    // Codi de màquina mal escrit: avisem el venedor perquè ho resolgui a mà; al client, que torni a mirar-lo.
    await transport.sendMail({ from, to: bcc, subject: `QR Drop: codi de màquina no vàlid (${email})`,
      text: `Sessió ${s.id}\nClient: ${name} <${email}>\nCodi rebut: «${raw}»\n\nDemana-li el bo i emet-lo amb: python license_tool.py issue QRD-… "${name}"` });
    await transport.sendMail({ from, to: email, subject: TEXT.ca.subject,
      text: `Hola ${name},\n\nEl codi de màquina que has escrit («${raw}») no té el format QRD-XXXX-XXXX-XXXX-XXXX. Respon a aquest correu amb el codi que surt a QR Drop → Activació i t'enviem el codi d'activació de seguida.\n\nEl código de máquina que has escrito no tiene el formato correcto: responde con el que aparece en QR Drop → Activación.\n\nThe machine code you entered doesn't look right: reply with the one shown in QR Drop → Activation.\n\nQR Drop · ProcessAI Studio` });
    return Response.json({ ok: false, reason: "codi de màquina no vàlid" });
  }

  const code = issueCode(machine, name, process.env.QRDROP_PRIVATE_KEY);
  const { subject, text } = compose(s, name, machine, code);
  await transport.sendMail({ from, to: email, bcc, subject, text, headers: { "X-QRDrop-Session": s.id, "X-QRDrop-Machine": machine } });
  return Response.json({ ok: true, session: s.id, machine });
};

export const config = { path: "/api/stripe-webhook" };
