// Configure PDF.js worker
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// State management
let selectedFiles = [];
let previewItems = []; // Array of { name, objectUrl, fileIdx, pageIdx }
let extractedCards = [];
let activeCardIndex = 0;
let currentImageIdx = 0;
let cardScanItems = []; // Array of { label, imageIdx, cardIndex, pageRange }
let userApiKey = localStorage.getItem('GEMINI_API_KEY') || '';
let currentZoom = 1;
let isProcessingFiles = false;

// DOM Elements
const apiKeyStatus = document.getElementById('apiKeyStatus');
const settingsModal = document.getElementById('settingsModal');
const apiKeyInput = document.getElementById('apiKeyInput');
const btnSettings = document.getElementById('btnSettings');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const btnSaveSettings = document.getElementById('btnSaveSettings');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const filePreviewBar = document.getElementById('filePreviewBar');
const selectedFilesCount = document.getElementById('selectedFilesCount');
const processingBadge = document.getElementById('processingBadge');
const thumbnailsGrid = document.getElementById('thumbnailsGrid');
const btnClearFiles = document.getElementById('btnClearFiles');
const btnExtract = document.getElementById('btnExtract');
const extractSpinner = document.getElementById('extractSpinner');

const uploadSection = document.getElementById('uploadSection');
const reviewWorkspace = document.getElementById('reviewWorkspace');
const btnNewUpload = document.getElementById('btnNewUpload');
const btnExportCsv = document.getElementById('btnExportCsv');

const employeeTabs = document.getElementById('employeeTabs');
const imageSelect = document.getElementById('imageSelect');
const btnPrevImage = document.getElementById('btnPrevImage');
const btnNextImage = document.getElementById('btnNextImage');

const cardPreviewImage = document.getElementById('cardPreviewImage');
const imagePlaceholder = document.getElementById('imagePlaceholder');

const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnResetZoom = document.getElementById('btnResetZoom');
const zoomLevel = document.getElementById('zoomLevel');

const metaEmpId = document.getElementById('metaEmpId');
const metaMonth = document.getElementById('metaMonth');
const metaYear = document.getElementById('metaYear');
const tableBody = document.getElementById('tableBody');
const btnAddRow = document.getElementById('btnAddRow');
const rowCountBadge = document.getElementById('rowCountBadge');

// Initialization
async function init() {
  checkApiConfig();
  setupEventListeners();
}

async function checkApiConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.hasEnvKey || userApiKey) {
      apiKeyStatus.innerHTML = `<span class="status-dot success"></span><span class="status-text">API Key Ready</span>`;
    } else {
      apiKeyStatus.innerHTML = `<span class="status-dot warning"></span><span class="status-text">API Key Missing</span>`;
    }
  } catch (err) {
    console.error('Config check error:', err);
  }
}

function setupEventListeners() {
  // Settings Modal
  btnSettings.addEventListener('click', () => {
    apiKeyInput.value = userApiKey;
    settingsModal.classList.remove('hidden');
  });
  btnCancelSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
  btnSaveSettings.addEventListener('click', () => {
    userApiKey = apiKeyInput.value.trim();
    localStorage.setItem('GEMINI_API_KEY', userApiKey);
    settingsModal.classList.add('hidden');
    checkApiConfig();
  });

  // File Upload Handlers
  dropzone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') {
      fileInput.click();
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelection(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(Array.from(e.target.files));
    }
  });

  btnClearFiles.addEventListener('click', () => {
    selectedFiles = [];
    previewItems = [];
    fileInput.value = '';
    renderFilePreviews();
  });

  btnExtract.addEventListener('click', runExtraction);
  btnNewUpload.addEventListener('click', resetWorkspace);
  btnExportCsv.addEventListener('click', exportToCsv);

  // Zoom controls
  btnZoomIn.addEventListener('click', () => setZoom(currentZoom + 0.25));
  btnZoomOut.addEventListener('click', () => setZoom(currentZoom - 0.25));
  btnResetZoom.addEventListener('click', () => setZoom(1));

  // Image selector dropdown & Arrow Navigation
  imageSelect.addEventListener('change', (e) => {
    selectImageByIndex(parseInt(e.target.value, 10));
  });

  btnPrevImage.addEventListener('click', () => navigateImage(-1));
  btnNextImage.addEventListener('click', () => navigateImage(1));

  // Data editing & row adding
  metaEmpId.addEventListener('input', (e) => {
    if (extractedCards[activeCardIndex]) {
      extractedCards[activeCardIndex].employee_id = e.target.value;
      updateTabTitles();
      buildScanItemsMapping();
      renderImageSelector();
    }
  });
  metaMonth.addEventListener('input', (e) => {
    if (extractedCards[activeCardIndex]) extractedCards[activeCardIndex].month = e.target.value;
  });
  metaYear.addEventListener('input', (e) => {
    if (extractedCards[activeCardIndex]) extractedCards[activeCardIndex].year = e.target.value;
  });

  btnAddRow.addEventListener('click', () => {
    if (extractedCards[activeCardIndex]) {
      const records = extractedCards[activeCardIndex].records;
      const nextDate = records.length > 0 ? records[records.length - 1].date + 1 : 1;
      records.push({ date: nextDate, shift: 'A', time_in: '06:00', time_out: '14:00', ot_hours: '' });
      renderActiveTable();
    }
  });
}

