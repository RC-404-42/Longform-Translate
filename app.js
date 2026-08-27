"use strict";

const LANGUAGES = [
  ["auto", "自動偵測"],
  ["en", "英文"],
  ["zh-TW", "中文"],
  ["ja", "日文"],
  ["ko", "韓文"],
  ["fr", "法文"],
  ["de", "德文"],
  ["es", "西班牙文"],
  ["it", "義大利文"],
  ["pt", "葡萄牙文"],
  ["ru", "俄文"],
];

const RULES_STORAGE_KEY = "longform-translate-rules-v1";
const MAX_BATCH_CHARACTERS = 4200;
const MAX_ITEMS_PER_BATCH = 24;
const GOOGLE_TRANSLATE_ENDPOINT =
  "https://translate-pa.googleapis.com/v1/translateHtml";
const GOOGLE_AUTH_SCRIPT =
  "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main";
const FALLBACK_KEY_BYTES = [
  65, 73, 122, 97, 83, 121, 65, 84, 66, 88, 97, 106, 118, 122, 81, 76,
  84, 68, 72, 69, 81, 98, 99, 112, 113, 48, 73, 104, 101, 48, 118, 87,
  68, 72, 109, 79, 53, 50, 48,
];

const elements = {
  sourceLanguage: document.querySelector("#sourceLanguage"),
  targetLanguage: document.querySelector("#targetLanguage"),
  sourceEditor: document.querySelector("#sourceEditor"),
  sourceHeading: document.querySelector("#sourceHeading"),
  targetHeading: document.querySelector("#targetHeading"),
  readingSourceHeading: document.querySelector("#readingSourceHeading"),
  readingTargetHeading: document.querySelector("#readingTargetHeading"),
  characterStat: document.querySelector("#characterStat"),
  paragraphStat: document.querySelector("#paragraphStat"),
  composeView: document.querySelector("#composeView"),
  readingView: document.querySelector("#readingView"),
  paragraphPairs: document.querySelector("#paragraphPairs"),
  pairCount: document.querySelector("#pairCount"),
  appliedRules: document.querySelector("#appliedRules"),
  rulesStatus: document.querySelector("#rulesStatus"),
  ruleCount: document.querySelector("#ruleCount"),
  translateButton: document.querySelector("#translateButton"),
  stopButton: document.querySelector("#stopButton"),
  copyButton: document.querySelector("#copyButton"),
  editButton: document.querySelector("#editButton"),
  clearButton: document.querySelector("#clearButton"),
  swapButton: document.querySelector("#swapButton"),
  progressStrip: document.querySelector("#progressStrip"),
  progressText: document.querySelector("#progressText"),
  progressBar: document.querySelector("#progressBar"),
  progressPercent: document.querySelector("#progressPercent"),
  emptyTitle: document.querySelector("#emptyTitle"),
  rulesButton: document.querySelector("#rulesButton"),
  rulesDialog: document.querySelector("#rulesDialog"),
  rulesList: document.querySelector("#rulesList"),
  addRuleButton: document.querySelector("#addRuleButton"),
  importRulesButton: document.querySelector("#importRulesButton"),
  importRulesInput: document.querySelector("#importRulesInput"),
  exportRulesButton: document.querySelector("#exportRulesButton"),
  toast: document.querySelector("#toast"),
};

let paragraphs = [];
let rules = [];
let abortController = null;
let cachedGoogleKey = null;
let activeParagraph = null;
let toastTimer = null;

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function createRule() {
  return {
    id: randomId(),
    pattern: "",
    replacement: "",
    useRegex: false,
    ignoreCase: false,
    enabled: true,
  };
}

function languageName(code) {
  return LANGUAGES.find(([value]) => value === code)?.[1] || code;
}

function populateLanguages() {
  LANGUAGES.forEach(([code, label]) => {
    const sourceOption = document.createElement("option");
    sourceOption.value = code;
    sourceOption.textContent = label;
    elements.sourceLanguage.append(sourceOption);

    if (code !== "auto") {
      const targetOption = document.createElement("option");
      targetOption.value = code;
      targetOption.textContent = label;
      elements.targetLanguage.append(targetOption);
    }
  });
  elements.sourceLanguage.value = "auto";
  elements.targetLanguage.value = "zh-TW";
}

function showToast(message, type = "normal") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", type === "error");
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3400);
}

