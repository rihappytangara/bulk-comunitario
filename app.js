(() => {
  "use strict";
  const cfg = window.BULK_CONFIG || {};
  const API = "https://api.tcgdex.net/v2/";
  const state = { withdraw: [], deposit: [], searchTimers: {}, requestId: null };
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

  async function searchCards(query) {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    for (const lang of (cfg.TCGDEX_LANGUAGES || ["pt","en"])) {
      try {
        const url = `${API}${lang}/cards?name=${encodeURIComponent(trimmed)}&pagination:page=1&pagination:itemsPerPage=24`;
        const response = await fetch(url);
        if (!response.ok) continue;
        const cards = await response.json();
        if (Array.isArray(cards) && cards.length) return cards.slice(0, 24).map(c => ({...c, lang}));
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
          <small>Carta nº ${escapeHtml(card.localId || "—")} · ID ${escapeHtml(card.id)}</small>
        </div>
        <button class="add-button" type="button" data-add="${i}">Adicionar</button>
      </div>`).join("");
    [...container.querySelectorAll("[data-add]")].forEach(button => {
      button.addEventListener("click", async () => {
        const card = await getCardDetails(cards[Number(button.dataset.add)]);
        addCard(type, card);
        $(type + "-search").value = "";
        container.innerHTML = "";
      });
    });
  }

  function setupSearch(type) {
    const input = $(type + "-search");
    input.addEventListener("input", () => {
      clearTimeout(state.searchTimers[type]);
      const q = input.value.trim();
      const target = $(type + "-results");
      if (q.length < 2) { target.innerHTML = ""; return; }
      target.innerHTML = '<div class="empty-state">Pesquisando no catálogo Pokémon...</div>';
      state.searchTimers[type] = setTimeout(async () => {
        try { renderResults(type, await searchCards(q)); }
        catch { target.innerHTML = '<div class="empty-state">Não foi possível consultar o catálogo agora. Tente novamente.</div>'; }
      }, 350);
    });
  }

  function addCard(type, card) {
    const list = state[type];
    const existing = list.find(item => item.id === card.id);
    if (existing) existing.quantity += 1;
    else list.push({
      id: card.id, name: card.name, localId: card.localId || "",
      setName: cardSetLabel(card), image: cardImage(card), quantity: 1
    });
    renderSelected(type);
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
        if (action === "plus") list[index].quantity += 1;
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

  setupSearch("withdraw");
  setupSearch("deposit");

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
  });

  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || data.type !== "BULK_MOVEMENT_RESPONSE" || data.requestId !== state.requestId) return;
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
    $("success-panel").hidden = true; form.hidden = false; showMessage("");
    window.scrollTo({top:0,behavior:"smooth"});
  });
})();