function selectImageByIndex(scanIdx) {
  if (cardScanItems[scanIdx]) {
    currentImageIdx = scanIdx;
    const scan = cardScanItems[currentImageIdx];

    // Display corresponding image preview
    if (previewItems[scan.imageIdx]) {
      displayPreviewImage(previewItems[scan.imageIdx]);
    }
    updateNavButtons();

    // Synchronize Right Side Data Records Panel
    if (scan.cardIndex !== activeCardIndex && extractedCards[scan.cardIndex]) {
      activeCardIndex = scan.cardIndex;
      renderTabs();
      renderActiveMeta();
      renderActiveTable();

      // Scroll table to Date 17 if page 2
      if (scan.pageRange === 'Days 17-31') {
        scrollToDate(17);
      } else {
        scrollToDate(1);
      }
    }
  }
}

function scrollToDate(dateNum) {
  const row = tableBody.querySelector(`input[data-field="date"][value="${dateNum}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.focus();
  }
}

function navigateImage(delta) {
  const newIdx = currentImageIdx + delta;
  if (newIdx >= 0 && newIdx < cardScanItems.length) {
    imageSelect.value = newIdx;
    selectImageByIndex(newIdx);
  }
}

function updateNavButtons() {
  btnPrevImage.disabled = (currentImageIdx <= 0);
  btnNextImage.disabled = (currentImageIdx >= cardScanItems.length - 1);
}

async function handleFileSelection(files) {
  isProcessingFiles = true;
  processingBadge.classList.remove('hidden');
  btnExtract.disabled = true;

  selectedFiles = [...selectedFiles, ...files];
  renderFilePreviews();

  await buildPreviewItems();

  isProcessingFiles = false;
  processingBadge.classList.add('hidden');
  btnExtract.disabled = false;
  renderFilePreviews();
}

async function buildPreviewItems() {
  previewItems = [];
  for (let fileIdx = 0; fileIdx < selectedFiles.length; fileIdx++) {
    const file = selectedFiles[fileIdx];
    if (file.type.startsWith('image/')) {
      previewItems.push({
        name: file.name,
        objectUrl: URL.createObjectURL(file),
        fileIdx
      });
    } else if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      if (window.pdfjsLib) {
        const pages = await renderPdfPagesToImages(file, fileIdx);
        previewItems.push(...pages);
      } else {
        previewItems.push({
          name: file.name,
          objectUrl: '',
          fileIdx
        });
      }
    }
  }
}

async function renderPdfPagesToImages(pdfFile, fileIdx) {
  try {
    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      // Scale 1.5 and 0.80 JPEG quality produces lightweight ~120KB page images for Vision OCR
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      pages.push({
        name: `${pdfFile.name} (Page ${i})`,
        objectUrl: canvas.toDataURL('image/jpeg', 0.80),
        fileIdx,
        pageIdx: i
      });
    }
    return pages;
  } catch (err) {
    console.error('Failed to render PDF pages:', err);
    return [];
  }
}

function renderFilePreviews() {
  thumbnailsGrid.innerHTML = '';
  if (selectedFiles.length === 0) {
    filePreviewBar.classList.add('hidden');
    return;
  }

  filePreviewBar.classList.remove('hidden');
  selectedFilesCount.textContent = `${selectedFiles.length} file(s) selected (${previewItems.length} preview pages)`;

  previewItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'thumb-card';

    if (item.objectUrl) {
      const img = document.createElement('img');
      img.src = item.objectUrl;
      card.appendChild(img);
    } else {
      const pdfIcon = document.createElement('div');
      pdfIcon.style.padding = '20px';
      pdfIcon.style.color = '#fff';
      pdfIcon.textContent = '📄 PDF File';
      card.appendChild(pdfIcon);
    }

    const name = document.createElement('div');
    name.className = 'thumb-name';
    name.textContent = item.name;
    card.appendChild(name);

    thumbnailsGrid.appendChild(card);
  });
}

// Client-side batch extraction (chunks pages into 2-page lightweight JPEG requests to guarantee Vercel 4.5MB limit is never exceeded)
async function runExtraction() {
  if (selectedFiles.length === 0 || isProcessingFiles) return;

  extractSpinner.classList.remove('hidden');
  btnExtract.disabled = true;

  const btnTextElem = btnExtract.querySelector('.btn-text-content');
  const originalBtnText = btnTextElem ? btnTextElem.textContent : '✨ Extract Attendance Data with Gemini AI';

  try {
    // Prepare lightweight File objects for each rendered page scan image
    let itemsToProcess = [];
    if (previewItems.length > 0) {
      itemsToProcess = await Promise.all(previewItems.map(async (item, idx) => {
        try {
          if (item.objectUrl) {
            const res = await fetch(item.objectUrl);
            const blob = await res.blob();
            return new File([blob], `page_${idx + 1}.jpg`, { type: 'image/jpeg' });
          }
        } catch (e) {
          console.warn(`Failed to convert preview item ${idx + 1} to JPEG file:`, e);
        }
        return selectedFiles[item.fileIdx] || selectedFiles[0];
      }));
    } else {
      itemsToProcess = [...selectedFiles];
    }

    // Send 2 pages per HTTP request batch (~240KB payload per request)
    const BATCH_SIZE = 2;
    const totalBatches = Math.ceil(itemsToProcess.length / BATCH_SIZE);
    let allExtractedCards = [];

    for (let b = 0; b < totalBatches; b++) {
      const chunk = itemsToProcess.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      
      if (btnTextElem) {
        btnTextElem.textContent = `✨ Extracting Batch ${b + 1} of ${totalBatches}...`;
      }

      const formData = new FormData();
      chunk.forEach(file => formData.append('files', file));
      formData.append('pageCount', chunk.length.toString());

      const headers = {};
      if (userApiKey) headers['x-api-key'] = userApiKey;

      const res = await fetch('/api/extract', {
        method: 'POST',
        headers,
        body: formData
      });

      let rawText = '';
      try {
        rawText = await res.text();
      } catch (e) {
        throw new Error(`Batch ${b + 1} network error: ${e.message}`);
      }

      if (!res.ok) {
        if (res.status === 413 || rawText.includes('Request Entity Too Large')) {
          throw new Error(`Batch ${b + 1} payload exceeded server body limit (413).`);
        }
        try {
          const errObj = JSON.parse(rawText);
          throw new Error(errObj.error || `Server error (HTTP ${res.status})`);
        } catch (jsonErr) {
          throw new Error(`Server error (HTTP ${res.status}): ${rawText.substring(0, 100)}`);
        }
      }

      let result;
      try {
        result = JSON.parse(rawText);
      } catch (jsonErr) {
        throw new Error(`Batch ${b + 1} invalid server response: ${rawText.substring(0, 100)}`);
      }

      if (!result.success) {
        throw new Error(result.error || `Batch ${b + 1} extraction failed`);
      }

      if (result.data && result.data.cards) {
        allExtractedCards.push(...result.data.cards);
      }
    }

    if (btnTextElem) btnTextElem.textContent = originalBtnText;

    if (allExtractedCards.length === 0) {
      alert('No attendance records could be extracted from the provided files.');
      return;
    }

    // Merge and deduplicate records client-side across batches
    extractedCards = mergeExtractedCardsClientSide(allExtractedCards);

    activeCardIndex = 0;
    currentImageIdx = 0;
    buildScanItemsMapping();

    uploadSection.classList.add('hidden');
    reviewWorkspace.classList.remove('hidden');
    renderWorkspace();

  } catch (err) {
    if (btnTextElem) btnTextElem.textContent = originalBtnText;
    alert('Extraction Error: ' + err.message);
  } finally {
    extractSpinner.classList.add('hidden');
    btnExtract.disabled = false;
  }
}

// Client-side merging helper for batch card extractions
function mergeExtractedCardsClientSide(rawCards) {
  const map = new Map();
  let unknownCounter = 1;

  rawCards.forEach(card => {
    const idTrim = (card.employee_id || '').trim();
    const nameTrim = (card.employee_name || '').trim();
    const rawKey = (idTrim || nameTrim).toLowerCase().replace(/[^a-z0-9]/g, '');
    const isBlankOrUnknown = !rawKey || rawKey === 'unknown';

    let groupKey = isBlankOrUnknown ? `__unknown_${unknownCounter++}` : rawKey;

    if (!map.has(groupKey)) {
      map.set(groupKey, {
        employee_id: idTrim || nameTrim || `UNKNOWN_${unknownCounter}`,
        employee_name: nameTrim || idTrim || 'Unknown Employee',
        month: card.month || 'July',
        year: card.year || '2026',
        recordsMap: new Map()
      });
    }

    const empObj = map.get(groupKey);

    if (card.records && Array.isArray(card.records)) {
      card.records.forEach(rec => {
        const dateNum = parseInt(rec.date, 10);
        if (dateNum >= 1 && dateNum <= 31) {
          const existing = empObj.recordsMap.get(dateNum);
          if (!existing || (rec.time_in || rec.time_out)) {
            empObj.recordsMap.set(dateNum, {
              date: dateNum,
              shift: rec.shift || '',
              time_in: rec.time_in || '',
              time_out: rec.time_out || '',
              ot_hours: rec.ot_hours || ''
            });
          }
        }
      });
    }
  });

  const merged = [];
  for (const empObj of map.values()) {
    const sortedRecords = Array.from(empObj.recordsMap.values()).sort((a, b) => a.date - b.date);
    merged.push({
      employee_id: empObj.employee_id,
      employee_name: empObj.employee_name,
      month: empObj.month,
      year: empObj.year,
      records: sortedRecords
    });
  }
  return merged;
}

// Build 2-page scan mapping for employee cards and preview images
function buildScanItemsMapping() {
  cardScanItems = [];
  let globalImageIdx = 0;

  extractedCards.forEach((card, cardIdx) => {
    const empName = card.employee_id || card.employee_name || `Emp ${cardIdx + 1}`;

    // Page 1 (Days 1-16)
    if (card.has_page1 !== false) {
      const imgIdx = Math.min(globalImageIdx, previewItems.length - 1);
      cardScanItems.push({
        label: `${empName} - Days 1 to 16 (Page 1)`,
        imageIdx: imgIdx,
        cardIndex: cardIdx,
        pageRange: 'Days 1-16'
      });
      globalImageIdx++;
    }

    // Page 2 (Days 17-31)
    if (card.has_page2 !== false) {
      const imgIdx = Math.min(globalImageIdx, previewItems.length - 1);
      cardScanItems.push({
        label: `${empName} - Days 17 to 31 (Page 2)`,
        imageIdx: imgIdx,
        cardIndex: cardIdx,
        pageRange: 'Days 17-31'
      });
      globalImageIdx++;
    }
  });

  // Fallback if cardScanItems is empty
  if (cardScanItems.length === 0) {
    previewItems.forEach((item, i) => {
      cardScanItems.push({
        label: item.name || `Scan ${i + 1}`,
        imageIdx: i,
        cardIndex: Math.min(i, extractedCards.length - 1),
        pageRange: 'Days 1-31'
      });
    });
  }
}

function renderWorkspace() {
  renderTabs();
  renderImageSelector();
  renderActiveMeta();
  renderActiveTable();
}

function renderTabs() {
  employeeTabs.innerHTML = '';
  extractedCards.forEach((card, idx) => {
    const btn = document.createElement('button');
    btn.className = `tab-btn ${idx === activeCardIndex ? 'active' : ''}`;
    const cardTitle = card.employee_id || card.employee_name || `Emp ${idx + 1}`;
    btn.textContent = `Card ${idx + 1}: ${cardTitle}`;
    btn.addEventListener('click', () => {
      activeCardIndex = idx;

      // Find first scan belonging to this cardIndex
      const matchingScanIdx = cardScanItems.findIndex(s => s.cardIndex === activeCardIndex);
      if (matchingScanIdx !== -1) {
        currentImageIdx = matchingScanIdx;
        imageSelect.value = currentImageIdx;
        if (previewItems[cardScanItems[currentImageIdx].imageIdx]) {
          displayPreviewImage(previewItems[cardScanItems[currentImageIdx].imageIdx]);
        }
        updateNavButtons();
      }

      renderTabs();
      renderActiveMeta();
      renderActiveTable();
    });
    employeeTabs.appendChild(btn);
  });
}

function updateTabTitles() {
  const tabs = employeeTabs.querySelectorAll('.tab-btn');
  tabs.forEach((tab, idx) => {
    if (extractedCards[idx]) {
      const cardTitle = extractedCards[idx].employee_id || extractedCards[idx].employee_name || `Emp ${idx + 1}`;
      tab.textContent = `Card ${idx + 1}: ${cardTitle}`;
    }
  });
}

function renderImageSelector() {
  imageSelect.innerHTML = '';

  if (cardScanItems.length === 0) {
    imageSelect.classList.add('hidden');
    cardPreviewImage.classList.add('hidden');
    imagePlaceholder.classList.remove('hidden');
    btnPrevImage.disabled = true;
    btnNextImage.disabled = true;
    return;
  }

  imageSelect.classList.remove('hidden');

  cardScanItems.forEach((scan, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = scan.label;
    imageSelect.appendChild(opt);
  });

  currentImageIdx = Math.min(currentImageIdx, cardScanItems.length - 1);
  imageSelect.value = currentImageIdx;

  const currentScan = cardScanItems[currentImageIdx];
  if (currentScan && previewItems[currentScan.imageIdx]) {
    displayPreviewImage(previewItems[currentScan.imageIdx]);
  }
  updateNavButtons();
}

function displayPreviewImage(item) {
  if (item && item.objectUrl) {
    cardPreviewImage.src = item.objectUrl;
    cardPreviewImage.classList.remove('hidden');
    imagePlaceholder.classList.add('hidden');
  } else {
    cardPreviewImage.classList.add('hidden');
    imagePlaceholder.classList.remove('hidden');
  }
  setZoom(1);
}

function setZoom(level) {
  currentZoom = Math.max(0.4, Math.min(3.5, level));
  cardPreviewImage.style.transform = `scale(${currentZoom})`;
  zoomLevel.textContent = `${Math.round(currentZoom * 100)}%`;
}

function renderActiveMeta() {
  const card = extractedCards[activeCardIndex];
  if (!card) return;
  metaEmpId.value = card.employee_id || card.employee_name || '';
  metaMonth.value = card.month || 'July';
  metaYear.value = card.year || '2026';
}

function renderActiveTable() {
  tableBody.innerHTML = '';
  const card = extractedCards[activeCardIndex];
  if (!card || !card.records) return;

  rowCountBadge.textContent = `${card.records.length} records`;

  card.records.forEach((rec, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="number" value="${rec.date}" data-field="date" data-idx="${idx}"></td>
      <td><input type="text" value="${rec.shift || ''}" data-field="shift" data-idx="${idx}"></td>
      <td><input type="text" value="${rec.time_in || ''}" data-field="time_in" data-idx="${idx}" placeholder="HH:MM"></td>
      <td><input type="text" value="${rec.time_out || ''}" data-field="time_out" data-idx="${idx}" placeholder="HH:MM"></td>
      <td><input type="text" value="${rec.ot_hours || ''}" data-field="ot_hours" data-idx="${idx}"></td>
      <td><button class="btn-icon btn-delete-row" data-idx="${idx}">❌</button></td>
    `;
    tableBody.appendChild(tr);
  });

  // Table cell change event listener
  tableBody.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = e.target.dataset.idx;
      const field = e.target.dataset.field;
      let val = e.target.value;
      if (field === 'date') val = parseInt(val, 10) || 1;
      card.records[idx][field] = val;
    });
  });

  // Delete row listener
  tableBody.querySelectorAll('.btn-delete-row').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      card.records.splice(idx, 1);
      renderActiveTable();
    });
  });
}

function resetWorkspace() {
  selectedFiles = [];
  previewItems = [];
  extractedCards = [];
  cardScanItems = [];
  currentImageIdx = 0;
  fileInput.value = '';
  renderFilePreviews();
  reviewWorkspace.classList.add('hidden');
  uploadSection.classList.remove('hidden');
}

function exportToCsv() {
  if (extractedCards.length === 0) return;

  let csvContent = "Emp ID,Month,Year,Date,Time In,Time Out\n";

  extractedCards.forEach(card => {
    const empId = card.employee_id || card.employee_name || 'Unknown';
    const month = card.month || 'July';
    const year = card.year || '2026';

    card.records.forEach(rec => {
      csvContent += `"${empId}","${month}","${year}",${rec.date},"${rec.time_in || ''}","${rec.time_out || ''}"\n`;
    });
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `attendance_extracted_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

document.addEventListener('DOMContentLoaded', init);
