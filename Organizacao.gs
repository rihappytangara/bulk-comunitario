/**
 * BULK COMUNITÁRIO — ORGANIZAÇÃO DA CAIXA POR TIPO
 *
 * Arquivo separado. Não altera o site nem a implantação (não precisa de nova versão).
 *
 * O que faz:
 *   1. Lê as coleções que existem na aba "Estoque" (pelo prefixo do Carta ID: me01, sv10...).
 *   2. Consulta na TCGdex o tipo de cada carta da coleção completa.
 *   3. Cria/atualiza a aba "Organização" com as faixas de numeração por tipo, ex.:
 *        Megaevolução | 1 | 18 | Planta | 15 cartas diferentes | 128 unidades
 *
 * Como usar:
 *   1. No Apps Script: "+" > Script > nome "Organizacao". Cole este conteúdo e salve.
 *   2. Selecione a função gerarOrganizacaoPorTipo e clique em Executar.
 *   3. Se o registro disser "execute novamente", execute de novo: as coleções já
 *      consultadas ficam guardadas e a próxima execução continua de onde parou.
 */

const ORG_CONFIG = {
  API: "https://api.tcgdex.net/v2/en/",
  SHEET: "Organização",
  BATCH: 50,
  MAX_MS: 4.5 * 60 * 1000,
  CACHE_PREFIX: "ORG_TIPOS_"
};

// Tipos na ordem em que aparecem nas coleções
const ORG_TYPES = {
  Grass: "Planta", Fire: "Fogo", Water: "Água", Lightning: "Elétrico", Psychic: "Psíquico",
  Fighting: "Lutador", Darkness: "Escuridão", Metal: "Metal", Fairy: "Fada", Dragon: "Dragão",
  Colorless: "Incolor"
};

function gerarOrganizacaoPorTipo() {
  const started = Date.now();
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("BULK_SPREADSHEET_ID"));
  const stockSheet = ss.getSheetByName("Estoque");
  if (!stockSheet) throw new Error('A aba "Estoque" não foi encontrada.');

  // 1. Estoque agrupado por coleção
  const last = stockSheet.getLastRow();
  const stockRows = last > 1 ? stockSheet.getRange(2, 1, last - 1, 5).getValues() : [];
  const sets = new Map(); // setId -> { name, cards: Map(localNumber -> quantity) }
  stockRows.forEach(row => {
    const cardId = String(row[0] || "").trim();
    const cut = cardId.lastIndexOf("-");
    if (cut < 1) return;
    const setId = cardId.slice(0, cut);
    const local = cardId.slice(cut + 1);
    if (!sets.has(setId)) sets.set(setId, { name: String(row[2] || setId), cards: new Map() });
    const qty = Math.max(0, Number(row[4]) || 0);
    const set = sets.get(setId);
    set.cards.set(local, (set.cards.get(local) || 0) + qty);
  });

  // 2. Tipos de cada coleção (com cache, para continuar se o tempo acabar)
  const props = PropertiesService.getScriptProperties();
  const pendingSets = [];
  const typeData = new Map();
  for (const setId of sets.keys()) {
    const cached = props.getProperty(ORG_CONFIG.CACHE_PREFIX + setId);
    if (cached) { typeData.set(setId, JSON.parse(cached)); continue; }
    if (Date.now() - started > ORG_CONFIG.MAX_MS) { pendingSets.push(setId); continue; }
    const data = fetchSetTypes_(setId, started);
    if (!data) { pendingSets.push(setId); continue; }
    typeData.set(setId, data);
    try { props.setProperty(ORG_CONFIG.CACHE_PREFIX + setId, JSON.stringify(data)); } catch (e) { /* cache é opcional */ }
  }

  // 3. Monta as faixas
  const output = [["Coleção", "Código", "De", "Até", "Tipo", "Cartas diferentes no estoque", "Unidades no estoque"]];
  for (const [setId, set] of sets) {
    const data = typeData.get(setId);
    if (!data) { output.push([set.name, setId, "", "", "⏳ Execute novamente para completar", "", ""]); continue; }

    if (!data.numeric) {
      // Promos com códigos (ex.: SWSH020): lista carta a carta
      [...set.cards.keys()].sort().forEach(local => {
        const label = data.labels[local] || "Não identificado";
        const qty = set.cards.get(local);
        output.push([set.name, setId, local, local, label, qty > 0 ? 1 : 0, qty]);
      });
      continue;
    }

    const runs = [];
    data.order.forEach(local => {
      const n = Number(local);
      let label = data.labels[local] || "Não identificado";
      if (data.official && n > data.official) label = "Especiais (acima de " + data.official + ")";
      const prev = runs[runs.length - 1];
      if (prev && prev.label === label) prev.to = n;
      else runs.push({ label: label, from: n, to: n });
    });

    runs.forEach(run => {
      let distinct = 0, units = 0;
      set.cards.forEach((qty, local) => {
        const n = Number(local);
        if (n >= run.from && n <= run.to && qty > 0) { distinct++; units += qty; }
      });
      output.push([set.name, setId, run.from, run.to, run.label, distinct, units]);
    });
  }

  // 4. Grava a aba
  const sheet = ss.getSheetByName(ORG_CONFIG.SHEET) || ss.insertSheet(ORG_CONFIG.SHEET);
  sheet.clear();
  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, output[0].length).setFontWeight("bold").setBackground("#0878c9").setFontColor("#fff");
  sheet.autoResizeColumns(1, output[0].length);

  const msg = pendingSets.length
    ? "Parcial. Faltam as coleções: " + pendingSets.join(", ") + ". Execute novamente para completar."
    : "Concluído: " + sets.size + " coleções organizadas na aba " + ORG_CONFIG.SHEET + ".";
  Logger.log(msg);
  return msg;
}

