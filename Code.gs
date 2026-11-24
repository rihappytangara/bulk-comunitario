/**
 * BULK COMUNITÁRIO — BACKEND V2
 * Google Sheets + Google Apps Script
 *
 * IMPORTANTE:
 * - Não execute setup() novamente se a planilha já está configurada.
 * - Não execute configureAdminPassword() novamente.
 * - Após substituir este arquivo, salve e implante uma NOVA VERSÃO do Web App.
 */
const CONFIG = {
  SPREADSHEET_PROPERTY: "BULK_SPREADSHEET_ID",
  TIMEZONE: "America/Cuiaba",
  WEEKLY_LIMIT: 7,
  HEADERS: ["Protocolo", "Data e hora", "Nome", "Telefone", "Total retirado", "Total deixado", "Status", "Atualizado em", "Observação", "Separada em"],
  DETAIL_HEADERS: ["Protocolo", "Operação", "Carta ID", "Nome da carta", "Coleção", "Número", "Quantidade"],
  STOCK_HEADERS: ["Carta ID", "Nome", "Coleção", "Número", "Quantidade", "Última atualização"],
  ADMIN_HASH: "BULK_ADMIN_PASSWORD_SHA256"
};

function setup() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CONFIG.SPREADSHEET_PROPERTY);
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create("Bulk Comunitário - Ri Happy Tangará");
  ensureSheet_(ss, "Movimentações", CONFIG.HEADERS);
  ensureSheet_(ss, "Detalhes", CONFIG.DETAIL_HEADERS);
  ensureSheet_(ss, "Estoque", CONFIG.STOCK_HEADERS);
  props.setProperty(CONFIG.SPREADSHEET_PROPERTY, ss.getId());
  Logger.log("Planilha: " + ss.getUrl());
  return ss.getUrl();
}

function ensureSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#0878c9").setFontColor("#fff");
  }
}

function configureAdminPassword() {
  const password = "TROQUE_POR_UMA_SENHA_FORTE_DE_12_OU_MAIS_CARACTERES";
  if (password.indexOf("TROQUE_POR_") === 0 || password.length < 12) {
    throw new Error("Edite a senha dentro de configureAdminPassword() antes de executar.");
  }
  PropertiesService.getScriptProperties().setProperty(CONFIG.ADMIN_HASH, sha256_(password));
  Logger.log("Senha administrativa configurada. Remova a senha literal do código e salve.");
}

function doGet(e) {
  const p = e && e.parameter ? e.parameter : {};

  if (p.action !== "stock") {
    return ContentService.createTextOutput("Bulk Comunitário API")
      .setMimeType(ContentService.MimeType.TEXT);
  }

  const requestId = String(p.requestId || "");
  let result;

  try {
    result = publicStock_();
  } catch (err) {
    result = {
      ok: false,
      message: err && err.message ? err.message : "Erro ao consultar estoque.",
      stock: []
    };
  }

  // O app.js aguarda uma mensagem postMessage com este tipo e requestId.
  const payload = JSON.stringify(Object.assign({
    type: "BULK_STOCK_RESPONSE",
    requestId: requestId
  }, result)).replace(/</g, "\\u003c");

  const html = '<!doctype html><html><body><script>' +
    'window.top.postMessage(' + payload + ', "*");' +
    '</script>Consulta concluída.</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let p = {};
  try {
    p = JSON.parse((e && e.parameter && e.parameter.payload) || "{}");
    let result;
    switch (p.action || "register") {
      case "register": result = registerMovement_(p); break;
      case "login": result = adminLogin_(p); break;
      case "list": result = adminList_(p); break;
      case "stock": result = publicStock_(); break;
      case "approve": result = adminApprove_(p); break;
      case "reject": result = adminReject_(p); break;
      case "separate": result = adminSeparate_(p); break;
      default: throw new Error("Ação inválida.");
    }
    return responseHtml_(Object.assign({ requestId: p.requestId || "" }, result));
  } catch (err) {
    return responseHtml_({ ok: false, requestId: p.requestId || "", message: err && err.message ? err.message : "Erro inesperado." });
  }
}

