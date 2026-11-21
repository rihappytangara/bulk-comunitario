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
  function cardImage(card, quality = "high") {
    if (!card.image) return "";
    return card.image.endsWith(".webp") ? card.image : `${card.image}/${quality}.webp`;
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

  /* Cache dos detalhes no aparelho (30 dias): visitas seguintes abrem quase instantâneas. */
  const CACHE_PREFIX = "bulk_card_v1_";
  const CACHE_DAYS = 30;
  function readCardCache(id) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + id);
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (Date.now() - item.t > CACHE_DAYS * 864e5) return null;
      return item.d;
    } catch (err) { return null; }
  }
  function writeCardCache(id, card) {
    try {
      const d = { id: card.id, name: card.name, localId: card.localId, image: card.image,
        category: card.category, types: card.types, set: card.set ? { id: card.set.id, name: card.set.name } : undefined };
      localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ t: Date.now(), d }));
    } catch (err) { /* armazenamento cheio ou bloqueado: segue sem cache */ }
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
      if (total("withdraw") >= (cfg.WEEKLY_LIMIT || 7)) { showMessage("Você já escolheu 7 cartas para retirar. Toque em Revisar e enviar para concluir."); return false; }
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
    if (type === "withdraw") {
      $("withdraw-count").textContent = total(type);
      scheduleStockRender();
    }
    updateActionBar();
  }

  /* ---------- Filtros locais do estoque ---------- */
  function plain(value) {
    return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }
  function stockFilters() {
    return {
      name: plain($("withdraw-name-search").value),
      collection: $("withdraw-collection-search").value,
      number: normalizeLocalId($("withdraw-number-search").value)
    };
  }
  /* ---------- Filtro por tipo ---------- */
  // A TCGdex devolve os tipos em português (pt) ou inglês (en); tudo vira o rótulo em português.
  const TYPE_ORDER = ["Planta", "Fogo", "Água", "Raio", "Psíquico", "Lutador", "Sombrio", "Incolor", "Dragão", "Metal", "Fada", "Treinador", "Energia"];
  const TYPE_ALIASES = {
    grass: "Planta", planta: "Planta", fire: "Fogo", fogo: "Fogo", water: "Água", agua: "Água",
    lightning: "Raio", eletrico: "Raio", raio: "Raio", psychic: "Psíquico", psiquico: "Psíquico",
    fighting: "Lutador", lutador: "Lutador", luta: "Lutador", darkness: "Sombrio", escuridao: "Sombrio", sombrio: "Sombrio",
    metal: "Metal", fairy: "Fada", fada: "Fada", dragon: "Dragão", dragao: "Dragão", colorless: "Incolor", incolor: "Incolor"
  };
  const TYPE_ICONS = { Planta: "🌿", Fogo: "🔥", "Água": "💧", "Raio": "⚡", "Psíquico": "🔮", Lutador: "👊", "Sombrio": "🌑", Metal: "⚙️", Fada: "✨", "Dragão": "🐉", Incolor: "⭐", Treinador: "🧑", Energia: "🔋" };
  state.typeFilter = "";

  function cardTypeLabel(card) {
    const category = plain(card.category);
    if (category.startsWith("trainer") || category.startsWith("treinador")) return "Treinador";
    if (category.startsWith("energ")) return "Energia";
    const type = Array.isArray(card.types) ? card.types[0] : "";
    return type ? (TYPE_ALIASES[plain(type)] || type) : "";
  }

  function renderTypeChips() {
    const box = $("type-chips");
    const counts = new Map();
    let identified = 0;
    state.stockCards.forEach(card => {
      if (!card.typeLabel) return;
      identified++;
      counts.set(card.typeLabel, (counts.get(card.typeLabel) || 0) + 1);
    });
    const labels = [...counts.keys()].sort((a, b) => {
      const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    if (state.typeFilter && !counts.has(state.typeFilter)) labels.push(state.typeFilter);
    const loading = state.stockCards.some(card => !card.detailDone);
    box.innerHTML =
      `<button type="button" class="type-chip${state.typeFilter ? "" : " active"}" data-type="">Todos</button>` +
      labels.map(label => `<button type="button" class="type-chip type-${escapeHtml(plain(label))}${state.typeFilter === label ? " active" : ""}" data-type="${escapeHtml(label)}">${TYPE_ICONS[label] || ""} ${escapeHtml(label)} <small>${counts.get(label) || 0}</small></button>`).join("") +
      (loading ? '<span class="type-loading">Identificando tipos…</span>' : "");
    box.querySelectorAll("[data-type]").forEach(button => button.addEventListener("click", () => {
      state.typeFilter = button.dataset.type;
      $("withdraw-stock-catalog").scrollTop = 0;
      resetRenderLimit();
      renderStockCatalog();
    }));
  }

  function filteredStockCards() {
    const f = stockFilters();
    return state.stockCards.filter(card =>
      (!f.name || plain(card.name).includes(f.name)) &&
      (!f.collection || card.sheetSetName === f.collection) &&
      (!f.number || normalizeLocalId(card.localId).startsWith(f.number)) &&
      (!state.typeFilter || card.typeLabel === state.typeFilter)
    );
  }
  function fillCollectionFilter() {
    const select = $("withdraw-collection-search");
    const current = select.value;
    const names = [...new Set(state.stockCards.map(card => card.sheetSetName).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    select.innerHTML = '<option value="">Todas as coleções</option>' +
      names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (names.includes(current)) select.value = current;
  }
  ["withdraw-name-search", "withdraw-number-search"].forEach(id => $(id).addEventListener("input", () => {
    $("withdraw-stock-catalog").scrollTop = 0;
    resetRenderLimit();
    renderStockCatalog();
  }));
  $("withdraw-collection-search").addEventListener("change", () => {
    $("withdraw-stock-catalog").scrollTop = 0;
    resetRenderLimit();
    renderStockCatalog();
  });
  $("clear-stock-filters").addEventListener("click", () => {
    $("withdraw-name-search").value = "";
    $("withdraw-number-search").value = "";
    $("withdraw-collection-search").value = "";
    state.typeFilter = "";
    resetRenderLimit();
    renderStockCatalog();
  });

  function stockButton(card) {
    const chosen = (state.withdraw.find(item => item.id === card.id) || {}).quantity || 0;
    const full = total("withdraw") >= (cfg.WEEKLY_LIMIT || 7);
    if (chosen >= card.stockQuantity) return `<button class="add-button added" type="button" disabled>✓ Na lista (${chosen})</button>`;
    if (full) return `<button class="add-button" type="button" disabled>Limite atingido</button>`;
    if (chosen) return `<button class="add-button added" type="button" data-stock-add="${escapeHtml(card.id)}">✓ ${chosen} · Adicionar +1</button>`;
    return `<button class="add-button" type="button" data-stock-add="${escapeHtml(card.id)}">Adicionar</button>`;
  }

  // Agrupa várias atualizações (ex.: imagens chegando) em uma única renderização.
  let stockRenderQueued = false;
  const PAGE_SIZE = 36;
  state.renderLimit = PAGE_SIZE;
  function resetRenderLimit() { state.renderLimit = PAGE_SIZE; }

  // Durante o carregamento dos detalhes, redesenha no máximo a cada 1,2 s.
  let throttledTimer = null;
  function scheduleThrottledRender() {
    if (throttledTimer) return;
    throttledTimer = setTimeout(() => { throttledTimer = null; renderStockCatalog(); }, 1200);
  }

  function scheduleStockRender() {
    if (stockRenderQueued) return;
    stockRenderQueued = true;
    requestAnimationFrame(() => { stockRenderQueued = false; renderStockCatalog(); });
  }

  function renderStockCatalog() {
    const container = $("withdraw-stock-catalog");
    if (!container || !state.stockReady) return;
    const all = state.stockCards;
    let cards = filteredStockCards();
    const f = stockFilters();
    const filtering = Boolean(f.name || f.collection || f.number || state.typeFilter);
    renderTypeChips();
    $("clear-stock-filters").hidden = !filtering;
    $("stock-filter-count").textContent = filtering
      ? `Mostrando ${cards.length} de ${all.length} carta(s)`
      : `${all.length} carta(s) disponível(is)`;

    if (!all.length) {
      container.innerHTML = '<div class="empty-state">Não há cartas disponíveis para retirada no momento.</div>';
      return;
    }
    if (!cards.length) {
      const waiting = state.typeFilter && state.stockCards.some(card => !card.detailDone);
      container.innerHTML = '<div class="empty-state">' + (waiting ? "Identificando os tipos das cartas… aguarde alguns segundos." : "Nenhuma carta do estoque corresponde aos filtros.") + "</div>";
      return;
    }
    const scroll = container.scrollTop;
    const total = cards.length;
    const listMode = state.stockView === "list";
    const limit = listMode ? state.renderLimit * 3 : state.renderLimit; // a lista em texto é mais leve
    const remaining = Math.max(0, total - limit);
    const moreButton = remaining
      ? `<button type="button" class="secondary-button load-more" data-load-more>Mostrar mais cartas (${remaining} restantes)</button>`
      : "";
    cards = cards.slice(0, limit);
    if (listMode) {
      container.innerHTML = '<div class="stock-list">' + cards.map(card => `
        <div class="stock-list-item">
          <div class="stock-list-info"><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.set?.name || "Coleção não informada")} · nº ${escapeHtml(card.localId || "—")} · Disponíveis: ${card.stockQuantity}</small></div>
          ${stockButton(card)}
        </div>`).join("") + "</div>" + moreButton;
    } else {
      container.innerHTML = '<div class="stock-grid">' + cards.map(card => `
        <article class="stock-card">
          <img src="${escapeHtml(cardImage(card, "low"))}" alt="Carta ${escapeHtml(card.name)}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">
          <strong>${escapeHtml(card.name)}</strong>
          <small>${escapeHtml(card.set?.name || "Coleção não informada")} · nº ${escapeHtml(card.localId || "—")}</small>
          <span class="stock-quantity">${card.stockQuantity} disponível(is)</span>
          ${stockButton(card)}
        </article>`).join("") + "</div>" + moreButton;
    }
    container.scrollTop = scroll;
    const more = container.querySelector("[data-load-more]");
    if (more) {
      more.addEventListener("click", () => { state.renderLimit += PAGE_SIZE; renderStockCatalog(); });
      // Carrega o próximo bloco sozinho quando o botão aparece na rolagem.
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) { io.disconnect(); state.renderLimit += PAGE_SIZE; renderStockCatalog(); }
        }, { root: container, rootMargin: "200px" });
        io.observe(more);
      }
    }
    container.querySelectorAll("[data-stock-add]").forEach(button => button.addEventListener("click", () => {
      const card = state.stockCards.find(item => item.id === button.dataset.stockAdd);
      if (card) addCard("withdraw", card);
    }));
  }

  /* ---------- Barra fixa "Revisar e enviar" ---------- */
  let submitAreaVisible = false;
  function updateActionBar() {
    const bar = $("action-bar");
    const out = total("withdraw");
    const inn = total("deposit");
    $("bar-withdraw").textContent = out;
    $("bar-deposit").textContent = inn;
    bar.classList.toggle("full", out >= (cfg.WEEKLY_LIMIT || 7));
    const show = (out + inn) > 0 && !form.hidden && !submitAreaVisible;
    bar.hidden = !show;
    document.body.classList.toggle("has-action-bar", show);
  }
  $("go-to-submit").addEventListener("click", () => {
    // 1º toque: leva à revisão das cartas. Se já estiver nela, leva à declaração/envio.
    const reviewTop = $("review-anchor").getBoundingClientRect().top;
    if (reviewTop < window.innerHeight * 0.35) {
      document.querySelector(".declaration").scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      $("review-anchor").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(entries => {
      submitAreaVisible = entries.some(entry => entry.isIntersecting);
      updateActionBar();
    }).observe(document.querySelector(".form-footer"));
  }

  document.querySelectorAll("[data-stock-view]").forEach(button => button.addEventListener("click", () => {
    state.stockView = button.dataset.stockView;
    document.querySelectorAll("[data-stock-view]").forEach(item => item.classList.toggle("active", item === button));
    renderStockCatalog();
  }));

  let stockFrame = null;
  let stockLoadTimer = null;

  function handlePublicStock(data) {
    clearTimeout(stockLoadTimer);
    if (stockFrame) {
      stockFrame.remove();
      stockFrame = null;
    }

    if (data && data.ok === true && Array.isArray(data.stock)) {
      const availableStock = data.stock.filter(item => Number(item.quantity) > 0);
      state.stockById = new Map(availableStock.map(item => [String(item.id), Number(item.quantity) || 0]));
      state.stockReady = true;
      state.stockCards = availableStock.map(item => ({
        id: String(item.id),
        name: String(item.name || item.id),
        localId: String(item.localId || ""),
        set: { name: String(item.setName || "") },
        sheetSetName: String(item.setName || "").trim(),
        lang: "pt",
        stockQuantity: Number(item.quantity) || 0
      }));
      fillCollectionFilter();
      renderStockCatalog();

      // Os detalhes e imagens são complementares. A lista básica da planilha
      // aparece primeiro e não depende da TCGdex para funcionar.
      const loadingList = state.stockCards;
      const applyDetail = (base, index, detail) => {
          if (state.stockCards !== loadingList) return; // o estoque foi recarregado
          state.stockCards[index] = {
            ...base,
            ...detail,
            id: base.id,
            name: detail.name || base.name,
            localId: detail.localId || base.localId,
            set: detail.set || base.set,
            sheetSetName: base.sheetSetName,
            stockQuantity: base.stockQuantity,
            typeLabel: cardTypeLabel(detail),
            detailDone: true
          };
      };

      // Primeiro aplica o que já está guardado no aparelho (visitas anteriores).
      const queue = [];
      loadingList.forEach((base, index) => {
        const cached = readCardCache(base.id);
        if (cached) applyDetail(base, index, cached);
        else queue.push(index);
      });
      renderStockCatalog();

      // Depois busca o restante na TCGdex, poucas consultas por vez (leve para Android).
      const WORKERS = 8;
      const worker = async () => {
        while (queue.length && state.stockCards === loadingList) {
          const index = queue.shift();
          const base = loadingList[index];
          try {
            const detail = await Promise.race([
              getCardDetails(base),
              new Promise(resolve => setTimeout(() => resolve(null), 12000))
            ]);
            if (detail && detail !== base && detail.name) {
              writeCardCache(base.id, detail);
              applyDetail(base, index, detail);
            } else if (state.stockCards === loadingList) {
              state.stockCards[index] = { ...state.stockCards[index], detailDone: true };
            }
          } catch (err) {
            if (state.stockCards === loadingList) state.stockCards[index] = { ...state.stockCards[index], detailDone: true };
          }
          scheduleThrottledRender();
        }
      };
      for (let i = 0; i < WORKERS; i++) worker();
    } else {
      state.stockReady = false;
      $("withdraw-stock-catalog").innerHTML = '<div class="empty-state">Não foi possível ler os dados do estoque. Atualize a página e tente novamente.</div>';
    }
  }

  // Recebe a resposta do HtmlService via postMessage. O identificador aleatório
  // impede que respostas atrasadas de consultas anteriores sejam aproveitadas.
  window.addEventListener("message", event => {
    const data = event && event.data;
    if (!data || data.type !== "BULK_STOCK_RESPONSE") return;
    if (!state.stockRequestId || data.requestId !== state.stockRequestId) return;
    handlePublicStock(data);
  });

  function loadPublicStock() {
    const container = $("withdraw-stock-catalog");
    if (!container) return;
    if (!cfg.APPS_SCRIPT_URL || !/^https:\/\//i.test(cfg.APPS_SCRIPT_URL)) {
      container.innerHTML = '<div class="empty-state">Endereço do serviço de estoque não configurado.</div>';
      return;
    }

    clearTimeout(stockLoadTimer);
    if (stockFrame) stockFrame.remove();
    state.stockReady = false;
    state.stockRequestId = `stock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    container.innerHTML = '<div class="empty-state">Carregando cartas disponíveis...</div>';

    try {
      const url = new URL(cfg.APPS_SCRIPT_URL);
      url.searchParams.set("action", "stock");
      url.searchParams.set("requestId", state.stockRequestId);
      url.searchParams.set("_", String(Date.now()));

      stockFrame = document.createElement("iframe");
      stockFrame.title = "Consulta de estoque";
      stockFrame.setAttribute("aria-hidden", "true");
      stockFrame.style.position = "absolute";
      stockFrame.style.width = "1px";
      stockFrame.style.height = "1px";
      stockFrame.style.border = "0";
      stockFrame.style.opacity = "0";
      stockFrame.style.pointerEvents = "none";
      stockFrame.src = url.toString();
      document.body.appendChild(stockFrame);

      stockLoadTimer = setTimeout(() => {
        if (state.stockRequestId && !state.stockReady) {
          if (stockFrame) stockFrame.remove();
          stockFrame = null;
          container.innerHTML = '<div class="empty-state">Não foi possível conectar ao estoque. Atualize a página e tente novamente.</div>';
        }
      }, 18000);
    } catch (error) {
      container.innerHTML = '<div class="empty-state">Não foi possível iniciar a consulta ao estoque. Atualize a página e tente novamente.</div>';
    }
  }

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
    if (data.requestId !== state.requestId) return;
    clearTimeout(state.submitTimer);
    submitButton.disabled = false;
    submitButton.querySelector("span").textContent = "Registrar movimentação";
    if (data.ok) {
      $("protocol-number").textContent = data.protocol || "Registrado";
      form.hidden = true;
      $("success-panel").hidden = false;
      updateActionBar();
      window.scrollTo({top:0,behavior:"smooth"});
    } else {
      showMessage(data.message || "Não foi possível registrar. Confira os dados e tente novamente.");
    }
  });

  $("new-movement").addEventListener("click", () => {
    form.reset();
    state.withdraw = []; state.deposit = []; state.requestId = null;
    renderSelected("withdraw"); renderSelected("deposit");
    $("deposit-results").innerHTML = "";
    $("withdraw-name-search").value = ""; $("withdraw-collection-search").value = ""; $("withdraw-number-search").value = "";
    $("deposit-name-search").value = ""; $("deposit-collection-search").value = ""; $("deposit-number-search").value = "";
    $("success-panel").hidden = true; form.hidden = false; showMessage("");
    updateActionBar(); loadPublicStock(); // recarrega: a solicitação anterior reservou cartas
    window.scrollTo({top:0,behavior:"smooth"});
  });
})();
