// Comptador de baixades: la web enllaça /api/dl, que suma una baixada i envia l'usuari a l'instal·lador.
// Sense això no sabem si val la pena fer promoció. No es desa cap dada de la persona: només comptadors.
//
//   /api/dl                 -> compta i redirigeix a l'instal·lador de la versió publicada
//   /api/stats?k=<SECRET>   -> {total, per dia, per idioma}; SECRET = STATS_KEY (variable d'entorn)
import { getStore } from "@netlify/blobs";

const VERSION_URL = "/version.json";

async function installer(origin) {
  const r = await fetch(new URL(VERSION_URL, origin));
  const { url } = await r.json();
  return url;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore("downloads");

  if (url.pathname === "/api/stats") {
    const key = process.env.STATS_KEY;
    if (!key || url.searchParams.get("k") !== key) return new Response("no", { status: 403 });
    const data = (await store.get("counts", { type: "json" })) || {};
    const days = data.days || {};
    return Response.json({
      total: data.total || 0,
      per_idioma: data.langs || {},
      ultims_dies: Object.fromEntries(Object.entries(days).sort().slice(-30)),
    });
  }

  // Comptar no ha d'impedir mai la baixada: si l'emmagatzematge falla, seguim endavant.
  try {
    const data = (await store.get("counts", { type: "json" })) || { total: 0, days: {}, langs: {} };
    const lang = (url.searchParams.get("l") || "ca").slice(0, 2);
    const day = today();
    data.total = (data.total || 0) + 1;
    data.days = { ...data.days, [day]: (data.days?.[day] || 0) + 1 };
    data.langs = { ...data.langs, [lang]: (data.langs?.[lang] || 0) + 1 };
    await store.setJSON("counts", data);
  } catch (e) {
    console.error("comptador:", e.message);
  }

  let target;
  try {
    target = await installer(url.origin);
  } catch {
    target = "/dl/";  // si version.json no respon, que l'usuari vegi la carpeta i no una pàgina d'error
  }
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
};

export const config = { path: ["/api/dl", "/api/stats"] };