/** Busca a coleção e o tipo de todas as suas cartas. Retorna null se o tempo acabar. */
function fetchSetTypes_(setId, started) {
  const setResp = UrlFetchApp.fetch(ORG_CONFIG.API + "sets/" + encodeURIComponent(setId), { muteHttpExceptions: true });
  if (setResp.getResponseCode() !== 200) return { numeric: false, official: 0, order: [], labels: {} };
  const set = JSON.parse(setResp.getContentText());
  const cards = set.cards || [];
  const numeric = cards.length > 0 && cards.every(card => /^\d+$/.test(String(card.localId)));
  const labels = {};

  for (let i = 0; i < cards.length; i += ORG_CONFIG.BATCH) {
    if (Date.now() - started > ORG_CONFIG.MAX_MS) return null;
    const batch = cards.slice(i, i + ORG_CONFIG.BATCH);
    const responses = UrlFetchApp.fetchAll(batch.map(card => ({
      url: ORG_CONFIG.API + "cards/" + encodeURIComponent(card.id), muteHttpExceptions: true
    })));
    responses.forEach((resp, j) => {
      const local = String(batch[j].localId);
      const key = numeric ? String(Number(local)).padStart(3, "0") : local;
      if (resp.getResponseCode() !== 200) return;
      try { labels[key] = cardLabel_(JSON.parse(resp.getContentText())); } catch (e) {}
    });
  }

  const order = cards.map(card => numeric ? String(Number(card.localId)).padStart(3, "0") : String(card.localId));
  if (numeric) order.sort((a, b) => Number(a) - Number(b));
  return { numeric: numeric, official: (set.cardCount && set.cardCount.official) || 0, order: order, labels: labels };
}

function cardLabel_(card) {
  if (card.category === "Trainer") return "Treinadores";
  if (card.category === "Energy") return "Energias";
  const type = card.types && card.types[0];
  return ORG_TYPES[type] || type || "Não identificado";
}

/** Apaga o cache (use só se quiser consultar tudo de novo). */
function limparCacheOrganizacao() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties())
    .filter(key => key.indexOf(ORG_CONFIG.CACHE_PREFIX) === 0)
    .forEach(key => props.deleteProperty(key));
  Logger.log("Cache da organização apagado.");
}
