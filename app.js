const DB_NAME = "knit-log-db";
const DB_VERSION = 2;
let db;
let activeFilter = "all";
let sortMode = "date-desc";
let toastTimer;
let editingProductId = null;
let editingPersonId = null;
const liveUrls = new Set();

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("products")) d.createObjectStore("products", { keyPath: "id" });
      if (!d.objectStoreNames.contains("people")) d.createObjectStore("people", { keyPath: "id" });
      if (!d.objectStoreNames.contains("notes")) d.createObjectStore("notes", { keyPath: "id" });
      if (!d.objectStoreNames.contains("deletions")) d.createObjectStore("deletions", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function store(name, mode = "readonly") { return db.transaction(name, mode).objectStore(name); }
function all(name) {
  return new Promise((resolve, reject) => {
    const r = store(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
function put(name, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readwrite");
    tx.objectStore(name).put(value);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
function remove(name, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readwrite"); tx.objectStore(name).delete(id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Транзакция отменена"));
  });
}
function makeTombstone(type, recordId, deletedAt = Date.now()) {
  return { id: `${type}:${recordId}`, type, recordId, deletedAt };
}
function uid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
function escapeHTML(s = "") { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function showToast(message) { const el = document.getElementById("toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600); }
function openDialog(id) { document.getElementById(id).showModal(); }
function closeDialog(id) { const el = document.getElementById(id); if (el?.open) el.close(); }
function statusLabel(s) { return s === "done" ? "Готово" : "В процессе"; }
function makeUrl(blob) { if (!blob) return ""; const url = URL.createObjectURL(blob); liveUrls.add(url); return url; }
function clearLiveUrls() { for (const url of liveUrls) URL.revokeObjectURL(url); liveUrls.clear(); }

async function render() {
  clearLiveUrls();
  const [products, people] = await Promise.all([all("products"), all("people")]);
  document.getElementById("stat-all").textContent = products.length;
  document.getElementById("stat-done").textContent = products.filter(p => p.status === "done").length;
  document.getElementById("stat-progress").textContent = products.filter(p => p.status !== "done").length;
  const filtered = products.filter(p => activeFilter === "all" || p.status === activeFilter);
  const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
  const byOldest = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const grid = document.getElementById("product-grid");
  const renderCard = p => {
    const photo = p.photos?.[0];
    const thumb = photo?.thumbBlob || photo?.originalBlob || photo?.blob;
    const src = thumb ? makeUrl(thumb) : "";
    return `<article class="product-card" data-product="${escapeHTML(p.id)}" tabindex="0" role="button" aria-label="Открыть ${escapeHTML(p.name)}">
      <div class="product-image">${src ? `<img src="${src}" alt="${escapeHTML(p.name)}">` : "✳"}</div>
      <span class="status-badge ${p.status === "done" ? "done" : "progress"}">${statusLabel(p.status)}</span>
      <button class="card-delete" type="button" data-delete-product="${escapeHTML(p.id)}" aria-label="Удалить изделие" title="Удалить изделие">×</button>
      <div class="product-info"><h3>${escapeHTML(p.name)}</h3><p>${escapeHTML(p.description || "Без описания")}</p></div>
    </article>`;
  };
  let cardsMarkup = "";
  if (sortMode === "person") {
    const personById = new Map(people.map(person => [person.id, person]));
    const groups = new Map();
    for (const product of filtered) {
      const person = personById.get(product.personId);
      const key = person ? person.id : "__unassigned__";
      if (!groups.has(key)) groups.set(key, { name: person?.name || "Без привязки", products: [] });
      groups.get(key).products.push(product);
    }
    const orderedGroups = [...groups.entries()].sort((a, b) => {
      if (a[0] === "__unassigned__") return 1;
      if (b[0] === "__unassigned__") return -1;
      return a[1].name.localeCompare(b[1].name, "ru");
    });
    cardsMarkup = orderedGroups.map(([, group]) =>
      `<div class="product-group-heading"><span>${escapeHTML(group.name)}</span><span>${group.products.length} ${group.products.length === 1 ? "изделие" : "изделий"}</span></div>` +
      group.products.sort(byNewest).map(renderCard).join("")
    ).join("");
  } else {
    filtered.sort(sortMode === "date-asc" ? byOldest : byNewest);
    cardsMarkup = filtered.map(renderCard).join("");
  }
  grid.innerHTML = cardsMarkup;
  document.getElementById("product-count").textContent = `${filtered.length} записей`;
  document.getElementById("product-sort").value = sortMode;
  document.getElementById("empty-state").style.display = filtered.length ? "none" : "block";
  grid.style.display = filtered.length ? "grid" : "none";
  document.getElementById("people-list").innerHTML = people.map(p => `<div class="person-row"><span class="avatar">♙</span><button class="person-edit" type="button" data-edit-person="${escapeHTML(p.id)}">${escapeHTML(p.name)}</button><button class="person-delete" type="button" data-delete-person="${escapeHTML(p.id)}" aria-label="Удалить профиль ${escapeHTML(p.name)}" title="Удалить профиль">×</button></div>`).join("") || `<p class="field-hint">Пока нет сохранённых профилей.</p>`;
  document.getElementById("product-person").innerHTML = `<option value="">Не указано</option>` + people.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`).join("");
  document.getElementById("note-product").innerHTML = products.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`).join("");
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.filter === activeFilter));
  document.querySelectorAll(".bottom-item[data-filter]").forEach(b => b.classList.toggle("active", b.dataset.filter === activeFilter));
}

async function deleteProduct(id) {
  const p = (await all("products")).find(x => x.id === id); if (!p) return;
  if (!confirm(`Удалить изделие «${p.name}» и все связанные с ним заметки? Это действие нельзя отменить.`)) return;
  const notes = (await all("notes")).filter(n => n.productId === id);
  const tx = db.transaction(["products", "notes", "deletions"], "readwrite");
  tx.objectStore("products").delete(id);
  tx.objectStore("deletions").put(makeTombstone("products", id));
  for (const n of notes) {
    tx.objectStore("notes").delete(n.id);
    tx.objectStore("deletions").put(makeTombstone("notes", n.id));
  }
  await transactionDone(tx);
  closeDialog("detail-dialog"); await render(); showToast("Изделие удалено");
}
async function deletePerson(id) {
  const person = (await all("people")).find(x => x.id === id); if (!person) return;
  const linked = (await all("products")).filter(p => p.personId === id);
  const extra = linked.length ? `\n\nК этому профилю привязано изделий: ${linked.length}. Они останутся в каталоге, но привязка будет снята.` : "";
  if (!confirm(`Удалить профиль «${person.name}»?${extra}\n\nЭто действие нельзя отменить.`)) return;
  const tx = db.transaction(["people", "products", "deletions"], "readwrite");
  tx.objectStore("people").delete(id);
  tx.objectStore("deletions").put(makeTombstone("people", id));
  for (const product of linked) { product.personId = ""; product.updatedAt = Date.now(); tx.objectStore("products").put(product); }
  await transactionDone(tx);
  await render(); showToast("Профиль удалён");
}

async function imageVariants(file) {
  const bitmap = await createImageBitmap(file);
  const max = 900, scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
  const thumbBlob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("Не удалось обработать фотографию")), "image/jpeg", 0.82));
  return { name: file.name, type: file.type, originalBlob: file, thumbBlob };
}
function setProductForm(p = null) {
  const form = document.getElementById("product-form"); form.reset(); editingProductId = p?.id || null;
  form.elements.name.value = p?.name || ""; form.elements.status.value = p?.status || "progress";
  form.elements.personId.value = p?.personId || ""; form.elements.description.value = p?.description || "";
  const knitting = form.elements.knitting; if (knitting) knitting.value = p?.knitting || "";
  document.getElementById("product-dialog-title").textContent = p ? "Редактировать изделие" : "Добавить изделие";
  document.getElementById("product-dialog-eyebrow").textContent = p ? "ИЗМЕНЕНИЕ ЗАПИСИ" : "НОВАЯ ЗАПИСЬ";
  document.getElementById("product-save-label").textContent = p ? "Сохранить изменения" : "Сохранить изделие";
  const hint = document.getElementById("existing-photo-hint");
  hint.textContent = p?.photos?.length ? `Сейчас прикреплено фото: ${p.photos.length}. Если выбрать новые фотографии, они добавятся к существующим.` : "";
  document.getElementById("product-photos").value = "";
}
async function openProduct(id) {
  const p = (await all("products")).find(x => x.id === id); if (!p) return;
  const person = p.personId ? (await all("people")).find(x => x.id === p.personId) : null;
  const photos = p.photos || []; const main = photos[0]?.originalBlob || photos[0]?.blob;
  const photoSrc = main ? makeUrl(main) : "";
  const productNotes = (await all("notes")).filter(n => n.productId === id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const notesMarkup = productNotes.length ? productNotes.map(n => `
    <div class="note-item"><div class="note-item-head"><time>${new Date(n.createdAt || Date.now()).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</time><button class="note-delete" type="button" data-delete-note="${escapeHTML(n.id)}" aria-label="Удалить заметку" title="Удалить заметку">×</button></div><p>${escapeHTML(n.text)}</p></div>
  `).join("") : `<p class="notes-empty">Пока нет заметок. Добавь первую — она появится здесь.</p>`;
  document.getElementById("detail-content").innerHTML = `
    <div class="dialog-head"><div><p class="eyebrow">КАРТОЧКА ИЗДЕЛИЯ</p><h2>${escapeHTML(p.name)}</h2></div><button class="close-btn" data-close="detail-dialog">×</button></div>
    ${photoSrc ? `<img class="detail-photo" src="${photoSrc}" alt="${escapeHTML(p.name)}">` : `<div class="product-image" style="border-radius:10px;height:180px">✳</div>`}
    <div class="detail-meta"><span class="status-badge ${p.status === "done" ? "done" : "progress"}" style="position:static">${statusLabel(p.status)}</span>${person ? `<span class="local-tag">${escapeHTML(person.name)}</span>` : ""}</div>
    <div class="detail-block"><h3>Описание</h3><p>${escapeHTML(p.description || "Описание пока не добавлено.")}</p></div>
    <div class="detail-block"><h3>Параметры вязания</h3><p>${escapeHTML(p.knitting || "Параметры вязания пока не заполнены.")}</p></div>
    <div class="detail-block notes-block"><div class="notes-heading"><h3>Заметки (${productNotes.length})</h3><button class="text-button" id="add-note-inline" type="button">＋ Добавить заметку</button></div>${notesMarkup}</div>
    <div class="detail-block"><h3>Фотографии</h3><p>${photos.length} фото · оригиналы сохранены локально</p></div>
    <div class="detail-actions"><button class="primary-button" id="edit-product">Редактировать</button><button class="secondary-button" id="toggle-status">${p.status === "done" ? "Вернуть в работу" : "Отметить готовым"}</button><button class="secondary-button" id="add-note-for-product">＋ Заметка</button><button class="danger-button" id="delete-product">Удалить</button></div>`;
  openDialog("detail-dialog");
  document.getElementById("toggle-status").onclick = async () => { p.status = p.status === "done" ? "progress" : "done"; p.updatedAt = Date.now(); await put("products", p); closeDialog("detail-dialog"); await render(); showToast("Статус изделия изменён"); };
  document.getElementById("delete-product").onclick = () => deleteProduct(id);
  document.getElementById("edit-product").onclick = () => { closeDialog("detail-dialog"); setProductForm(p); openDialog("product-dialog"); };
  const openNoteForm = () => { closeDialog("detail-dialog"); openDialog("notes-dialog"); document.getElementById("note-product").value = id; };
  document.getElementById("add-note-for-product").onclick = openNoteForm;
  document.getElementById("add-note-inline").onclick = openNoteForm;
  document.querySelectorAll("[data-delete-note]").forEach(b => b.onclick = async () => {
    if (!confirm("Удалить эту заметку?")) return;
    const tx = db.transaction(["notes", "deletions"], "readwrite");
    tx.objectStore("notes").delete(b.dataset.deleteNote);
    tx.objectStore("deletions").put(makeTombstone("notes", b.dataset.deleteNote));
    await transactionDone(tx); await openProduct(id); showToast("Заметка удалена");
  });
  document.querySelectorAll('[data-close="detail-dialog"]').forEach(b => b.onclick = () => closeDialog("detail-dialog"));
}
async function openPersonEditor(id) {
  const p = (await all("people")).find(x => x.id === id); if (!p) return;
  editingPersonId = p.id; const f = document.getElementById("person-form"); f.reset();
  f.elements.name.value = p.name || "";
  for (const k of ["height", "chest", "waist", "hips"]) f.elements[k].value = p.measurements?.[k] ?? "";
  f.elements.extra.value = p.extra || "";
  document.getElementById("person-dialog-title").textContent = "Редактировать профиль";
  document.getElementById("person-save-label").textContent = "Сохранить изменения";
  openDialog("person-dialog");
}

// Main navigation and dialogs
document.getElementById("add-product-open").onclick = () => { setProductForm(); openDialog("product-dialog"); };
document.getElementById("empty-add").onclick = () => { setProductForm(); openDialog("product-dialog"); };
document.getElementById("add-person-open").onclick = () => { editingPersonId = null; document.getElementById("person-form").reset(); document.getElementById("person-dialog-title").textContent = "Добавить человека"; document.getElementById("person-save-label").textContent = "Сохранить профиль"; openDialog("person-dialog"); };
document.getElementById("add-person-link").onclick = () => document.getElementById("add-person-open").click();
document.getElementById("settings-btn").onclick = () => openDialog("settings-dialog");
document.getElementById("nav-people").onclick = () => document.getElementById("add-person-open").scrollIntoView({ behavior: "smooth", block: "center" });
document.getElementById("nav-notes").onclick = () => openDialog("notes-dialog");
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeDialog(b.dataset.close)));
document.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => { activeFilter = b.dataset.filter; render(); }));
document.getElementById("product-sort").addEventListener("change", e => { sortMode = e.target.value; render(); });
document.getElementById("product-grid").addEventListener("click", e => {
  const del = e.target.closest("[data-delete-product]"); if (del) { e.stopPropagation(); deleteProduct(del.dataset.deleteProduct); return; }
  const card = e.target.closest("[data-product]"); if (card) openProduct(card.dataset.product);
});
document.getElementById("product-grid").addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-product]")) { e.preventDefault(); openProduct(e.target.dataset.product); } });
document.getElementById("people-list").addEventListener("click", e => {
  const del = e.target.closest("[data-delete-person]"); if (del) { deletePerson(del.dataset.deletePerson); return; }
  const edit = e.target.closest("[data-edit-person]"); if (edit) openPersonEditor(edit.dataset.editPerson);
});