function registerMovement_(p) {
  if (p.website) throw new Error("Envio não permitido.");
  const requestId = String(p.requestId || "").slice(0, 80);
  const name = String(p.name || "").trim().replace(/\s+/g, " ").slice(0, 100);
  const phone = String(p.phone || "").replace(/\D/g, "").slice(0, 13);
  const withdrawals = normalizeCards_(p.withdrawals);
  const deposits = normalizeCards_(p.deposits);
  const out = withdrawals.reduce((sum, card) => sum + card.quantity, 0);
  const inn = deposits.reduce((sum, card) => sum + card.quantity, 0);

  if (!requestId || name.length < 3 || phone.length < 10 || !p.declaration || (!out && !inn) || out > CONFIG.WEEKLY_LIMIT) {
    throw new Error("Confira os dados, a declaração e o limite de 7 cartas retiradas.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName("Movimentações");
    const details = ss.getSheetByName("Detalhes");
    if (!sh || !details) throw new Error("As abas Movimentações ou Detalhes não foram encontradas.");

    const last = sh.getLastRow();
    if (last > 1) {
      const found = sh.getRange(2, 1, last - 1, 1).getDisplayValues().flat().find(value => value === requestId);
      if (found) return { ok: true, requestId: requestId, protocol: found, duplicate: true, status: "Pendente" };
    }

    const now = new Date();
    const used = getWithdrawalsThisWeek_(sh, phone, now);
    if (used + out > CONFIG.WEEKLY_LIMIT) {
      throw new Error("Limite semanal atingido. Já retirou " + used + " carta(s); saldo: " + Math.max(0, CONFIG.WEEKLY_LIMIT - used) + ".");
    }

    // Validação de reserva sob bloqueio para impedir solicitações simultâneas.
    validateWithdrawalAvailability_(ss, withdrawals);

    const protocol = "BULK-" + Utilities.formatDate(now, CONFIG.TIMEZONE, "yyMMdd-HHmmss") + "-" + Utilities.getUuid().slice(0, 4).toUpperCase();
    sh.appendRow([protocol, now, name, phone, out, inn, "Pendente", now, ""]);

    const rows = [];
    withdrawals.forEach(card => rows.push([protocol, "Retirada", card.id, card.name, card.setName, card.localId, card.quantity]));
    deposits.forEach(card => rows.push([protocol, "Entrada", card.id, card.name, card.setName, card.localId, card.quantity]));
    if (rows.length) details.getRange(details.getLastRow() + 1, 1, rows.length, 7).setValues(rows);

    return { ok: true, requestId: requestId, protocol: protocol, status: "Pendente" };
  } finally {
    lock.releaseLock();
  }
}

function normalizeCards_(cards) {
  if (!Array.isArray(cards)) return [];
  if (cards.length > 100) throw new Error("Itens demais.");
  return cards.map(card => {
    const quantity = Math.floor(Number(card.quantity));
    const id = String(card.id || "").slice(0, 80);
    const name = String(card.name || "").trim().slice(0, 100);
    if (!id || !name || !Number.isFinite(quantity) || quantity < 1 || quantity > 99) throw new Error("Carta inválida.");
    return {
      id: id,
      name: name,
      localId: String(card.localId || "").slice(0, 30),
      setName: String(card.setName || "").slice(0, 100),
      quantity: quantity
    };
  });
}

/* AUTENTICAÇÃO ADMINISTRATIVA */

function adminLogin_(p) {
  const hash = PropertiesService.getScriptProperties().getProperty(CONFIG.ADMIN_HASH);
  if (!hash) throw new Error("Senha administrativa ainda não configurada.");
  if (sha256_(String(p.password || "")) !== hash) throw new Error("Senha incorreta.");
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put("bulk_admin_" + token, "1", 21600);
  return { ok: true, token: token, expiresIn: 21600 };
}

function requireAdmin_(token) {
  if (!token || CacheService.getScriptCache().get("bulk_admin_" + token) !== "1") {
    throw new Error("Sessão expirada. Entre novamente.");
  }
}

/* ESTOQUE E RESERVAS */

function getPhysicalStockMap_(ss) {
  const sh = ss.getSheetByName("Estoque");
  if (!sh) throw new Error("A aba Estoque não foi encontrada.");
  const last = sh.getLastRow();
  const map = new Map();
  if (last <= 1) return map;

  sh.getRange(2, 1, last - 1, 6).getValues().forEach(row => {
    const id = String(row[0] || "").trim();
    if (!id) return;
    const item = map.get(id) || {
      id: id,
      name: String(row[1] || ""),
      setName: String(row[2] || ""),
      localId: String(row[3] || ""),
      quantity: 0
    };
    item.quantity += Math.max(0, Number(row[4]) || 0);
    map.set(id, item);
  });
  return map;
}

function getPendingReservationsMap_(ss) {
  const movements = ss.getSheetByName("Movimentações");
  const details = ss.getSheetByName("Detalhes");
  const reserved = new Map();
  if (!movements || !details || movements.getLastRow() <= 1 || details.getLastRow() <= 1) return reserved;

  const pending = new Set(
    movements.getRange(2, 1, movements.getLastRow() - 1, 7).getValues()
      .filter(row => String(row[6]) === "Pendente")
      .map(row => String(row[0]))
  );
  if (!pending.size) return reserved;

  details.getRange(2, 1, details.getLastRow() - 1, 7).getValues().forEach(row => {
    if (String(row[1]) !== "Retirada" || !pending.has(String(row[0]))) return;
    const id = String(row[2] || "").trim();
    const quantity = Math.max(0, Number(row[6]) || 0);
    if (id && quantity) reserved.set(id, (reserved.get(id) || 0) + quantity);
  });
  return reserved;
}

function validateWithdrawalAvailability_(ss, withdrawals) {
  const physical = getPhysicalStockMap_(ss);
  const reserved = getPendingReservationsMap_(ss);
  const requested = new Map();
  withdrawals.forEach(card => requested.set(card.id, (requested.get(card.id) || 0) + card.quantity));

  requested.forEach((quantity, id) => {
    const item = physical.get(id);
    const onHand = item ? item.quantity : 0;
    const held = reserved.get(id) || 0;
    const available = Math.max(0, onHand - held);
    if (quantity > available) {
      throw new Error("Estoque insuficiente para " + (item ? item.name : id) + ". Disponível para novas solicitações: " + available + ".");
    }
  });
}

function publicStock_() {
  const ss = getSpreadsheet_();
  const physical = getPhysicalStockMap_(ss);
  const reserved = getPendingReservationsMap_(ss);
  const stock = [];

  physical.forEach(item => {
    const available = Math.max(0, item.quantity - (reserved.get(item.id) || 0));
    if (available > 0) {
      stock.push({
        id: item.id,
        name: item.name,
        setName: item.setName,
        localId: item.localId,
        quantity: available
      });
    }
  });
  return { ok: true, stock: stock };
}

/* PAINEL ADMINISTRATIVO */

function adminList_(p) {
  requireAdmin_(p.token);
  const ss = getSpreadsheet_();
  const movementsSheet = ss.getSheetByName("Movimentações");
  const detailsSheet = ss.getSheetByName("Detalhes");
  const stockSheet = ss.getSheetByName("Estoque");
  if (!movementsSheet || !detailsSheet || !stockSheet) throw new Error("Uma ou mais abas necessárias não foram encontradas.");

  const movementRows = movementsSheet.getLastRow() > 1
    ? movementsSheet.getRange(2, 1, movementsSheet.getLastRow() - 1, 10).getValues() : [];
  const detailRows = detailsSheet.getLastRow() > 1
    ? detailsSheet.getRange(2, 1, detailsSheet.getLastRow() - 1, 7).getValues() : [];
  const stockRows = stockSheet.getLastRow() > 1
    ? stockSheet.getRange(2, 1, stockSheet.getLastRow() - 1, 6).getValues() : [];

  const movements = movementRows.map(row => ({
    protocol: row[0],
    date: row[1] instanceof Date ? row[1].toISOString() : String(row[1]),
    name: row[2],
    phone: row[3],
    withdrawals: row[4],
    deposits: row[5],
    status: row[6],
    note: row[8],
    separatedAt: row[9] instanceof Date ? row[9].toISOString() : "",
    cards: detailRows.filter(detail => detail[0] === row[0]).map(detail => ({
      operation: detail[1],
      id: detail[2],
      name: detail[3],
      setName: detail[4],
      localId: detail[5],
      quantity: detail[6]
    }))
  })).reverse();

  return {
    ok: true,
    movements: movements,
    stock: stockRows.map(row => ({
      id: row[0], name: row[1], setName: row[2],
      localId: row[3], quantity: Number(row[4]) || 0
    }))
  };
}

function adminApprove_(p) {
  requireAdmin_(p.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const ss = getSpreadsheet_();
    const movements = ss.getSheetByName("Movimentações");
    const details = ss.getSheetByName("Detalhes");
    const stock = ss.getSheetByName("Estoque");
    if (!movements || !details || !stock) throw new Error("Uma ou mais abas necessárias não foram encontradas.");

    const last = movements.getLastRow();
    if (last <= 1) throw new Error("Protocolo não encontrado.");
    const values = movements.getRange(2, 1, last - 1, 9).getValues();
    const index = values.findIndex(row => row[0] === p.protocol);
    if (index < 0) throw new Error("Protocolo não encontrado.");

    const rowNumber = index + 2;
    if (values[index][6] !== "Pendente") throw new Error("Esta solicitação já foi processada.");

    const detailRows = details.getLastRow() > 1
      ? details.getRange(2, 1, details.getLastRow() - 1, 7).getValues().filter(row => row[0] === p.protocol)
      : [];

    const approvedThisWeek = getWithdrawalsThisWeek_(
      movements, String(values[index][3]).replace(/\D/g, ""), new Date()
    );
    if (approvedThisWeek + Number(values[index][4] || 0) > CONFIG.WEEKLY_LIMIT) {
      throw new Error("Aprovação bloqueada: esta movimentação ultrapassaria o limite semanal de 7 cartas retiradas.");
    }

    const stockLastRow = stock.getLastRow();
    const stockRows = stockLastRow > 1 ? stock.getRange(2, 1, stockLastRow - 1, 6).getValues() : [];
    const stockMap = new Map();

    stockRows.forEach((row, i) => {
      const id = String(row[0] || "");
      if (id && !stockMap.has(id)) stockMap.set(id, { row: i + 2, quantity: Number(row[4]) || 0 });
    });

    const withdrawals = detailRows.filter(row => row[1] === "Retirada");
    const deposits = detailRows.filter(row => row[1] === "Entrada");

    // Valida todas as retiradas antes de fazer qualquer alteração.
    withdrawals.forEach(row => {
      const item = stockMap.get(String(row[2]));
      const quantity = Number(row[6]) || 0;
      if (!item || item.quantity < quantity) {
        throw new Error("Estoque insuficiente para " + row[3] + " (" + row[4] + " · " + row[5] + "). Disponível: " + (item ? item.quantity : 0) + ".");
      }
    });

    const now = new Date();
    withdrawals.forEach(row => {
      const item = stockMap.get(String(row[2]));
      const quantity = Number(row[6]) || 0;
      stock.getRange(item.row, 5).setValue(item.quantity - quantity);
      stock.getRange(item.row, 6).setValue(now);
      item.quantity -= quantity;
    });

    deposits.forEach(row => {
      const id = String(row[2]);
      const quantity = Number(row[6]) || 0;
      const item = stockMap.get(id);
      if (item) {
        stock.getRange(item.row, 5).setValue(item.quantity + quantity);
        stock.getRange(item.row, 6).setValue(now);
        item.quantity += quantity;
      } else {
        stock.appendRow([id, row[3], row[4], row[5], quantity, now]);
        stockMap.set(id, { row: stock.getLastRow(), quantity: quantity });
      }
    });

    movements.getRange(rowNumber, 7, 1, 3).setValues([["Aprovada", now, "Troca realizada e conferida"]]);
    return { ok: true, protocol: p.protocol, status: "Aprovada" };
  } finally {
    lock.releaseLock();
  }
}

function adminReject_(p) {
  requireAdmin_(p.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const sheet = getSpreadsheet_().getSheetByName("Movimentações");
    if (!sheet) throw new Error("A aba Movimentações não foi encontrada.");
    const last = sheet.getLastRow();
    const values = last > 1 ? sheet.getRange(2, 1, last - 1, 9).getValues() : [];
    const index = values.findIndex(row => row[0] === p.protocol);
    if (index < 0) throw new Error("Protocolo não encontrado.");
    if (values[index][6] !== "Pendente") throw new Error("Esta solicitação já foi processada.");

    sheet.getRange(index + 2, 7, 1, 3).setValues([[
      "Recusada", new Date(), String(p.note || "Recusada pelo administrador").slice(0, 250)
    ]]);
    return { ok: true, protocol: p.protocol, status: "Recusada" };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Marca (ou desmarca) que as cartas de uma solicitação pendente já foram
 * separadas pela loja. Não altera o status nem o estoque: a solicitação
 * continua Pendente e as cartas continuam reservadas até aprovar ou recusar.
 */
function adminSeparate_(p) {
  requireAdmin_(p.token);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSpreadsheet_().getSheetByName("Movimentações");
    if (!sheet) throw new Error("A aba Movimentações não foi encontrada.");
    if (!sheet.getRange(1, 10).getValue()) sheet.getRange(1, 10).setValue("Separada em");
    const last = sheet.getLastRow();
    const values = last > 1 ? sheet.getRange(2, 1, last - 1, 7).getValues() : [];
    const index = values.findIndex(row => row[0] === p.protocol);
    if (index < 0) throw new Error("Protocolo não encontrado.");
    if (values[index][6] !== "Pendente") throw new Error("Só é possível marcar separação em solicitações pendentes.");
    const cell = sheet.getRange(index + 2, 10);
    if (p.separated === false) cell.clearContent();
    else cell.setValue(new Date());
    return { ok: true, protocol: p.protocol, separated: p.separated !== false };
  } finally {
    lock.releaseLock();
  }
}

/* LIMITE SEMANAL E UTILITÁRIOS */

function getWithdrawalsThisWeek_(sheet, phone, now) {
  const last = sheet.getLastRow();
  if (last <= 1) return 0;
  const rows = sheet.getRange(2, 1, last - 1, 9).getValues();
  const currentWeek = weekKey_(now);

  return rows.reduce((sum, row) => {
    const date = row[1] instanceof Date ? row[1] : null;
    const sameParticipant = String(row[3]).replace(/\D/g, "") === phone;
    const sameWeek = date && weekKey_(date) === currentWeek;
    const approved = row[6] === "Aprovada";
    return sameParticipant && sameWeek && approved ? sum + (Number(row[4]) || 0) : sum;
  }, 0);
}

function weekKey_(date) {
  const parts = Utilities.formatDate(date, CONFIG.TIMEZONE, "yyyy-MM-dd").split("-").map(Number);
  const utcDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - day + 1);
  return Utilities.formatDate(utcDate, "UTC", "yyyy-MM-dd");
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(CONFIG.SPREADSHEET_PROPERTY);
  if (!id) throw new Error("Planilha não configurada. O identificador salvo não foi encontrado.");
  return SpreadsheetApp.openById(id);
}

function sha256_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"))
    .join("");
}

function responseHtml_(data) {
  const json = JSON.stringify(Object.assign({ type: "BULK_MOVEMENT_RESPONSE" }, data || {}))
    .replace(/</g, "\\u003c");
  const html = '<!doctype html><html><body><script>' +
    'window.top.postMessage(' + json + ', "*");' +
    '</script>Processado.</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
