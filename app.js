(() => {
  "use strict";
  const cfg = window.BULK_CONFIG || {};
  const API = "https://api.tcgdex.net/v2/";
  const state = { withdraw: [], deposit: [], searchTimers: {}, requestId: null, submitTimer: null, stockRequestId: null, stockReady: false, stockById: new Map(), stockCards: [], stockView: "grid" };
  const $ = (id) => document.getElementById(id);

  const form = $("movement-form");
  const submitButton = $("submit-button");
  const message = $("form-message");

  function normalizePhone(value) { return (value || "").replace(/\D/g, "").slice(0, 13); }
  $("participant-phone").addEventListener("input", e => {
    const digits = normalizePhone(e.target.value);
    if (digits.length <= 10) {
      e.target.value = digits.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2");
    } else {
      e.target.value = digits.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2");
    }
  });

  function showMessage(text, kind="error") {
    message.textContent = text;
    message.className = "form-message" + (kind === "ok" ? " ok" : "");
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }
  function cardImage(card) {
    if (!card.image) return "";
    return card.image.endsWith(".webp") ? card.image : `${card.image}/high.webp`;
  }
  function cardSetLabel(card) {
    return card.set?.name || card.set?.id || "Coleção não informada";
  }

  function normalizeLocalId(value) {
    const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
    const id = raw.split("/")[0];
    return /^\d+$/.test(id) ? String(Number(id)) : id;
  }

  async function searchCards(nameQuery, collectionQuery, numberQuery) {
    const name = String(nameQuery || "").trim();
    const collection = String(collectionQuery || "").trim();
    const number = String(numberQuery || "").trim();
    const localId = normalizeLocalId(number);
    if ((!name || name.length < 2) && !collection && !localId) return [];

    for (const lang of (cfg.TCGDEX_LANGUAGES || ["pt", "en"])) {
      try {
        let cards = [];

        if (collection) {
          // Primeiro localiza as coleções pelo nome; depois consulta as cartas
          // de cada coleção, o que também contempla numerações promocionais.
          const setParams = new URLSearchParams();
          setParams.set("name", collection);
          setParams.set("pagination:page", "1");
          setParams.set("pagination:itemsPerPage", "30");
          const setResponse = await fetch(`${API}${lang}/sets?${setParams.toString()}`);
          if (!setResponse.ok) continue;
          const sets = await setResponse.json();
          if (!Array.isArray(sets) || !sets.length) continue;

          const fullSets = await Promise.all(sets.slice(0, 15).map(async set => {
            try {
              const response = await fetch(`${API}${lang}/sets/${encodeURIComponent(set.id)}`);
              return response.ok ? await response.json() : null;
            } catch (err) { return null; }
          }));

          cards = fullSets.filter(Boolean).flatMap(set =>
            (set.cards || []).map(card => ({
              ...card,
              set: { id: set.id, name: set.name },
              lang
            }))
          );
        } else {
          const params = new URLSearchParams();
          if (name) params.set("name", name);
          if (localId) params.set("localId", localId);
          params.set("pagination:page", "1");
          params.set("pagination:itemsPerPage", "100");
          const response = await fetch(`${API}${lang}/cards?${params.toString()}`);
          if (!response.ok) continue;
          const data = await response.json();
          if (!Array.isArray(data)) continue;
          cards = data.map(card => ({ ...card, lang }));
        }

        const normalizedCollection = collection.toLocaleLowerCase();
        const normalizedName = name.toLocaleLowerCase();
        const matches = cards.filter(card => {
          const cardName = String(card.name || "").toLocaleLowerCase();
          const setName = String(card.set?.name || "").toLocaleLowerCase();
          return (!normalizedName || cardName.includes(normalizedName)) &&
            (!localId || normalizeLocalId(card.localId) === localId) &&
            (!normalizedCollection || setName.includes(normalizedCollection));
        });
        if (matches.length) return matches.slice(0, 40);
      } catch (err) { /* tenta o próximo idioma */ }
    }
    return [];
  }

  async function getCardDetails(card) {
    if (card.set && card.category) return card;
    for (const lang of [card.lang || "pt", "en"]) {
      try {
        const response = await fetch(`${API}${lang}/cards/${encodeURIComponent(card.id)}`);
        if (response.ok) return await response.json();
      } catch (err) {}
    }
    return card;
  }

  function renderResults(type, cards) {
    const container = $(type + "-results");
    if (!cards.length) {
      container.innerHTML = '<div class="empty-state">Nenhuma carta encontrada. Tente outro nome.</div>';
      return;
    }
    container.innerHTML = cards.map((card, i) => `
      <div class="result-card">
        <img src="${escapeHtml(cardImage(card))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="result-info">
          <strong>${escapeHtml(card.name)}</strong>
          <small>Nº ${escapeHtml(card.localId || "—")} · ${escapeHtml(cardSetLabel(card))}</small>
        </div>
        <button class="add-button" type="button" data-add="${i}">Adicionar</button>
      </div>`).join("");
    [...container.querySelectorAll("[data-add]")].forEach(button => {
      button.addEventListener("click", async () => {
        const card = await getCardDetails(cards[Number(button.dataset.add)]);
        if (!addCard(type, card)) return;
        $(type + "-name-search").value = "";
        $(type + "-collection-search").value = "";
        $(type + "-number-search").value = "";
        container.innerHTML = "";
      });
    });
  }

  function setupSearch(type) {
    const nameInput = $(type + "-name-search");
    const collectionInput = $(type + "-collection-search");
    const numberInput = $(type + "-number-search");
    const target = $(type + "-results");
    const runSearch = () => {
      clearTimeout(state.searchTimers[type]);
      const name = nameInput.value.trim();
      const collection = collectionInput.value.trim();
      const number = numberInput.value.trim();
      if (!name && !collection && !number) { target.innerHTML = ""; return; }
      if (name && name.length < 2 && !collection && !number) { target.innerHTML = ""; return; }
      target.innerHTML = '<div class="empty-state">Pesquisando no catálogo Pokémon...</div>';
      state.searchTimers[type] = setTimeout(async () => {
        try {
          let cards = await searchCards(name, collection, number);
          if (type === "withdraw") {
            if (!state.stockReady) { target.innerHTML = '<div class="empty-state">Consultando disponibilidade do estoque...</div>'; return; }
            cards = cards.filter(card => (state.stockById.get(String(card.id)) || 0) > 0);
          }
          renderResults(type, cards);
        }
        catch { target.innerHTML = '<div class="empty-state">Não foi possível consultar o catálogo agora. Tente novamente.</div>'; }
      }, 350);
    };
    nameInput.addEventListener("input", runSearch);
    collectionInput.addEventListener("input", runSearch);
    numberInput.addEventListener("input", runSearch);
  }

  function addCard(type, card) {
    const list = state[type];
    const existing = list.find(item => item.id === card.id);
    if (type === "withdraw") {
      const available = state.stockById.get(String(card.id)) || 0;
      if (!state.stockReady || available <= 0) { showMessage("Esta carta não possui unidades disponíveis no estoque."); return false; }
      if ((existing ? existing.quantity : 0) >= available) { showMessage("Quantidade disponível para esta carta: " + available + "."); return false; }
    }
    if (existing) existing.quantity += 1;
    else list.push({
      id: card.id, name: card.name, localId: card.localId || "",
      setName: cardSetLabel(card), image: cardImage(card), quantity: 1
    });
    renderSelected(type);
    return true;
  }

  function total(type) { return state[type].reduce((sum, item) => sum + item.quantity, 0); }

  function renderSelected(type) {
    const container = $(type + "-selected");
    const list = state[type];
    if (!list.length) {
      container.className = "selected-list empty-state";
      container.textContent = type === "withdraw" ? "Nenhuma carta selecionada para retirada." : "Nenhuma carta selecionada para entrada.";
    } else {
      container.className = "selected-list";
      container.innerHTML = list.map((item, i) => `
        <div class="selected-item">
          <img src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="selected-info">
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.setName)} · nº ${escapeHtml(item.localId || "—")}</small>
          </div>
          <div class="quantity-controls">
            <button type="button" data-action="minus" data-index="${i}" aria-label="Diminuir">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-action="plus" data-index="${i}" aria-label="Aumentar">+</button>
          </div>
          <button class="remove-button" type="button" data-action="remove" data-index="${i}" aria-label="Remover">×</button>
        </div>`).join("");
      container.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => {
        const index = Number(button.dataset.index);
        const action = button.dataset.action;
        if (action === "minus") list[index].quantity -= 1;
        if (action === "plus") {
          if (type === "withdraw") {
            const available = state.stockById.get(String(list[index].id)) || 0;
            if (list[index].quantity >= available) { showMessage("Quantidade disponível para esta carta: " + available + "."); return; }
          }
          list[index].quantity += 1;
        }
        if (action === "remove" || list[index].quantity <= 0) list.splice(index, 1);
        if (type === "withdraw" && total(type) > (cfg.WEEKLY_LIMIT || 7)) {
          list[index].quantity -= 1;
          if (list[index].quantity <= 0) list.splice(index, 1);
          showMessage("O limite de retirada é de 7 cartas por movimentação. O limite semanal total também será conferido no envio.");
        }
        renderSelected(type);
      }));
    }
    if (type === "withdraw") $("withdraw-count").textContent = total(type);
  }

  function renderStockCatalog() {
    const container = $("withdraw-stock-catalog");
    if (!container || !state.stockReady) return;
    const cards = state.stockCards;
    if (!cards.length) {
      container.innerHTML = '<div class="empty-state">Não há cartas disponíveis para retirada no momento.</div>';
      return;
    }
    if (state.stockView === "list") {
      container.innerHTML = '<div class="stock-list">' + cards.map((card, i) => `
        <div class="stock-list-item">
          <div class="stock-list-info"><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.set?.name || "Coleção não informada")} · nº ${escapeHtml(card.localId || "—")} · Disponíveis: ${card.stockQuantity}</small></div>
          <button class="add-button" type="button" data-stock-add="${i}">Adicionar</button>
        </div>`).join("") + "</div>";
    } else {
      container.innerHTML = '<div class="stock-grid">' + cards.map((card, i) => `
        <article class="stock-card">
          <img src="${escapeHtml(cardImage(card))}" alt="Carta ${escapeHtml(card.name)}" loading="lazy" onerror="this.style.visibility='hidden'">
          <strong>${escapeHtml(card.name)}</strong>
          <small>${escapeHtml(card.set?.name || "Coleção não informada")} · nº ${escapeHtml(card.localId || "—")}</small>
          <span class="stock-quantity">${card.stockQuantity} disponível(is)</span>
          <button class="add-button" type="button" data-stock-add="${i}">Adicionar</button>
        </article>`).join("") + "</div>";
    }
    container.querySelectorAll("[data-stock-add]").forEach(button => button.addEventListener("click", () => {
      const card = cards[Number(button.dataset.stockAdd)];
      addCard("withdraw", card);
    }));
  }

  document.querySelectorAll("[data-stock-view]").forEach(button => button.addEventListener("click", () => {
    state.stockView = button.dataset.stockView;
    document.querySelectorAll("[data-stock-view]").forEach(item => item.classList.toggle("active", item === button));
    renderStockCatalog();
  }));

  function loadPublicStock() {
    state.stockRequestId = "stock-" + Date.now();
    $("transport-payload").value = JSON.stringify({ action: "stock", requestId: state.stockRequestId });
    $("transport-form").action = cfg.APPS_SCRIPT_URL;
    $("transport-form").submit();
  }

  const searchToggle = $("toggle-withdraw-search");
  searchToggle.addEventListener("click", () => {
    const panel = $("withdraw-search-panel");
    const opening = panel.hidden;
    panel.hidden = !opening;
    searchToggle.setAttribute("aria-expanded", String(opening));
    searchToggle.textContent = opening ? "Fechar pesquisa" : "Pesquisar carta específica";
  });

  setupSearch("withdraw");
  setupSearch("deposit");
  loadPublicStock();

  function collectPayload() {
    return {
      requestId: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name: $("participant-name").value.trim(),
      phone: normalizePhone($("participant-phone").value),
      withdrawals: state.withdraw.map(({id,name,localId,setName,quantity}) => ({id,name,localId,setName,quantity})),
      deposits: state.deposit.map(({id,name,localId,setName,quantity}) => ({id,name,localId,setName,quantity})),
      declaration: $("declaration").checked,
      website: $("website").value
    };
  }

  function validPayload(p) {
    if (p.name.length < 3) return "Informe seu nome completo.";
    if (p.phone.length < 10) return "Informe um telefone válido com DDD.";
    if (!p.withdrawals.length && !p.deposits.length) return "Adicione pelo menos uma carta para registrar a movimentação.";
    if (p.withdrawals.reduce((s,c)=>s+c.quantity,0) > 7) return "Você pode selecionar no máximo 7 cartas para retirar nesta movimentação.";
    if (!p.declaration) return "É necessário confirmar a declaração sobre a qualidade das cartas.";
    if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.includes("COLE_AQUI")) return "O site ainda não foi conectado ao Google Apps Script. Consulte o arquivo README.";
    return "";
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    showMessage("");
    const payload = collectPayload();
    const error = validPayload(payload);
    if (error) { showMessage(error); return; }
    state.requestId = payload.requestId;
    submitButton.disabled = true;
    submitButton.querySelector("span").textContent = "Enviando...";
    showMessage("Enviando movimentação com segurança...", "ok");
    $("transport-payload").value = JSON.stringify(payload);
    $("transport-form").action = cfg.APPS_SCRIPT_URL;
    $("transport-form").submit();

    // Não deixa a interface presa indefinidamente caso o Apps Script não
    // devolva a confirmação via postMessage.
    clearTimeout(state.submitTimer);
    state.submitTimer = setTimeout(() => {
      if (!state.requestId) return;
      submitButton.disabled = false;
      submitButton.querySelector("span").textContent = "Registrar movimentação";
      showMessage("Não recebemos a confirmação do Google Sheets. A movimentação pode ou não ter sido registrada. Antes de enviar novamente, confira a planilha ou fale com a equipe da loja.");
      state.requestId = null;
    }, 30000);
  });

  window.addEventListener("message", async event => {
    const data = event.data;
    if (!data || data.type !== "BULK_MOVEMENT_RESPONSE") return;
    if (state.stockRequestId && data.requestId === state.stockRequestId) {
      state.stockRequestId = null;
      if (data.ok && Array.isArray(data.stock)) {
        state.stockById = new Map(data.stock.map(item => [String(item.id), Number(item.quantity) || 0]));
        state.stockReady = true;
        // Exibe primeiro os dados da planilha: o catálogo textual não depende da API TCGdex.
        state.stockCards = data.stock.map(item => ({
          id: String(item.id),
          name: String(item.name || item.id),
          localId: String(item.localId || ""),
          set: { name: String(item.setName || "") },
          lang: "pt",
          stockQuantity: Number(item.quantity) || 0
        }));
        renderStockCatalog();

        // Enriquece as cartas com imagens e metadados em segundo plano.
        state.stockCards.forEach(async (base, index) => {
          try {
            const detail = await Promise.race([
              getCardDetails(base),
              new Promise(resolve => setTimeout(() => resolve(base), 5000))
            ]);
            state.stockCards[index] = {
              ...base,
              ...detail,
              id: base.id,
              name: detail.name || base.name,
              localId: detail.localId || base.localId,
              set: detail.set || base.set,
              stockQuantity: base.stockQuantity
            };
            renderStockCatalog();
          } catch (err) {
            // Mantém os dados textuais da planilha mesmo se a API falhar.
          }
        });
      } else {
        state.stockReady = false;
        $("withdraw-results").innerHTML = '<div class="empty-state">Não foi possível carregar o estoque. Atualize a página ou tente novamente mais tarde.</div>';
      }
      return;
    }
    if (data.requestId !== state.requestId) return;
    clearTimeout(state.submitTimer);
    submitButton.disabled = false;
    submitButton.querySelector("span").textContent = "Registrar movimentação";
    if (data.ok) {
      $("protocol-number").textContent = data.protocol || "Registrado";
      form.hidden = true;
      $("success-panel").hidden = false;
      window.scrollTo({top:0,behavior:"smooth"});
    } else {
      showMessage(data.message || "Não foi possível registrar. Confira os dados e tente novamente.");
    }
  });

  $("new-movement").addEventListener("click", () => {
    form.reset();
    state.withdraw = []; state.deposit = []; state.requestId = null;
    renderSelected("withdraw"); renderSelected("deposit");
    $("withdraw-results").innerHTML = ""; $("deposit-results").innerHTML = "";
    $("withdraw-name-search").value = ""; $("withdraw-collection-search").value = ""; $("withdraw-number-search").value = "";
    $("deposit-name-search").value = ""; $("deposit-collection-search").value = ""; $("deposit-number-search").value = "";
    $("success-panel").hidden = true; form.hidden = false; showMessage("");
    window.scrollTo({top:0,behavior:"smooth"});
  });
})();