// Product create/update. Existing photos are retained; newly selected photos are appended.
document.getElementById("product-form").addEventListener("submit", async e => {
  e.preventDefault(); const form = e.currentTarget; if (form.dataset.saving === "1") return;
  const submit = form.querySelector('[type="submit"]'); form.dataset.saving = "1"; if (submit) { submit.disabled = true; submit.textContent = "Сохраняем…"; }
  try {
    const f = new FormData(form); const files = [...(document.getElementById("product-photos").files || [])];
    const newPhotos = []; for (const file of files) if (file.type.startsWith("image/")) newPhotos.push(await imageVariants(file));
    const old = editingProductId ? (await all("products")).find(x => x.id === editingProductId) : null;
    const now = Date.now(); const p = {
      ...(old || {}), id: old?.id || uid(), name: String(f.get("name") || "").trim(), status: f.get("status"), personId: f.get("personId") || "",
      description: String(f.get("description") || "").trim(), knitting: String(f.get("knitting") || "").trim(),
      photos: [...(old?.photos || []), ...newPhotos], createdAt: old?.createdAt || now, updatedAt: now
    };
    await put("products", p); form.reset(); editingProductId = null; closeDialog("product-dialog"); await render(); showToast(old ? "Изменения изделия сохранены" : "Изделие сохранено на устройстве");
  } catch (err) { console.error(err); showToast("Не удалось сохранить изделие. Проверь файл фотографии и попробуй ещё раз."); }
  finally { form.dataset.saving = "0"; if (submit) { submit.disabled = false; submit.textContent = "Сохранить изделие"; } }
});

