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
const SETTINGS_STORAGE_KEY = "longform-translate-settings-v1";
const DEFAULT_SETTINGS = Object.freeze({
  chineseQuotes: true,
  liveTranslation: false,
  mobileToolbarCollapsed: false,
  mobileToolbarPreferenceSet: false,
});
const LIVE_TRANSLATION_DELAY = 900;
const MOBILE_TOOLBAR_MEDIA_QUERY = "(max-width: 720px)";
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
  languageToolbar: document.querySelector(".language-toolbar"),
  mobileToolbarToggle: document.querySelector("#mobileToolbarToggle"),
  mobileToolbarLanguageSummary: document.querySelector("#mobileToolbarLanguageSummary"),
  mobileToolbarActionText: document.querySelector("#mobileToolbarActionText"),
  mobileToolbarChevron: document.querySelector("#mobileToolbarChevron"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  targetLanguage: document.querySelector("#targetLanguage"),
  sourceEditor: document.querySelector("#sourceEditor"),
  emptyPreview: document.querySelector("#emptyPreview"),
  emptyDescription: document.querySelector("#emptyDescription"),
  livePreview: document.querySelector("#livePreview"),
  livePreviewStatus: document.querySelector("#livePreviewStatus"),
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
  chineseQuotesToggle: document.querySelector("#chineseQuotesToggle"),
  liveTranslationToggle: document.querySelector("#liveTranslationToggle"),
  rulesList: document.querySelector("#rulesList"),
  addRuleButton: document.querySelector("#addRuleButton"),
  importRulesButton: document.querySelector("#importRulesButton"),
  importRulesInput: document.querySelector("#importRulesInput"),
  exportRulesButton: document.querySelector("#exportRulesButton"),
  toast: document.querySelector("#toast"),
};

let paragraphs = [];
let rules = [];
let settings = { ...DEFAULT_SETTINGS };
let abortController = null;
let cachedGoogleKey = null;
let activeParagraph = null;
let activeSentence = null;
let toastTimer = null;
let liveTranslationTimer = null;
let liveTranslationVersion = 0;
const liveTranslationCache = new Map();

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

function sentenceLocale(language, text = "") {
  if (language === "auto") {
    if (/[\u3040-\u30ff]/u.test(text)) return "ja";
    if (/[\uac00-\ud7af]/u.test(text)) return "ko";
    if (/[\u3400-\u9fff]/u.test(text)) return "zh-Hant";
    return "en";
  }
  if (language === "zh-TW") return "zh-Hant";
  return language;
}

function normalizeSentenceSegments(segments) {
  const normalized = [];
  segments.forEach((segment) => {
    if (!segment) return;
    if (!segment.trim() && normalized.length) {
      normalized[normalized.length - 1] += segment;
      return;
    }
    normalized.push(segment);
  });
  return normalized.filter((segment) => segment.trim());
}

