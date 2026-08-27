# 長文對照翻譯

目前版本：**v1.1.0**
可直接放在 GitHub Pages 使用的純靜態長文翻譯工具，不需要安裝套件、設定伺服器或申請 API Key。

## 功能

- 長文自動切塊翻譯，頁面不設 5000 字元上限。
- 桌機左右對照；可同步標示相應段落，也能懸浮或點擊逐句對照。
- 手機將同一組原文與譯文上下排列。
- 內建可開關的中文引號格式：雙引號轉為「」，單引號轉為『』。
- 普通文字替換及進階 Regex，依序套用到譯文。
- 規則儲存在瀏覽器本機，支援 JSON 匯入及匯出。
- 一鍵複製完整譯文、交換語言及中止翻譯。

## 注意事項

本工具完全為 VIBE CODING 產物，純粹自用並為了自己方便而上傳，不保證維護任何 Bug 或問題。

本工具使用 Google 網頁翻譯採用的公用端點，而不是 Google Cloud Translation 付費 API。它不需要使用者金鑰，但也不是 Google 對第三方正式承諾的公開 API；Google 日後若修改或停用端點，翻譯功能可能需要更新。

文字會直接傳送至 Google 翻譯。本網站本身不會上傳或保存原文及譯文；替換規則則保存在目前瀏覽器的 `localStorage`。

## 部署到 GitHub Pages

1. 在 GitHub 建立一個新的 repository。
2. 把這個資料夾內的 `index.html`、`styles.css`、`app.js`、`favicon.svg` 上傳到 repository 根目錄。
3. 進入 repository 的 **Settings → Pages**。
4. 在 **Build and deployment** 選擇 **Deploy from a branch**。
5. Branch 選擇 `main`，資料夾選擇 `/ (root)`，按下 **Save**。
6. 等 GitHub 顯示網站網址後即可使用。