function parseParagraphs(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function splitLongText(text, maxLength = MAX_BATCH_CHARACTERS) {
  const characters = Array.from(text);
  if (characters.length <= maxLength) return [text];

  const parts = [];
  const preferredBreaks = new Set([
    ".", "!", "?", "。", "！", "？", "…", ";", "；", "\n",
  ]);
  let cursor = 0;

  while (cursor < characters.length) {
    const remaining = characters.length - cursor;
    if (remaining <= maxLength) {
      parts.push(characters.slice(cursor).join("").trim());
      break;
    }

    const upper = cursor + maxLength;
    const lower = cursor + Math.floor(maxLength * 0.62);
    let splitAt = upper;
    for (let index = upper - 1; index >= lower; index -= 1) {
      if (preferredBreaks.has(characters[index])) {
        splitAt = index + 1;
        break;
      }
      if (/\s/.test(characters[index]) && splitAt === upper) splitAt = index + 1;
    }
    parts.push(characters.slice(cursor, splitAt).join("").trim());
    cursor = splitAt;
  }

  return parts.filter(Boolean);
}

function makeBatches(jobs) {
  const batches = [];
  let current = [];
  let currentLength = 0;

  jobs.forEach((job) => {
    const length = Array.from(job.text).length;
    if (
      current.length &&
      (currentLength + length > MAX_BATCH_CHARACTERS ||
        current.length >= MAX_ITEMS_PER_BATCH)
    ) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(job);
    currentLength += length;
  });
  if (current.length) batches.push(current);
  return batches;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readTranslatedHtml(value) {
  const parsed = new DOMParser().parseFromString(value, "text/html");
  parsed.querySelectorAll("i").forEach((node) => node.remove());
  return (parsed.body.textContent || "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\u200b/g, " ");
}

function fallbackGoogleKey() {
  return new TextDecoder().decode(new Uint8Array(FALLBACK_KEY_BYTES));
}

async function getGoogleKey(signal) {
  if (cachedGoogleKey && cachedGoogleKey.expiresAt > Date.now()) {
    return cachedGoogleKey.value;
  }

  let key = fallbackGoogleKey();
  try {
    const response = await fetch(GOOGLE_AUTH_SCRIPT, { cache: "no-store", signal });
    if (response.ok) {
      const script = await response.text();
      const result = script.match(
        /["']x-goog-api-key["']\s*:\s*["'](\w{39})["']/i,
      );
      if (result?.[1]) key = result[1];
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }

  cachedGoogleKey = { value: key, expiresAt: Date.now() + 20 * 60 * 1000 };
  return key;
}

async function translateBatch(texts, sourceLanguage, targetLanguage, signal) {
  const key = await getGoogleKey(signal);
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(GOOGLE_TRANSLATE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json+protobuf",
          "X-goog-api-key": key,
        },
        body: JSON.stringify([
          [
            texts.map((text) => `<pre>${escapeHtml(text)}</pre>`),
            sourceLanguage,
            targetLanguage,
          ],
          "te",
        ]),
        signal,
      });
      if (!response.ok) throw new Error(`Google returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length !== texts.length) {
        throw new Error("Unexpected response");
      }
      return data[0].map((value) => readTranslatedHtml(String(value)));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 450 * 2 ** attempt));
      }
    }
  }
  throw lastError || new Error("Translation failed");
}

function applyRules(text) {
  return rules.reduce((result, rule) => {
    if (!rule.enabled || !rule.pattern) return result;
    try {
      if (rule.useRegex) {
        return result.replace(
          new RegExp(rule.pattern, rule.ignoreCase ? "gi" : "g"),
          rule.replacement,
        );
      }
      if (rule.ignoreCase) {
        const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return result.replace(new RegExp(escaped, "gi"), () => rule.replacement);
      }
      return result.split(rule.pattern).join(rule.replacement);
    } catch {
      return result;
    }
  }, text);
}

function isRuleInvalid(rule) {
  if (!rule.useRegex || !rule.pattern) return false;
  try {
    new RegExp(rule.pattern, rule.ignoreCase ? "gi" : "g");
    return false;
  } catch {
    return true;
  }
}

function enabledRuleCount() {
  return rules.filter((rule) => rule.enabled && rule.pattern).length;
}

function saveRules() {
  localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules));
  paragraphs = paragraphs.map((paragraph) => ({
    ...paragraph,
    translation: applyRules(paragraph.rawTranslation),
  }));
  updateRuleStatus();
  if (paragraphs.length) renderParagraphs();
}

function loadRules() {
  try {
    const saved = localStorage.getItem(RULES_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) {
      rules = parsed.map((rule) => ({
        id: rule.id || randomId(),
        pattern: String(rule.pattern || ""),
        replacement: String(rule.replacement || ""),
        useRegex: Boolean(rule.useRegex),
        ignoreCase: Boolean(rule.ignoreCase),
        enabled: rule.enabled !== false,
      }));
    }
  } catch {
    showToast("替換規則讀取失敗，已保留空白設定。", "error");
  }
}

function updateRuleStatus() {
  const count = enabledRuleCount();
  elements.ruleCount.textContent = String(count);
  elements.ruleCount.hidden = count === 0;
  elements.rulesStatus.textContent = count ? `套用 ${count} 條規則` : "尚無替換規則";
  elements.appliedRules.textContent = count
    ? `已套用 ${count} 條替換規則`
    : "未套用替換規則";
  elements.exportRulesButton.disabled = rules.length === 0;
}

function renderRules() {
  elements.rulesList.replaceChildren();
  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "rules-empty";
    empty.textContent = "還沒有規則。新增一條，例如「舉報」換成「檢舉」。";
    elements.rulesList.append(empty);
    updateRuleStatus();
    return;
  }

  rules.forEach((rule, index) => {
    const card = document.createElement("section");
    card.className = `rule-card${isRuleInvalid(rule) ? " is-invalid" : ""}`;
    card.innerHTML = `
      <div class="rule-card-top">
        <label class="toggle"><input class="rule-enabled" type="checkbox"> 啟用</label>
        <span class="rule-index"></span>
        <div class="rule-order-actions">
          <button class="mini-button move-up" type="button" title="往上移">↑</button>
          <button class="mini-button move-down" type="button" title="往下移">↓</button>
          <button class="mini-button delete" type="button" title="刪除">×</button>
        </div>
      </div>
      <div class="rule-fields">
        <label><span class="pattern-label"></span><input class="rule-pattern" spellcheck="false"></label>
        <span class="rule-arrow">→</span>
        <label><span>替換成</span><input class="rule-replacement" placeholder="檢舉" spellcheck="false"></label>
      </div>
      <div class="rule-options">
        <label class="toggle"><input class="rule-regex" type="checkbox"> 使用 Regex</label>
        <label class="toggle"><input class="rule-case" type="checkbox"> 忽略大小寫</label>
      </div>`;

    const enabled = card.querySelector(".rule-enabled");
    const pattern = card.querySelector(".rule-pattern");
    const replacement = card.querySelector(".rule-replacement");
    const regex = card.querySelector(".rule-regex");
    const ignoreCase = card.querySelector(".rule-case");
    const patternLabel = card.querySelector(".pattern-label");
    const ruleIndex = card.querySelector(".rule-index");
    const options = card.querySelector(".rule-options");

    enabled.checked = rule.enabled;
    pattern.value = rule.pattern;
    replacement.value = rule.replacement;
    regex.checked = rule.useRegex;
    ignoreCase.checked = rule.ignoreCase;
    pattern.placeholder = rule.useRegex ? "舉報|举报" : "舉報";
    patternLabel.textContent = rule.useRegex ? "Regex 樣式" : "尋找文字";
    ruleIndex.textContent = `規則 ${index + 1}`;

    if (isRuleInvalid(rule)) {
      const error = document.createElement("span");
      error.className = "regex-error";
      error.textContent = "Regex 格式有誤";
      options.append(error);
    }

    enabled.addEventListener("change", () => {
      rule.enabled = enabled.checked;
      saveRules();
    });
    pattern.addEventListener("input", () => {
      rule.pattern = pattern.value;
      saveRules();
      card.classList.toggle("is-invalid", isRuleInvalid(rule));
    });
    replacement.addEventListener("input", () => {
      rule.replacement = replacement.value;
      saveRules();
    });
    regex.addEventListener("change", () => {
      rule.useRegex = regex.checked;
      saveRules();
      renderRules();
    });
    ignoreCase.addEventListener("change", () => {
      rule.ignoreCase = ignoreCase.checked;
      saveRules();
    });
    card.querySelector(".move-up").disabled = index === 0;
    card.querySelector(".move-down").disabled = index === rules.length - 1;
    card.querySelector(".move-up").addEventListener("click", () => moveRule(index, -1));
    card.querySelector(".move-down").addEventListener("click", () => moveRule(index, 1));
    card.querySelector(".delete").addEventListener("click", () => {
      rules = rules.filter((item) => item.id !== rule.id);
      saveRules();
      renderRules();
    });
    elements.rulesList.append(card);
  });
  updateRuleStatus();
}

function moveRule(index, direction) {
  const next = index + direction;
  if (next < 0 || next >= rules.length) return;
  [rules[index], rules[next]] = [rules[next], rules[index]];
  saveRules();
  renderRules();
}

function updateStats() {
  const text = elements.sourceEditor.value;
  elements.characterStat.textContent = `${Array.from(text).length.toLocaleString()} 字元`;
  elements.paragraphStat.textContent = `${parseParagraphs(text).length} 段`;
  elements.clearButton.disabled = !text && !paragraphs.length;
}

function updateLanguageHeadings() {
  const source = languageName(elements.sourceLanguage.value);
  const target = languageName(elements.targetLanguage.value);
  elements.sourceHeading.textContent = source;
  elements.targetHeading.textContent = target;
  elements.readingSourceHeading.textContent = source;
  elements.readingTargetHeading.textContent = target;
}

function resetResult() {
  paragraphs = [];
  activeParagraph = null;
  elements.readingView.hidden = true;
  elements.composeView.hidden = false;
  elements.copyButton.hidden = true;
  elements.editButton.hidden = true;
  elements.translateButton.textContent = "✦ 開始翻譯";
  elements.paragraphPairs.replaceChildren();
  updateStats();
}

function setBusy(busy, completed = 0, total = 0) {
  elements.translateButton.hidden = busy;
  elements.stopButton.hidden = !busy;
  elements.progressStrip.hidden = !busy;
  elements.emptyTitle.textContent = busy ? "正在整理段落…" : "譯文會出現在這裡";
  if (busy) updateProgress(completed, total);
}

function updateProgress(completed, total) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  elements.progressText.textContent = `正在翻譯 ${completed}／${total}`;
  elements.progressBar.value = percent;
  elements.progressPercent.textContent = `${percent}%`;
}

function setActiveParagraph(id) {
  activeParagraph = id;
  elements.paragraphPairs.querySelectorAll(".paragraph-pair").forEach((pair) => {
    pair.classList.toggle("is-active", Number(pair.dataset.id) === id);
  });
}

function renderParagraphs() {
  elements.paragraphPairs.replaceChildren();
  paragraphs.forEach((paragraph) => {
    const pair = document.createElement("article");
    pair.className = "paragraph-pair";
    pair.dataset.id = String(paragraph.id);

    const source = document.createElement("div");
    source.className = "paragraph-card source-card";
    source.tabIndex = 0;
    source.textContent = paragraph.source;
    source.setAttribute("aria-label", `原文第 ${paragraph.id + 1} 段`);

    const connector = document.createElement("div");
    connector.className = "pair-connector";
    connector.setAttribute("aria-hidden", "true");
    const number = document.createElement("span");
    number.textContent = String(paragraph.id + 1);
    connector.append(number);

    const translation = document.createElement("div");
    translation.className = "paragraph-card translation-card";
    translation.tabIndex = 0;
    translation.textContent = paragraph.translation;
    translation.setAttribute("aria-label", `譯文第 ${paragraph.id + 1} 段`);

    pair.append(source, connector, translation);
    pair.addEventListener("mouseenter", () => setActiveParagraph(paragraph.id));
    pair.addEventListener("mouseleave", () => setActiveParagraph(null));
    pair.addEventListener("focusin", () => setActiveParagraph(paragraph.id));
    pair.addEventListener("focusout", (event) => {
      if (!pair.contains(event.relatedTarget)) setActiveParagraph(null);
    });
    pair.addEventListener("click", () => {
      setActiveParagraph(activeParagraph === paragraph.id ? null : paragraph.id);
    });
    elements.paragraphPairs.append(pair);
  });

  elements.pairCount.textContent = `${paragraphs.length} 組對照段落`;
  elements.composeView.hidden = true;
  elements.readingView.hidden = false;
  elements.copyButton.hidden = false;
  elements.editButton.hidden = false;
  elements.translateButton.textContent = "✦ 重新翻譯";
  updateRuleStatus();
  updateStats();
}

async function translate() {
  const sources = parseParagraphs(elements.sourceEditor.value);
  if (!sources.length) {
    showToast("先放一點原文進來啦，空氣沒辦法翻譯。", "error");
    return;
  }
  if (elements.sourceLanguage.value === elements.targetLanguage.value) {
    showToast("原文和譯文語言相同，換一邊再翻譯。", "error");
    return;
  }

  const jobs = sources.flatMap((paragraph, paragraphIndex) =>
    splitLongText(paragraph).map((text, partIndex) => ({
      paragraphIndex,
      partIndex,
      text,
    })),
  );
  const batches = makeBatches(jobs);
  abortController = new AbortController();
  paragraphs = [];
  setBusy(true, 0, batches.length);

  try {
    const results = new Map();
    let nextBatch = 0;
    let completed = 0;

    const worker = async () => {
      while (nextBatch < batches.length) {
        const batchIndex = nextBatch;
        nextBatch += 1;
        const batch = batches[batchIndex];
        const translated = await translateBatch(
          batch.map((job) => job.text),
          elements.sourceLanguage.value,
          elements.targetLanguage.value,
          abortController.signal,
        );
        batch.forEach((job, index) => {
          results.set(`${job.paragraphIndex}:${job.partIndex}`, translated[index]);
        });
        completed += 1;
        updateProgress(completed, batches.length);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(3, batches.length) }, () => worker()),
    );

    const joiner = /^(zh|ja|ko)/i.test(elements.targetLanguage.value) ? "" : " ";
    paragraphs = sources.map((source, paragraphIndex) => {
      const rawTranslation = splitLongText(source)
        .map((_, partIndex) => results.get(`${paragraphIndex}:${partIndex}`) || "")
        .join(joiner);
      return {
        id: paragraphIndex,
        source,
        rawTranslation,
        translation: applyRules(rawTranslation),
      };
    });
    renderParagraphs();
    showToast(`翻譯完成，共 ${paragraphs.length} 個段落。`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      showToast("已停止翻譯。");
    } else {
      console.error(error);
      showToast("免費 Google 翻譯暫時沒有回應，請稍後再試一次。", "error");
    }
  } finally {
    setBusy(false);
    abortController = null;
  }
}

function exportRules() {
  const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "translation-rules.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function importRules(file) {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const imported = JSON.parse(String(reader.result));
      if (!Array.isArray(imported)) throw new Error("not an array");
      rules = imported.map((rule) => ({
        id: rule.id || randomId(),
        pattern: String(rule.pattern || ""),
        replacement: String(rule.replacement || ""),
        useRegex: Boolean(rule.useRegex),
        ignoreCase: Boolean(rule.ignoreCase),
        enabled: rule.enabled !== false,
      }));
      saveRules();
      renderRules();
      showToast(`已匯入 ${rules.length} 條規則。`);
    } catch {
      showToast("這個 JSON 不是有效的替換規則檔案。", "error");
    }
  });
  reader.readAsText(file);
}

elements.sourceEditor.addEventListener("input", updateStats);
elements.sourceLanguage.addEventListener("change", () => {
  updateLanguageHeadings();
  resetResult();
});
elements.targetLanguage.addEventListener("change", () => {
  updateLanguageHeadings();
  resetResult();
});
elements.translateButton.addEventListener("click", translate);
elements.stopButton.addEventListener("click", () => abortController?.abort());
elements.editButton.addEventListener("click", resetResult);
elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(
    paragraphs.map((paragraph) => paragraph.translation).join("\n\n"),
  );
  showToast("譯文已複製。");
});
elements.clearButton.addEventListener("click", () => {
  abortController?.abort();
  elements.sourceEditor.value = "";
  resetResult();
});
elements.swapButton.addEventListener("click", () => {
  const nextSource = elements.targetLanguage.value;
  const nextTarget = elements.sourceLanguage.value === "auto"
    ? "en"
    : elements.sourceLanguage.value;
  elements.sourceLanguage.value = nextSource;
  elements.targetLanguage.value = nextTarget;
  if (paragraphs.length) {
    elements.sourceEditor.value = paragraphs
      .map((paragraph) => paragraph.translation)
      .join("\n\n");
  }
  updateLanguageHeadings();
  resetResult();
});

elements.rulesButton.addEventListener("click", () => {
  renderRules();
  elements.rulesDialog.showModal();
});
elements.addRuleButton.addEventListener("click", () => {
  rules.push(createRule());
  saveRules();
  renderRules();
  elements.rulesList.lastElementChild?.scrollIntoView({ behavior: "smooth" });
});
elements.exportRulesButton.addEventListener("click", exportRules);
elements.importRulesButton.addEventListener("click", () => elements.importRulesInput.click());
elements.importRulesInput.addEventListener("change", () => {
  const file = elements.importRulesInput.files?.[0];
  if (file) importRules(file);
  elements.importRulesInput.value = "";
});

populateLanguages();
loadRules();
updateLanguageHeadings();
updateRuleStatus();
updateStats();