function fallbackSentenceSegments(text) {
  const segments = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    if (/[.!?。！？…]/u.test(text[index])) {
      let end = index + 1;
      while (end < text.length && /[.!?。！？…]/u.test(text[end])) end += 1;
      while (end < text.length && /["'”’」』）》】]/u.test(text[end])) end += 1;
      while (end < text.length && /\s/u.test(text[end])) end += 1;
      segments.push(text.slice(start, end));
      start = end;
      index = end;
      continue;
    }
    index += 1;
  }

  if (start < text.length) segments.push(text.slice(start));
  return normalizeSentenceSegments(segments.length ? segments : [text]);
}

function segmentSentences(text, language = "auto") {
  if (!text.trim()) return [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(sentenceLocale(language, text), {
        granularity: "sentence",
      });
      return normalizeSentenceSegments(
        Array.from(segmenter.segment(text), ({ segment }) => segment),
      );
    } catch {
      // Fall through for browsers that reject an uncommon locale code.
    }
  }
  return fallbackSentenceSegments(text);
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

function createSentenceJobs(sources, sourceLanguage) {
  const sentenceSources = sources.map((source) =>
    segmentSentences(source, sourceLanguage),
  );
  const jobs = [];

  sentenceSources.forEach((sentences, paragraphIndex) => {
    const fragments = sentences.flatMap((text, sentenceIndex) =>
      splitLongText(text).map((fragment, fragmentIndex) => ({
        sentenceIndex,
        fragmentIndex,
        text: fragment,
      })),
    );
    let current = [];
    let currentLength = 0;
    let partIndex = 0;

    const flush = () => {
      if (!current.length) return;
      jobs.push({
        paragraphIndex,
        partIndex,
        text: current.map((fragment) => fragment.text).join(""),
        segments: current,
      });
      partIndex += 1;
      current = [];
      currentLength = 0;
    };

    fragments.forEach((fragment) => {
      const length = Array.from(fragment.text).length;
      if (current.length && currentLength + length > MAX_BATCH_CHARACTERS) flush();
      current.push(fragment);
      currentLength += length;
    });
    flush();
  });

  return { sentenceSources, jobs };
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

function renderTranslatableHtml(job) {
  const content = job.segments
    .map(
      (segment) =>
        `<span data-sentence="${segment.sentenceIndex}" data-fragment="${segment.fragmentIndex}">${escapeHtml(segment.text)}</span>`,
    )
    .join("");
  return `<pre>${content}</pre>`;
}

function readTranslatedHtml(value) {
  const parsed = new DOMParser().parseFromString(value, "text/html");
  parsed.querySelectorAll("i").forEach((node) => node.remove());
  return (parsed.body.textContent || "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\u200b/g, " ");
}

function readTranslatedSegments(value) {
  const parsed = new DOMParser().parseFromString(value, "text/html");
  parsed.querySelectorAll("i").forEach((node) => node.remove());
  const container = parsed.querySelector("pre") || parsed.body;
  const segments = [];
  let leadingText = "";
  let current = null;

  Array.from(container.childNodes).forEach((node) => {
    if (node.nodeType === 1 && node.matches?.("span[data-sentence]")) {
      current = {
        sentenceIndex: Number.parseInt(node.dataset.sentence || "", 10),
        fragmentIndex: Number.parseInt(node.dataset.fragment || "0", 10),
        text: node.textContent || "",
      };
      segments.push(current);
      return;
    }

    const text = node.textContent || "";
    if (current) current.text += text;
    else leadingText += text;
  });

  const validSegments = segments
    .filter((segment) => Number.isFinite(segment.sentenceIndex))
    .map((segment) => ({
      ...segment,
      text: segment.text.replace(/\u200b/g, " "),
    }));
  if (leadingText && validSegments.length) {
    validSegments[0].text = leadingText + validSegments[0].text;
  }

  return {
    text: readTranslatedHtml(value),
    segments: validSegments,
  };
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

async function translateBatch(jobs, sourceLanguage, targetLanguage, signal) {
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
            jobs.map(renderTranslatableHtml),
            sourceLanguage,
            targetLanguage,
          ],
          "te",
        ]),
        signal,
      });
      if (!response.ok) throw new Error(`Google returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length !== jobs.length) {
        throw new Error("Unexpected response");
      }
      return data[0].map((value) => readTranslatedSegments(String(value)));
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

function isWordCharacter(value) {
  return Boolean(value) && /[\p{L}\p{N}]/u.test(value);
}

function convertChineseQuotes(text, state) {
  const characters = Array.from(text);
  let result = "";

  characters.forEach((character, index) => {
    const previous = characters[index - 1] || "";
    const next = characters[index + 1] || "";

    if (character === "“") {
      result += "「";
      state.doubleOpen = false;
      return;
    }
    if (character === "”") {
      result += "」";
      state.doubleOpen = true;
      return;
    }
    if (character === '"') {
      result += state.doubleOpen ? "「" : "」";
      state.doubleOpen = !state.doubleOpen;
      return;
    }
    if (character === "‘") {
      result += "『";
      state.singleOpen = false;
      return;
    }
    if (character === "’") {
      if (isWordCharacter(previous) && isWordCharacter(next)) {
        result += character;
      } else {
        result += "』";
        state.singleOpen = true;
      }
      return;
    }
    if (character === "'") {
      if (isWordCharacter(previous) && isWordCharacter(next)) {
        result += character;
      } else {
        result += state.singleOpen ? "『" : "』";
        state.singleOpen = !state.singleOpen;
      }
      return;
    }
    result += character;
  });

  return result;
}

function joinTranslatedParts(parts, targetLanguage) {
  const needsSpace = !/^(zh|ja|ko)/i.test(targetLanguage);
  return parts.filter(Boolean).reduce((result, part) => {
    if (!result) return part;
    if (!needsSpace || /\s$/u.test(result) || /^\s/u.test(part)) return result + part;
    return `${result} ${part}`;
  }, "");
}

function formatParagraph(paragraph) {
  const quoteState = { doubleOpen: true, singleOpen: true };
  const sourceSentences = paragraph.sentences?.length
    ? paragraph.sentences
    : [{
        id: 0,
        source: paragraph.source,
        rawTranslation: paragraph.rawTranslation,
      }];
  const useChineseQuotes =
    settings.chineseQuotes && elements.targetLanguage.value === "zh-TW";
  const sentences = sourceSentences.map((sentence) => {
    const withBuiltIns = useChineseQuotes
      ? convertChineseQuotes(sentence.rawTranslation, quoteState)
      : sentence.rawTranslation;
    return {
      ...sentence,
      translation: applyRules(withBuiltIns),
    };
  });

  return {
    ...paragraph,
    sentences,
    translation: joinTranslatedParts(
      sentences.map((sentence) => sentence.translation),
      elements.targetLanguage.value,
    ).trim(),
  };
}

function reapplyFormatting() {
  paragraphs = paragraphs.map((paragraph) => formatParagraph(paragraph));
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
  reapplyFormatting();
  updateRuleStatus();
  if (paragraphs.length) renderCurrentResults();
}

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      settings = {
        ...DEFAULT_SETTINGS,
        chineseQuotes: typeof parsed.chineseQuotes === "boolean"
          ? parsed.chineseQuotes
          : DEFAULT_SETTINGS.chineseQuotes,
        liveTranslation: typeof parsed.liveTranslation === "boolean"
          ? parsed.liveTranslation
          : DEFAULT_SETTINGS.liveTranslation,
        mobileToolbarCollapsed: typeof parsed.mobileToolbarCollapsed === "boolean"
          ? parsed.mobileToolbarCollapsed
          : DEFAULT_SETTINGS.mobileToolbarCollapsed,
        mobileToolbarPreferenceSet: typeof parsed.mobileToolbarPreferenceSet === "boolean"
          ? parsed.mobileToolbarPreferenceSet
          : DEFAULT_SETTINGS.mobileToolbarPreferenceSet,
      };
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS };
    showToast("內建格式設定讀取失敗，已使用預設值。", "error");
  }
  elements.chineseQuotesToggle.checked = settings.chineseQuotes;
  elements.liveTranslationToggle.checked = settings.liveTranslation;
}

function saveSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  reapplyFormatting();
  updateRuleStatus();
  if (paragraphs.length) renderCurrentResults();
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
  const customCount = enabledRuleCount();
  const builtInCount = settings.chineseQuotes ? 1 : 0;
  const count = customCount + builtInCount;
  const descriptions = [];
  if (settings.chineseQuotes) descriptions.push("中文引號");
  if (customCount) descriptions.push(`${customCount} 條規則`);
  const summary = descriptions.join(" + ");

  elements.ruleCount.textContent = String(count);
  elements.ruleCount.hidden = count === 0;
  elements.rulesStatus.textContent = count ? `套用：${summary}` : "尚無文字處理";
  elements.appliedRules.textContent = count
    ? `已套用：${summary}`
    : "未套用文字處理";
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
  elements.mobileToolbarLanguageSummary.textContent = `${source} → ${target}`;
}

function persistSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function setMobileToolbarCollapsed(collapsed, rememberPreference = false) {
  settings.mobileToolbarCollapsed = collapsed;
  if (rememberPreference) settings.mobileToolbarPreferenceSet = true;
  elements.languageToolbar.classList.toggle("is-mobile-collapsed", collapsed);
  elements.mobileToolbarToggle.setAttribute("aria-expanded", String(!collapsed));
  elements.mobileToolbarToggle.setAttribute(
    "aria-label",
    collapsed ? "展開翻譯設定" : "收合翻譯設定",
  );
  elements.mobileToolbarActionText.textContent = collapsed ? "展開" : "收合設定";
  elements.mobileToolbarChevron.textContent = collapsed ? "⌄" : "⌃";
  persistSettings();
}

function maybeAutoCollapseMobileToolbar() {
  const isMobile = window.matchMedia
    ? window.matchMedia(MOBILE_TOOLBAR_MEDIA_QUERY).matches
    : window.innerWidth <= 720;
  if (!isMobile || settings.mobileToolbarPreferenceSet) return;
  setMobileToolbarCollapsed(true);
}

function updateLivePreviewStatus(message, updating = false) {
  elements.livePreviewStatus.textContent = message;
  elements.livePreviewStatus.hidden = !settings.liveTranslation;
  elements.livePreviewStatus.classList.toggle("is-updating", updating);
}

function clearLivePreview() {
  elements.livePreview.replaceChildren();
  elements.livePreview.hidden = true;
  elements.emptyPreview.hidden = false;
  elements.emptyTitle.textContent = settings.liveTranslation
    ? "輸入後會自動翻譯"
    : "譯文會出現在這裡";
  elements.emptyDescription.textContent = settings.liveTranslation
    ? "停止輸入約 0.9 秒後自動更新；只有變動的段落會重新翻譯。"
    : "完成後可懸浮或點擊句子，左右對應內容會同步亮起；點段落空白處則選取整段。";
  updateLivePreviewStatus("等待輸入");
}

function resetResult() {
  paragraphs = [];
  activeParagraph = null;
  activeSentence = null;
  elements.readingView.hidden = true;
  elements.composeView.hidden = false;
  elements.copyButton.hidden = true;
  elements.editButton.hidden = true;
  elements.translateButton.textContent = settings.liveTranslation
    ? "↻ 立即更新"
    : "✦ 開始翻譯";
  elements.paragraphPairs.replaceChildren();
  clearLivePreview();
  updateStats();
}

function setBusy(busy, completed = 0, total = 0) {
  elements.translateButton.hidden = busy;
  elements.stopButton.hidden = !busy;
  elements.progressStrip.hidden = !busy;
  if (!elements.emptyPreview.hidden) {
    elements.emptyTitle.textContent = busy
      ? "正在整理段落…"
      : settings.liveTranslation
        ? "輸入後會自動翻譯"
        : "譯文會出現在這裡";
  }
  if (settings.liveTranslation && busy) {
    updateLivePreviewStatus("正在更新…", true);
  }
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
  activeSentence = null;
  elements.paragraphPairs.querySelectorAll(".paragraph-pair").forEach((pair) => {
    pair.classList.toggle("is-active", Number(pair.dataset.id) === id);
    pair.classList.remove("has-active-sentence");
    pair.querySelectorAll(".sentence-segment").forEach((sentence) => {
      sentence.classList.remove("is-active");
    });
  });
}

function setActiveSentence(paragraphId, sentenceId) {
  activeParagraph = paragraphId;
  activeSentence = `${paragraphId}:${sentenceId}`;
  elements.paragraphPairs.querySelectorAll(".paragraph-pair").forEach((pair) => {
    const pairIsActive = Number(pair.dataset.id) === paragraphId;
    pair.classList.toggle("is-active", pairIsActive);
    pair.classList.toggle("has-active-sentence", pairIsActive);
    pair.querySelectorAll(".sentence-segment").forEach((sentence) => {
      sentence.classList.toggle(
        "is-active",
        pairIsActive && Number(sentence.dataset.sentenceId) === sentenceId,
      );
    });
  });
}

function appendSentenceSegments(card, paragraph, field, label) {
  paragraph.sentences.forEach((sentence) => {
    const segment = document.createElement("span");
    segment.className = "sentence-segment";
    segment.dataset.sentenceId = String(sentence.id);
    segment.tabIndex = 0;
    segment.setAttribute("role", "button");
    segment.setAttribute(
      "aria-label",
      `${label}第 ${paragraph.id + 1} 段第 ${sentence.id + 1} 句`,
    );
    segment.textContent = sentence[field];
    segment.addEventListener("mouseenter", () => {
      setActiveSentence(paragraph.id, sentence.id);
    });
    segment.addEventListener("focus", () => {
      setActiveSentence(paragraph.id, sentence.id);
    });
    segment.addEventListener("click", (event) => {
      event.stopPropagation();
      if (activeSentence === `${paragraph.id}:${sentence.id}`) {
        setActiveParagraph(paragraph.id);
      } else {
        setActiveSentence(paragraph.id, sentence.id);
      }
    });
    segment.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        segment.click();
      }
    });
    card.append(segment);
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
    source.lang = sentenceLocale(elements.sourceLanguage.value, paragraph.source);
    source.tabIndex = 0;
    source.setAttribute("aria-label", `原文第 ${paragraph.id + 1} 段`);
    appendSentenceSegments(source, paragraph, "source", "原文");

    const connector = document.createElement("div");
    connector.className = "pair-connector";
    connector.setAttribute("aria-hidden", "true");
    const number = document.createElement("span");
    number.textContent = String(paragraph.id + 1);
    connector.append(number);

    const translation = document.createElement("div");
    translation.className = "paragraph-card translation-card";
    translation.lang = sentenceLocale(
      elements.targetLanguage.value,
      paragraph.translation,
    );
    translation.tabIndex = 0;
    translation.setAttribute("aria-label", `譯文第 ${paragraph.id + 1} 段`);
    appendSentenceSegments(translation, paragraph, "translation", "譯文");

    pair.append(source, connector, translation);
    pair.addEventListener("mouseenter", () => setActiveParagraph(paragraph.id));
    pair.addEventListener("mouseleave", () => setActiveParagraph(null));
    pair.addEventListener("focusin", (event) => {
      if (!event.target.closest(".sentence-segment")) {
        setActiveParagraph(paragraph.id);
      }
    });
    pair.addEventListener("focusout", (event) => {
      if (!pair.contains(event.relatedTarget)) setActiveParagraph(null);
    });
    pair.addEventListener("click", (event) => {
      if (event.target.closest(".sentence-segment")) return;
      setActiveParagraph(activeParagraph === paragraph.id ? null : paragraph.id);
    });
    elements.paragraphPairs.append(pair);
  });

  const sentenceCount = paragraphs.reduce(
    (total, paragraph) => total + paragraph.sentences.length,
    0,
  );
  elements.pairCount.textContent = `${paragraphs.length} 段 · ${sentenceCount} 句`;
  elements.composeView.hidden = true;
  elements.readingView.hidden = false;
  elements.copyButton.hidden = false;
  elements.editButton.hidden = false;
  elements.translateButton.textContent = "✦ 重新翻譯";
  updateRuleStatus();
  updateStats();
  maybeAutoCollapseMobileToolbar();
}

function renderLivePreview() {
  elements.livePreview.replaceChildren();
  paragraphs.forEach((paragraph) => {
    const block = document.createElement("div");
    block.className = "live-paragraph";
    block.lang = sentenceLocale(
      elements.targetLanguage.value,
      paragraph.translation,
    );
    block.textContent = paragraph.translation;
    elements.livePreview.append(block);
  });

  const hasResults = paragraphs.length > 0;
  elements.emptyPreview.hidden = hasResults;
  elements.livePreview.hidden = !hasResults;
  elements.readingView.hidden = true;
  elements.composeView.hidden = false;
  elements.copyButton.hidden = !hasResults;
  elements.editButton.hidden = true;
  elements.translateButton.textContent = "↻ 立即更新";
  updateLivePreviewStatus(hasResults ? "已更新" : "等待輸入");
  updateRuleStatus();
  updateStats();
  if (hasResults) maybeAutoCollapseMobileToolbar();
}

function renderCurrentResults() {
  if (settings.liveTranslation) renderLivePreview();
  else renderParagraphs();
}

function fallbackAlignedSegments(job, translatedText, targetLanguage) {
  const sentenceIds = [...new Set(job.segments.map((segment) => segment.sentenceIndex))];
  const translatedSentences = segmentSentences(translatedText, targetLanguage);
  if (!sentenceIds.length) return [];
  if (sentenceIds.length === 1 || !translatedSentences.length) {
    return [{
      sentenceIndex: sentenceIds[0],
      fragmentIndex: 0,
      text: translatedText,
    }];
  }

  const buckets = sentenceIds.map(() => []);
  translatedSentences.forEach((text, index) => {
    const bucketIndex = Math.min(
      Math.floor((index * sentenceIds.length) / translatedSentences.length),
      sentenceIds.length - 1,
    );
    buckets[bucketIndex].push(text);
  });
  return sentenceIds.map((sentenceIndex, index) => ({
    sentenceIndex,
    fragmentIndex: 0,
    text: buckets[index].join(""),
  }));
}

function alignedSegmentsForJob(job, translated, targetLanguage) {
  const expectedIds = new Set(job.segments.map((segment) => segment.sentenceIndex));
  const preserved = translated.segments.filter((segment) =>
    expectedIds.has(segment.sentenceIndex),
  );
  const preservedIds = new Set(preserved.map((segment) => segment.sentenceIndex));
  if (preserved.length && [...expectedIds].every((id) => preservedIds.has(id))) {
    return preserved;
  }
  return fallbackAlignedSegments(job, translated.text, targetLanguage);
}

async function translateSources(
  sources,
  sourceLanguage,
  targetLanguage,
  signal,
  onProgress = () => {},
) {
  const { sentenceSources, jobs } = createSentenceJobs(sources, sourceLanguage);
  const batches = makeBatches(jobs);
  const results = new Map();
  let nextBatch = 0;
  let completed = 0;
  onProgress(0, batches.length);

  const worker = async () => {
    while (nextBatch < batches.length) {
      const batchIndex = nextBatch;
      nextBatch += 1;
      const batch = batches[batchIndex];
      const translated = await translateBatch(
        batch,
        sourceLanguage,
        targetLanguage,
        signal,
      );
      batch.forEach((job, index) => {
        results.set(`${job.paragraphIndex}:${job.partIndex}`, translated[index]);
      });
      completed += 1;
      onProgress(completed, batches.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(3, batches.length) }, () => worker()),
  );

  const translatedBySentence = new Map();
  jobs.forEach((job) => {
    const translated = results.get(`${job.paragraphIndex}:${job.partIndex}`);
    if (!translated) return;
    alignedSegmentsForJob(job, translated, targetLanguage).forEach((segment) => {
      const key = `${job.paragraphIndex}:${segment.sentenceIndex}`;
      const parts = translatedBySentence.get(key) || [];
      parts.push(segment.text);
      translatedBySentence.set(key, parts);
    });
  });

  return sources.map((source, paragraphIndex) => {
    const sentences = sentenceSources[paragraphIndex].map(
      (sentenceSource, sentenceIndex) => ({
        id: sentenceIndex,
        source: sentenceSource,
        rawTranslation: joinTranslatedParts(
          translatedBySentence.get(`${paragraphIndex}:${sentenceIndex}`) || [],
          targetLanguage,
        ),
      }),
    );
    return {
      id: paragraphIndex,
      source,
      rawTranslation: joinTranslatedParts(
        sentences.map((sentence) => sentence.rawTranslation),
        targetLanguage,
      ).trim(),
      sentences,
    };
  });
}

function liveCacheKey(source, sourceLanguage, targetLanguage) {
  return JSON.stringify([sourceLanguage, targetLanguage, source]);
}

function cacheRawParagraph(key, paragraph) {
  liveTranslationCache.set(key, {
    rawTranslation: paragraph.rawTranslation,
    sentences: paragraph.sentences.map((sentence) => ({ ...sentence })),
  });
}

function pruneLiveTranslationCache(activeKeys) {
  if (liveTranslationCache.size <= 240) return;
  for (const key of liveTranslationCache.keys()) {
    if (!activeKeys.has(key)) liveTranslationCache.delete(key);
    if (liveTranslationCache.size <= 200) break;
  }
}

function paragraphFromLiveCache(cached, source, id) {
  return formatParagraph({
    id,
    source,
    rawTranslation: cached.rawTranslation,
    sentences: cached.sentences.map((sentence) => ({ ...sentence })),
  });
}

async function performLiveTranslation(requestVersion) {
  if (!settings.liveTranslation || requestVersion !== liveTranslationVersion) return;
  const sources = parseParagraphs(elements.sourceEditor.value);
  const sourceLanguage = elements.sourceLanguage.value;
  const targetLanguage = elements.targetLanguage.value;
  if (!sources.length) {
    paragraphs = [];
    renderLivePreview();
    return;
  }
  if (sourceLanguage === targetLanguage) {
    updateLivePreviewStatus("語言不可相同");
    showToast("原文和譯文語言相同，換一邊再翻譯。", "error");
    return;
  }

  const missing = new Map();
  sources.forEach((source) => {
    const key = liveCacheKey(source, sourceLanguage, targetLanguage);
    if (!liveTranslationCache.has(key)) missing.set(key, source);
  });

  const controller = new AbortController();
  abortController = controller;

  try {
    if (missing.size) {
      setBusy(true, 0, 0);
      const missingEntries = [...missing.entries()];
      const translated = await translateSources(
        missingEntries.map(([, source]) => source),
        sourceLanguage,
        targetLanguage,
        controller.signal,
        (completed, total) => updateProgress(completed, total),
      );
      if (requestVersion !== liveTranslationVersion) return;
      translated.forEach((paragraph, index) => {
        cacheRawParagraph(missingEntries[index][0], paragraph);
      });
    }

    if (requestVersion !== liveTranslationVersion) return;
    const activeKeys = new Set();
    paragraphs = sources.map((source, index) => {
      const key = liveCacheKey(source, sourceLanguage, targetLanguage);
      activeKeys.add(key);
      return paragraphFromLiveCache(liveTranslationCache.get(key), source, index);
    });
    pruneLiveTranslationCache(activeKeys);
    renderLivePreview();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error(error);
      updateLivePreviewStatus("更新失敗");
      showToast("即時翻譯暫時沒有回應，請稍後再試一次。", "error");
    }
  } finally {
    if (abortController === controller) {
      setBusy(false);
      abortController = null;
    }
  }
}

function scheduleLiveTranslation(immediate = false) {
  if (!settings.liveTranslation) return;
  clearTimeout(liveTranslationTimer);
  liveTranslationVersion += 1;
  abortController?.abort();

  if (!parseParagraphs(elements.sourceEditor.value).length) {
    paragraphs = [];
    renderLivePreview();
    return;
  }

  const requestVersion = liveTranslationVersion;
  updateLivePreviewStatus(immediate ? "準備更新…" : "等待輸入停止…", true);
  liveTranslationTimer = window.setTimeout(
    () => performLiveTranslation(requestVersion),
    immediate ? 0 : LIVE_TRANSLATION_DELAY,
  );
}

async function translate() {
  if (settings.liveTranslation) {
    scheduleLiveTranslation(true);
    return;
  }

  const sources = parseParagraphs(elements.sourceEditor.value);
  if (!sources.length) {
    showToast("先放一點原文進來啦，空氣沒辦法翻譯。", "error");
    return;
  }
  if (elements.sourceLanguage.value === elements.targetLanguage.value) {
    showToast("原文和譯文語言相同，換一邊再翻譯。", "error");
    return;
  }

  const controller = new AbortController();
  abortController = controller;
  paragraphs = [];
  setBusy(true, 0, 0);

  try {
    const rawParagraphs = await translateSources(
      sources,
      elements.sourceLanguage.value,
      elements.targetLanguage.value,
      controller.signal,
      (completed, total) => updateProgress(completed, total),
    );
    paragraphs = rawParagraphs.map((paragraph) => formatParagraph(paragraph));
    renderParagraphs();
    const sentenceCount = paragraphs.reduce(
      (total, paragraph) => total + paragraph.sentences.length,
      0,
    );
    showToast(`翻譯完成，共 ${paragraphs.length} 段、${sentenceCount} 句。`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      showToast("已停止翻譯。");
    } else {
      console.error(error);
      showToast("免費 Google 翻譯暫時沒有回應，請稍後再試一次。", "error");
    }
  } finally {
    if (abortController === controller) {
      setBusy(false);
      abortController = null;
    }
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

function setLiveTranslation(enabled) {
  clearTimeout(liveTranslationTimer);
  liveTranslationVersion += 1;
  abortController?.abort();
  paragraphs = [];
  settings.liveTranslation = enabled;
  saveSettings();
  resetResult();
  if (enabled) scheduleLiveTranslation(true);
  showToast(enabled ? "即時翻譯已開啟。" : "即時翻譯已關閉。");
}

elements.sourceEditor.addEventListener("input", () => {
  updateStats();
  scheduleLiveTranslation();
});
elements.sourceLanguage.addEventListener("change", () => {
  liveTranslationCache.clear();
  updateLanguageHeadings();
  resetResult();
  scheduleLiveTranslation(true);
});
elements.targetLanguage.addEventListener("change", () => {
  liveTranslationCache.clear();
  updateLanguageHeadings();
  resetResult();
  scheduleLiveTranslation(true);
});
elements.translateButton.addEventListener("click", translate);
elements.stopButton.addEventListener("click", () => {
  clearTimeout(liveTranslationTimer);
  if (settings.liveTranslation) {
    liveTranslationVersion += 1;
    updateLivePreviewStatus("已停止");
  }
  abortController?.abort();
});
elements.editButton.addEventListener("click", resetResult);
elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(
    paragraphs.map((paragraph) => paragraph.translation).join("\n\n"),
  );
  showToast("譯文已複製。");
});
elements.clearButton.addEventListener("click", () => {
  clearTimeout(liveTranslationTimer);
  liveTranslationVersion += 1;
  liveTranslationCache.clear();
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
  liveTranslationCache.clear();
  updateLanguageHeadings();
  resetResult();
  scheduleLiveTranslation(true);
});

elements.rulesButton.addEventListener("click", () => {
  renderRules();
  elements.rulesDialog.showModal();
});
elements.chineseQuotesToggle.addEventListener("input", (event) => {
  settings.chineseQuotes = event.currentTarget.checked;
  saveSettings();
});
elements.liveTranslationToggle.addEventListener("input", (event) => {
  setLiveTranslation(event.currentTarget.checked);
});
elements.mobileToolbarToggle.addEventListener("click", () => {
  setMobileToolbarCollapsed(!settings.mobileToolbarCollapsed, true);
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
loadSettings();
updateLanguageHeadings();
setMobileToolbarCollapsed(settings.mobileToolbarCollapsed);
updateRuleStatus();
resetResult();