document.getElementById("person-form").addEventListener("submit", async e => {
  e.preventDefault(); const form = e.currentTarget; if (form.dataset.saving === "1") return;
  const submit = form.querySelector('[type="submit"]'); form.dataset.saving = "1"; if (submit) { submit.disabled = true; submit.textContent = "Сохраняем…"; }
  try {
    const f = new FormData(form); const measurements = {};
    ["height", "chest", "waist", "hips"].forEach(k => { if (f.get(k)) measurements[k] = Number(f.get(k)); });
    const old = editingPersonId ? (await all("people")).find(x => x.id === editingPersonId) : null;
    await put("people", { ...(old || {}), id: old?.id || uid(), name: String(f.get("name") || "").trim(), measurements, extra: String(f.get("extra") || "").trim(), createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() });
    form.reset(); editingPersonId = null; closeDialog("person-dialog"); await render(); showToast(old ? "Изменения профиля сохранены" : "Профиль сохранён");
  } catch (err) { console.error(err); showToast("Не удалось сохранить профиль. Попробуй ещё раз."); }
  finally { form.dataset.saving = "0"; if (submit) { submit.disabled = false; submit.textContent = "Сохранить профиль"; } }
});

document.getElementById("note-form").addEventListener("submit", async e => {
  e.preventDefault(); const form = e.currentTarget; if (form.dataset.saving === "1") return;
  const submit = form.querySelector('[type="submit"]'); form.dataset.saving = "1"; if (submit) { submit.disabled = true; submit.textContent = "Сохраняем…"; }
  try { const f = new FormData(form); const productId = String(f.get("productId") || ""); const noteText = String(f.get("text") || "").trim(); if (!productId || !noteText) { showToast("Выбери изделие и введи текст заметки"); return; } await put("notes", { id: uid(), productId, text: noteText, createdAt: Date.now() }); form.reset(); closeDialog("notes-dialog"); showToast("Заметка сохранена"); await openProduct(productId); }
  catch (err) { console.error(err); showToast("Не удалось сохранить заметку. Попробуй ещё раз."); }
  finally { form.dataset.saving = "0"; if (submit) { submit.disabled = false; submit.textContent = "Сохранить заметку"; } }
});

