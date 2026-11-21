/**
 * BULK COMUNITÁRIO — PREENCHER NOMES DO ESTOQUE
 *
 * Arquivo separado do Code.gs. Não altera o site nem a implantação.
 *
 * O que faz:
 *   Lê a aba "Estoque". Para cada linha com Carta ID (coluna A) e sem Nome
 *   (coluna B), consulta a TCGdex e preenche o nome da carta.
 *   Se as colunas C (Coleção) ou D (Número) estiverem vazias, também preenche.
 *   Nunca altera Quantidade nem linhas que já têm nome.
 *
 * Como usar:
 *   1. No Apps Script, clique em "+" > Script e crie um arquivo chamado PreencherNomes.
 *   2. Cole este conteúdo e salve.
 *   3. Selecione a função preencherNomesEstoque e clique em Executar.
 *      (Na primeira vez o Google pede autorização para acessar a internet.)
 *   4. Pode executar de novo sempre que cadastrar cartas novas.
 *
 * Linhas cujo ID não foi encontrado ficam com o fundo vermelho-claro na
 * coluna A, para você conferir a referência digitada.
 */

const PREENCHER_CONFIG = {
  SHEET: "Estoque",
  API: "https://api.tcgdex.net/v2/",
  LANGS: ["pt", "en"],      // tenta português primeiro; se não houver, inglês
  BATCH: 40,                // consultas simultâneas por lote
  MAX_MS: 5 * 60 * 1000,    // para antes do limite de 6 min do Apps Script
  NOT_FOUND_COLOR: "#fde2e2"
};

function preencherNomesEstoque() {
  const started = Date.now();
  const id = PropertiesService.getScriptProperties().getProperty("BULK_SPREADSHEET_ID");
  if (!id) throw new Error("Planilha não configurada (BULK_SPREADSHEET_ID ausente).");
  const sheet = SpreadsheetApp.openById(id).getSheetByName(PREENCHER_CONFIG.SHEET);
  if (!sheet) throw new Error('A aba "' + PREENCHER_CONFIG.SHEET + '" não foi encontrada.');

  const last = sheet.getLastRow();
  if (last <= 1) { Logger.log("A aba Estoque está vazia."); return; }

  const range = sheet.getRange(2, 1, last - 1, 4);           // colunas A:D
  const values = range.getValues();

  // Linhas que precisam de dados: tem ID e falta nome (ou coleção/número).
  const pending = [];
  values.forEach((row, i) => {
    const cardId = String(row[0] || "").trim();
    if (!cardId) return;
    if (!row[1] || !row[2] || !row[3]) pending.push({ index: i, cardId: cardId });
  });
  if (!pending.length) { Logger.log("Nada a preencher: todas as linhas já têm nome, coleção e número."); return; }

  const cache = {};               // evita consultar o mesmo ID duas vezes
  let filled = 0, notFound = [], stoppedEarly = false;

  for (let start = 0; start < pending.length; start += PREENCHER_CONFIG.BATCH) {
    if (Date.now() - started > PREENCHER_CONFIG.MAX_MS) { stoppedEarly = true; break; }
    const batch = pending.slice(start, start + PREENCHER_CONFIG.BATCH);
    const ids = [...new Set(batch.map(item => item.cardId).filter(cardId => !(cardId in cache)))];
    fetchCards_(ids, cache);

    batch.forEach(item => {
      const card = cache[item.cardId];
      const row = values[item.index];
      const cellA = sheet.getRange(item.index + 2, 1);
      if (!card) { notFound.push(item.index + 2); cellA.setBackground(PREENCHER_CONFIG.NOT_FOUND_COLOR); return; }
      if (!row[1]) row[1] = card.name || "";
      if (!row[2]) row[2] = (card.set && card.set.name) || "";
      if (!row[3]) row[3] = formatNumber_(card);
      cellA.setBackground(null);
      filled++;
    });

    // Grava o progresso a cada lote: se parar no meio, nada se perde.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      // Relê a coluna A para não sobrescrever linhas movidas durante a execução.
      const currentIds = sheet.getRange(2, 1, last - 1, 1).getValues();
      batch.forEach(item => {
        if (String(currentIds[item.index][0] || "").trim() !== item.cardId) return;
        sheet.getRange(item.index + 2, 4).setNumberFormat("@"); // mantém "010/132" como texto
        sheet.getRange(item.index + 2, 2, 1, 3).setValues([[values[item.index][1], values[item.index][2], values[item.index][3]]]);
      });
    } finally {
      lock.releaseLock();
    }
  }

  const summary = "Linhas preenchidas: " + filled +
    (notFound.length ? " | IDs não encontrados nas linhas: " + notFound.join(", ") : "") +
    (stoppedEarly ? " | Tempo esgotado: execute novamente para continuar de onde parou." : "");
  Logger.log(summary);
  return summary;
}

/** Consulta vários IDs de uma vez, tentando cada idioma configurado. */
function fetchCards_(ids, cache) {
  let missing = ids.slice();
  PREENCHER_CONFIG.LANGS.forEach(lang => {
    if (!missing.length) return;
    const requests = missing.map(cardId => ({
      url: PREENCHER_CONFIG.API + lang + "/cards/" + encodeURIComponent(cardId),
      muteHttpExceptions: true
    }));
    const responses = UrlFetchApp.fetchAll(requests);
    const stillMissing = [];
    responses.forEach((response, i) => {
      const cardId = missing[i];
      if (response.getResponseCode() === 200) {
        try { cache[cardId] = JSON.parse(response.getContentText()); return; } catch (e) {}
      }
      stillMissing.push(cardId);
    });
    missing = stillMissing;
  });
  missing.forEach(cardId => { cache[cardId] = null; });
}

/** Monta o número no formato 010/132; cartas promocionais ficam só com o código. */
function formatNumber_(card) {
  const local = String(card.localId || "");
  const official = card.set && card.set.cardCount && card.set.cardCount.official;
  return /^\d+$/.test(local) && official ? local + "/" + String(official).padStart(local.length, "0") : local;
}