// ---------- SAFE BACKUP AND MERGE IMPORT ----------

async function blobToDataURL(blob) {
  if (!blob) return null;
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function dataURLToBlob(data) {
  if (!data || typeof data !== "string") return null;

  try {
    const [meta, base64] = data.split(",");
    const mime = meta.match(/:(.*?);/)?.[1] || "application/octet-stream";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new Blob([bytes], { type: mime });
  } catch (error) {
    console.error("Ошибка чтения фотографии:", error);
    return null;
  }
}

async function serializeProducts(products) {
  return Promise.all(products.map(async product => ({
    ...product,
    photos: await Promise.all((product.photos || []).map(async photo => ({
      name: photo.name || "",
      type: photo.type || "",
      originalData: photo.originalData ||
        (photo.originalBlob ? await blobToDataURL(photo.originalBlob) : null),
      thumbData: photo.thumbData ||
        (photo.thumbBlob ? await blobToDataURL(photo.thumbBlob) : null)
    })))
  })));
}

async function createBackupFile(filename = "knit-log-backup.json") {
  const [products, people, notes, deletions] = await Promise.all([
    all("products"),
    all("people"),
    all("notes"),
    all("deletions")
  ]);

  const payload = {
    format: "KNIT.LOG backup",
    version: 4,
    createdAt: new Date().toISOString(),
    products: await serializeProducts(products),
    people,
    notes,
    deletions
  };

  const blob = new Blob(
    [JSON.stringify(payload)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

document.getElementById("export-btn").onclick = async () => {
  try {
    await createBackupFile();
    showToast("Резервная копия скачана, включая фотографии");
  } catch (error) {
    console.error(error);
    showToast("Не удалось создать резервную копию");
  }
};

function normalizeImportedPhoto(photo) {
  return {
    name: photo.name || "",
    type: photo.type || "",
    originalBlob: dataURLToBlob(photo.originalData),
    thumbBlob: dataURLToBlob(photo.thumbData)
  };
}

function recordWithoutPhotos(product) {
  const copy = { ...product };
  delete copy.photos;
  return JSON.stringify(copy);
}

async function photoFingerprint(photo) {
  const original = photo.originalData ||
    (photo.originalBlob ? await blobToDataURL(photo.originalBlob) : "");

  return [
    photo.name || "",
    photo.type || "",
    original || ""
  ].join("|");
}

async function mergePhotos(localPhotos = [], importedPhotos = []) {
  const result = [...localPhotos];
  const known = new Set();

  for (const photo of result) {
    known.add(await photoFingerprint(photo));
  }

  for (const photo of importedPhotos) {
    const key = await photoFingerprint(photo);

    if (!known.has(key)) {
      result.push(photo);
      known.add(key);
    }
  }

  return result;
}

async function mergeProducts(importedProducts) {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const imported of importedProducts) {
    const incoming = {
      ...imported,
      photos: (imported.photos || []).map(normalizeImportedPhoto)
    };

    const local = (await all("products"))
      .find(product => product.id === incoming.id);

    if (!local) {
      await put("products", incoming);
      added++;
      continue;
    }

    const photos = await mergePhotos(
      local.photos || [],
      incoming.photos || []
    );

    const hasConflict =
      recordWithoutPhotos(local) !== recordWithoutPhotos(incoming);

    let useImportedFields = false;

    if (hasConflict) {
      useImportedFields = confirm(
        `Изделие «${local.name}» уже есть в каталоге, ` +
        `но его данные отличаются.\n\n` +
        `ОК — использовать данные из резервной копии.\n` +
        `Отмена — оставить текущие данные.\n\n` +
        `В обоих случаях новые фотографии будут объединены.`
      );
    }

    const result = useImportedFields
      ? { ...incoming, photos }
      : { ...local, photos };

    await put("products", result);

    if (useImportedFields) updated++;
    else skipped++;
  }

  return { added, updated, skipped };
}

async function mergePeople(importedPeople) {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const incoming of importedPeople) {
    const local = (await all("people"))
      .find(person => person.id === incoming.id);

    if (!local) {
      await put("people", incoming);
      added++;
      continue;
    }

    if (JSON.stringify(local) === JSON.stringify(incoming)) {
      skipped++;
      continue;
    }

    const replace = confirm(
      `Профиль «${local.name}» уже существует, ` +
      `но его данные отличаются.\n\n` +
      `ОК — использовать данные из резервной копии.\n` +
      `Отмена — оставить текущий профиль.`
    );

    if (replace) {
      await put("people", incoming);
      updated++;
    } else {
      skipped++;
    }
  }

  return { added, updated, skipped };
}

async function mergeNotes(importedNotes) {
  let added = 0;
  let skipped = 0;

  for (const incoming of importedNotes) {
    const local = (await all("notes"))
      .find(note => note.id === incoming.id);

    if (!local) {
      await put("notes", incoming);
      added++;
      continue;
    }

    if (JSON.stringify(local) === JSON.stringify(incoming)) {
      skipped++;
      continue;
    }

    const replace = confirm(
      `Заметка с таким ID уже существует и отличается.\n\n` +
      `ОК — использовать заметку из резервной копии.\n` +
      `Отмена — оставить текущую заметку.`
    );

    if (replace) {
      await put("notes", incoming);
    } else {
      skipped++;
    }
  }

  return { added, skipped };
}

function validTombstone(entry) {
  return entry && ["products", "people", "notes"].includes(entry.type) &&
    typeof entry.recordId === "string" && entry.recordId.length > 0 &&
    typeof entry.deletedAt === "number" && Number.isFinite(entry.deletedAt);
}

async function importBackup(data) {
  const [localProducts, localPeople, localNotes, localDeletions] = await Promise.all([
    all("products"), all("people"), all("notes"), all("deletions")
  ]);
  const tombstones = new Map();
  const deletionsToWrite = new Set();
  for (const entry of localDeletions) {
    if (!validTombstone(entry)) throw new Error("Некорректная запись журнала удалений");
    const normalized = makeTombstone(entry.type, entry.recordId, entry.deletedAt);
    tombstones.set(normalized.id, normalized);
  }
  for (const entry of data.deletions || []) {
    if (!validTombstone(entry)) throw new Error("Некорректная запись журнала удалений");
    const normalized = makeTombstone(entry.type, entry.recordId, entry.deletedAt);
    const previous = tombstones.get(normalized.id);
    if (!previous || normalized.deletedAt > previous.deletedAt) {
      tombstones.set(normalized.id, normalized);
      deletionsToWrite.add(normalized.id);
    }
  }
  const deleted = new Set([...tombstones.values()].map(t => `${t.type}:${t.recordId}`));
  const deletedProductIds = new Set([...tombstones.values()].filter(t => t.type === "products").map(t => t.recordId));
  const deletedPeopleIds = new Set([...tombstones.values()].filter(t => t.type === "people").map(t => t.recordId));
  const notesToDelete = new Set(localNotes.filter(note => deletedProductIds.has(note.productId)).map(note => note.id));
  const changed = { products: new Set(), people: new Set(), notes: new Set() };
  const products = new Map(localProducts.filter(x => !deleted.has(`products:${x.id}`)).map(x => {
    if (x.personId && deletedPeopleIds.has(x.personId)) {
      changed.products.add(x.id);
      return [x.id, { ...x, personId: "" }];
    }
    return [x.id, x];
  }));
  const people = new Map(localPeople.filter(x => !deleted.has(`people:${x.id}`)).map(x => [x.id, x]));
  const notes = new Map(localNotes.filter(x => !deleted.has(`notes:${x.id}`) && !deletedProductIds.has(x.productId)).map(x => [x.id, x]));
  const counts = { products: { added: 0, updated: 0, skipped: 0 }, people: { added: 0, updated: 0, skipped: 0 }, notes: { added: 0, updated: 0, skipped: 0 } };

  for (const raw of data.products) {
    const incoming = {
      ...raw,
      personId: raw.personId && deletedPeopleIds.has(raw.personId) ? "" : (raw.personId || ""),
      photos: (raw.photos || []).map(normalizeImportedPhoto)
    };
    if (deleted.has(`products:${incoming.id}`)) { counts.products.skipped++; continue; }
    const local = products.get(incoming.id);
    if (!local) { products.set(incoming.id, incoming); changed.products.add(incoming.id); counts.products.added++; continue; }
    const photos = await mergePhotos(local.photos || [], incoming.photos || []);
    const hasConflict = recordWithoutPhotos(local) !== recordWithoutPhotos(incoming);
    const useImportedFields = hasConflict && confirm(
      `Изделие «${local.name}» уже есть в каталоге, но его данные отличаются.\n\n` +
      `ОК — использовать данные из резервной копии.\nОтмена — оставить текущие данные.\n\n` +
      `В обоих случаях новые фотографии будут объединены.`
    );
    const result = useImportedFields ? { ...incoming, photos } : { ...local, photos };
    const photosChanged = photos.length !== (local.photos || []).length;
    if (useImportedFields || photosChanged) { products.set(incoming.id, result); changed.products.add(incoming.id); }
    if (useImportedFields) counts.products.updated++; else counts.products.skipped++;
  }

  for (const incoming of data.people) {
    if (deleted.has(`people:${incoming.id}`)) { counts.people.skipped++; continue; }
    const local = people.get(incoming.id);
    if (!local) { people.set(incoming.id, incoming); changed.people.add(incoming.id); counts.people.added++; continue; }
    if (JSON.stringify(local) === JSON.stringify(incoming)) { counts.people.skipped++; continue; }
    const replace = confirm(`Профиль «${local.name}» уже существует, но его данные отличаются.\n\nОК — использовать данные из резервной копии.\nОтмена — оставить текущий профиль.`);
    if (replace) { people.set(incoming.id, incoming); changed.people.add(incoming.id); counts.people.updated++; }
    else counts.people.skipped++;
  }

  for (const incoming of data.notes) {
    if (deleted.has(`notes:${incoming.id}`) || deletedProductIds.has(incoming.productId)) { counts.notes.skipped++; continue; }
    const local = notes.get(incoming.id);
    if (!local) { notes.set(incoming.id, incoming); changed.notes.add(incoming.id); counts.notes.added++; continue; }
    if (JSON.stringify(local) === JSON.stringify(incoming)) { counts.notes.skipped++; continue; }
    const replace = confirm(`Заметка с таким ID уже существует и отличается.\n\nОК — использовать заметку из резервной копии.\nОтмена — оставить текущую заметку.`);
    if (replace) { notes.set(incoming.id, incoming); changed.notes.add(incoming.id); counts.notes.updated++; }
    else counts.notes.skipped++;
  }

  // Tombstones and resulting records commit together, so an interrupted import cannot apply only part of the merge.
  const tx = db.transaction(["products", "people", "notes", "deletions"], "readwrite");
  const done = transactionDone(tx);
  try {
    const stores = { products: tx.objectStore("products"), people: tx.objectStore("people"), notes: tx.objectStore("notes") };
    for (const tombstone of tombstones.values()) {
      if (deletionsToWrite.has(tombstone.id)) tx.objectStore("deletions").put(tombstone);
      stores[tombstone.type].delete(tombstone.recordId);
    }
    for (const noteId of notesToDelete) stores.notes.delete(noteId);
    for (const [type, records] of Object.entries({ products, people, notes })) {
      for (const id of changed[type]) records.has(id) && stores[type].put(records.get(id));
    }
    await done;
  } catch (error) {
    try { tx.abort(); } catch {}
    await done.catch(() => {});
    throw error;
  }
  return counts;
}

document.getElementById("import-file").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());

    if (
      data.format !== "KNIT.LOG backup" ||
      ![2, 3, 4].includes(data.version) ||
      !Array.isArray(data.products) ||
      !Array.isArray(data.people) ||
      !Array.isArray(data.notes)
    ) {
      throw new Error("Неверный формат резервной копии");
    }
    if (data.version === 4 && !Array.isArray(data.deletions)) throw new Error("В копии версии 4 отсутствует журнал удалений");
    if (data.version !== 4) data.deletions = [];
    if (data.deletions.some(entry => !validTombstone(entry))) throw new Error("Некорректный журнал удалений в резервной копии");

    const confirmed = confirm(
      "Будет выполнено объединение резервной копии с текущими данными.\n\n" +
      "Существующие записи не будут автоматически удалены.\n" +
      "При обнаружении конфликтов приложение спросит, какие данные оставить.\n\n" +
      "Перед импортом будет скачана страховочная копия.\n\n" +
      "Продолжить?"
    );

    if (!confirmed) return;

    // Страховочная копия до любых изменений
    await createBackupFile(
      `knit-log-before-import-${Date.now()}.json`
    );

    const result = await importBackup(data);

    await render();

    const report =
      `Импорт завершён.\n\n` +
      `Изделия: добавлено ${result.products.added}, ` +
      `заменено ${result.products.updated}, ` +
      `оставлено без замены ${result.products.skipped}.\n\n` +
      `Профили: добавлено ${result.people.added}, ` +
      `заменено ${result.people.updated}, ` +
      `оставлено без замены ${result.people.skipped}.\n\n` +
      `Заметки: добавлено ${result.notes.added}, ` +
      `заменено ${result.notes.updated}, ` +
      `оставлено без замены ${result.notes.skipped}.`;

    alert(report);
    showToast("Объединение данных завершено");

  } catch (error) {
    console.error("Ошибка импорта:", error);
    alert(
      "Не удалось импортировать резервную копию.\n\n" +
      "Текущие данные не следует удалять. " +
      "Подробности ошибки можно посмотреть в консоли браузера."
    );
  } finally {
    event.target.value = "";
  }
};

window.addEventListener("online", () => {
  document.getElementById("connection-pill").innerHTML =
    "<i></i><span>Есть интернет · облако не подключено</span>";
});

window.addEventListener("offline", () => {
  document.getElementById("connection-pill").innerHTML =
    "<i></i><span>Офлайн · локальный режим</span>";
});

(async () => {
  try {
    db = await openDB();
    await render();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (error) {
    console.error(error);
    document.getElementById("db-status").textContent = "Ошибка";
    showToast("Не удалось открыть локальную базу");
  }
})();
