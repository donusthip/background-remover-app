const dropzone = document.querySelector('#dropzone');
const fileInput = document.querySelector('#fileInput');
const workSection = document.querySelector('#workSection');
const results = document.querySelector('#results');
const template = document.querySelector('#resultTemplate');
const summary = document.querySelector('#summary');
const downloadAll = document.querySelector('#downloadAll');
const selectAll = document.querySelector('#selectAll');
const cancelSelected = document.querySelector('#cancelSelected');
const deleteSelected = document.querySelector('#deleteSelected');
const clearCompleted = document.querySelector('#clearCompleted');
const saveHome = document.querySelector('#saveHome');
const sendDrive = document.querySelector('#sendDrive');
const sendEmail = document.querySelector('#sendEmail');
const recipientEmail = document.querySelector('#recipientEmail');
const emailField = document.querySelector('#emailField');
const shareButton = document.querySelector('#shareButton');
const sharePanel = document.querySelector('#sharePanel');
const shareUrl = document.querySelector('#shareUrl');
const copyShare = document.querySelector('#copyShare');
const stopShare = document.querySelector('#stopShare');
const sourceDevice = document.querySelector('#sourceDevice');
const sourceDriveLink = document.querySelector('#sourceDriveLink');
const driveLinkPanel = document.querySelector('#driveLinkPanel');
const driveFolderUrl = document.querySelector('#driveFolderUrl');
const checkDriveFolder = document.querySelector('#checkDriveFolder');
const driveFolderResult = document.querySelector('#driveFolderResult');
const importDriveFolder = document.querySelector('#importDriveFolder');
const deliveryPanel = document.querySelector('#deliveryPanel');
const clientTitle = document.querySelector('#clientTitle');
const nicknameInput = document.querySelector('#nicknameInput');
const saveNickname = document.querySelector('#saveNickname');
const machineQueueState = document.querySelector('#machineQueueState');
const machineQueueCount = document.querySelector('#machineQueueCount');
const machineQueueList = document.querySelector('#machineQueueList');
const imagePreviewModal = document.querySelector('#imagePreviewModal');
const imagePreviewStage = document.querySelector('#imagePreviewStage');
const imagePreviewCanvas = document.querySelector('#imagePreviewCanvas');
const imagePreviewLarge = document.querySelector('#imagePreviewLarge');
const imagePreviewTitle = document.querySelector('#imagePreviewTitle');
const zoomLevel = document.querySelector('#zoomLevel');
const startErase = document.querySelector('#startErase');
const eraseControls = document.querySelector('#eraseControls');
const eraserSize = document.querySelector('#eraserSize');
const eraserSizeLabel = document.querySelector('#eraserSizeLabel');
const undoErase = document.querySelector('#undoErase');
const resetErase = document.querySelector('#resetErase');
const saveErase = document.querySelector('#saveErase');
const manualEditCanvas = document.querySelector('#manualEditCanvas');
const imagePreviewHelp = document.querySelector('#imagePreviewHelp');
const brushEraseMode = document.querySelector('#brushEraseMode');
const smartEraseMode = document.querySelector('#smartEraseMode');
const restoreEraseMode = document.querySelector('#restoreEraseMode');
const smartTolerance = document.querySelector('#smartTolerance');
const smartToleranceLabel = document.querySelector('#smartToleranceLabel');
const brushCursor = document.querySelector('#brushCursor');
const editorShortcutHelp = document.querySelector('#editorShortcutHelp');
if (startErase) startErase.textContent = 'แก้ Mask / เก็บขอบ';
if (brushEraseMode) brushEraseMode.textContent = 'Subtract from mask (ลบออก)';
if (smartEraseMode) smartEraseMode.textContent = 'Smart subtract';
if (restoreEraseMode) restoreEraseMode.textContent = 'Add to mask (คืนภาพ)';
const completedJobs = [];
let total = 0;
let finished = 0;
let cancelled = 0;
let previewBackground = 'checker';
let thisClientProfile = null;
let imagePreviewScale = 1;
let imagePreviewBaseWidth = 0;
let imagePreviewBaseHeight = 0;
let imagePreviewDragging = false;
let imagePreviewPointerX = 0;
let imagePreviewPointerY = 0;
let activePreviewCard = null;
let manualEditMode = false;
let manualEditSource = null;
let manualEditOriginalSource = null;
let eraseStrokes = [];
let activeEraseStroke = null;
let manualEditTool = 'brush';
let middleMousePanning = false;
let activeSmartDrag = null;
let brushCursorClientX = 0;
let brushCursorClientY = 0;
let brushCursorInside = false;
const fullResultImageCache = new Map();
const originalImageCache = new Map();
const isHomeDashboard = document.body.dataset.localMode === 'true';
const JOB_STORAGE_KEY = 'bg-remover-job-history-v1';
const CLIENT_ID_KEY = 'bg-remover-client-id-v1';
const NICKNAME_KEY = 'bg-remover-nickname-v1';
const IMAGE_PREVIEW_MIN_ZOOM = 0.5;
const IMAGE_PREVIEW_MAX_ZOOM = 16;
const IMAGE_PRELOAD_CACHE_LIMIT = 24;
const clientId = localStorage.getItem(CLIENT_ID_KEY) ||
  (crypto.randomUUID ? crypto.randomUUID() : `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`);
localStorage.setItem(CLIENT_ID_KEY, clientId);

function readStoredJobs() {
  try {
    const jobs = JSON.parse(localStorage.getItem(JOB_STORAGE_KEY) || '[]');
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    return Array.isArray(jobs) ? jobs.filter(job => job.createdAt > cutoff).slice(-200) : [];
  } catch (_) {
    return [];
  }
}

function saveCardRecord(card) {
  if (!card.dataset.jobId) return;
  const records = readStoredJobs();
  const existing = records.find(item => item.jobId === card.dataset.jobId);
  const record = {
    jobId: card.dataset.jobId,
    name: card.querySelector('.file-title strong').textContent,
    statusUrl: card.dataset.statusUrl || `/api/jobs/${card.dataset.jobId}/status`,
    cancelUrl: card.dataset.cancelUrl || `/api/jobs/${card.dataset.jobId}/cancel`,
    selected: Boolean(card.querySelector('.card-checkbox')?.checked),
    state: card.dataset.state || 'queued',
    sourceUrl: card.dataset.sourceUrl || '',
    resultDriveUrl: card.dataset.resultDriveUrl || '',
    resultFolder: card.dataset.resultFolder || '',
    createdAt: existing?.createdAt || Date.now()
  };
  const updated = records.filter(item => item.jobId !== record.jobId);
  updated.push(record);
  localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(updated.slice(-200)));
}

function removeStoredJob(jobId) {
  const updated = readStoredJobs().filter(item => item.jobId !== jobId);
  localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(updated));
}

function imageUrlForCache(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.href);
    parsed.searchParams.delete('edit');
    return parsed.href;
  } catch (_) {
    return url;
  }
}

function imageUrlWithFreshToken(url, tokenName = 'edit') {
  try {
    const parsed = new URL(url, window.location.href);
    parsed.searchParams.set(tokenName, String(Date.now()));
    return parsed.href;
  } catch (_) {
    return url;
  }
}

function preloadImage(url, cache) {
  const key = imageUrlForCache(url);
  if (!key) return null;
  const existing = cache.get(key);
  if (existing) return existing;
  const image = new Image();
  image.decoding = 'async';
  const entry = {image, loaded: false, failed: false, ready: null};
  entry.ready = new Promise((resolve, reject) => {
    image.onload = () => {
      entry.loaded = true;
      resolve(image);
    };
    image.onerror = () => {
      entry.failed = true;
      cache.delete(key);
      reject(new Error('preload failed'));
    };
  }).catch(() => null);
  cache.set(key, entry);
  trimImageCache(cache);
  image.src = key;
  return entry;
}

function trimImageCache(cache) {
  while (cache.size > IMAGE_PRELOAD_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function cachedImage(url, cache) {
  const entry = cache.get(imageUrlForCache(url));
  return entry?.loaded ? entry.image : null;
}

function preloadCardEditImages(card) {
  if (!card || card.dataset.state !== 'completed') return;
  const fullUrl = card.querySelector('.download')?.href || '';
  preloadImage(fullUrl, fullResultImageCache);
  if (card.dataset.sourceUrl) preloadImage(card.dataset.sourceUrl, originalImageCache);
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => enqueue([...fileInput.files]));
['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault(); dropzone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault(); dropzone.classList.remove('dragging');
}));
dropzone.addEventListener('drop', event => enqueue([...event.dataTransfer.files]));

function enqueue(files) {
  files = files.filter(file => file.type.startsWith('image/') || /\.(tif|tiff)$/i.test(file.name));
  if (!files.length) return;
  workSection.classList.remove('hidden');
  total += files.length;
  files.forEach(file => createCard(file));
  updateSummary();
  const driveBatch = makeDriveBatchName();
  processSequential(files, driveBatch);
}

function makeDriveBatchName() {
  const now = new Date();
  const pad = (number, length = 2) => String(number).padStart(length, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

async function processSequential(files, driveBatch) {
  for (const file of files) {
    const card = document.querySelector(`[data-key="${CSS.escape(file._key)}"]`);
    await processOne(file, card, driveBatch);
  }
}

function createCard(file) {
  file._key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const card = template.content.firstElementChild.cloneNode(true);
  card.dataset.key = file._key;
  card.dataset.state = 'uploading';
  card.querySelector('.file-title strong').textContent = file.name;
  const img = card.querySelector('img');
  img.src = URL.createObjectURL(file);
  card.querySelector('.preview').className = `preview ${previewBackground}`;
  results.prepend(card);
  setCardOwner(card, thisClientProfile?.display_name || 'งานของคุณ', true);
  bindCardSelection(card);
}

function setCardOwner(card, displayName, isMine) {
  card.dataset.isMine = isMine ? 'true' : 'false';
  const label = card.querySelector('.owner-label');
  label.textContent = `${displayName || 'ผู้ใช้ไม่ระบุเครื่อง'}${isMine ? ' · งานของคุณ' : ''}`;
  label.classList.toggle('mine', Boolean(isMine));
}

function createRemoteCard(job) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.dataset.key = job.job_id;
  card.dataset.jobId = job.job_id;
  card.dataset.cancelUrl = `/api/jobs/${job.job_id}/cancel`;
  card.dataset.statusUrl = job.status_url || `/api/jobs/${job.job_id}/status`;
  card.dataset.sourceUrl = job.source_url || '';
  card.dataset.resultDriveUrl = job.result_drive_url || '';
  card.dataset.resultFolder = job.result_folder || '';
  card.dataset.state = 'queued';
  setCardOwner(card, job.owner_display_name || thisClientProfile?.display_name, Boolean(job.is_mine));
  card.querySelector('.file-title strong').textContent = job.original_name;
  const remoteImage = card.querySelector('img');
  if (job.source_url) remoteImage.src = job.source_url;
  else remoteImage.removeAttribute('src');
  card.querySelector('.preview').className = `preview ${previewBackground}`;
  results.append(card);
  bindCardSelection(card);
  showQueuePosition(card, job.queue_ahead || 0);
  saveCardRecord(card);
  return card;
}

async function processOne(file, card, driveBatch) {
  const form = new FormData();
  form.append('file', file);
  form.append('save_home', String(saveHome.checked));
  form.append('send_drive', String(sendDrive.checked));
  form.append('send_email', String(sendEmail.checked));
  form.append('recipient_email', recipientEmail.value.trim());
  form.append('drive_batch', driveBatch);
  form.append('client_id', clientId);
  try {
    const response = await fetch('/api/process', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'ประมวลผลไม่สำเร็จ');
    const badge = card.querySelector('.badge');
    card.dataset.jobId = data.job_id;
    card.dataset.cancelUrl = `/api/jobs/${data.job_id}/cancel`;
    card.dataset.statusUrl = data.status_url;
    card.dataset.state = 'queued';
    badge.textContent = 'เข้าคิวแล้ว';
    showQueuePosition(card, data.queue_ahead || 0);
    saveCardRecord(card);
    pollJob(data.status_url, card);
  } catch (error) {
    markError(card, error.message);
  }
}

function showQueuePosition(card, ahead) {
  if (card.dataset.state === 'cancelled') return;
  card.dataset.state = 'queued';
  const layer = card.querySelector('.processing-layer');
  layer.querySelector('strong').textContent = ahead > 0
    ? `มี ${ahead} รูปก่อนหน้าคุณ`
    : 'คุณเป็นคิวถัดไป';
  layer.querySelector('span').textContent = 'ระบบจะเริ่มให้อัตโนมัติ ไม่ต้องอัปโหลดใหม่';
  card.querySelector('.result-meta').textContent = ahead > 0
    ? `รออีก ${ahead} รูปก่อนถึงคิวของคุณ`
    : 'กำลังรอเครื่องเริ่มงานของคุณ';
  saveCardRecord(card);
}

function showProcessingStage(card, stage) {
  if (card.dataset.state === 'cancelled') return;
  card.dataset.state = 'processing';
  card.dataset.stage = stage;
  if (stage === 'cancelling') card.dataset.cancelRequested = 'true';
  const messages = {
    downloading_drive: ['กำลังรับรูปจาก Google Drive', 'กำลังดาวน์โหลดต้นฉบับเข้าคอมของ Donut…'],
    removing_background: ['ถึงคิวของคุณแล้ว', 'กำลังลบพื้นหลังและเก็บขอบละเอียด…'],
    creating_preview: ['ลบพื้นหลังเสร็จแล้ว', 'กำลังสร้างภาพตัวอย่าง…'],
    saving_home: ['กำลังจัดส่งผลงาน', 'กำลังเก็บสำเนาที่คอมบ้าน…']
    ,uploading_drive: ['กำลังส่งเข้า Google Drive', 'กำลังสร้างโฟลเดอร์วันเวลาและส่งไฟล์…'],
    returning_drive: ['กำลังส่งกลับ Google Drive', 'กำลังอัปโหลด PNG เข้าโฟลเดอร์ผลลัพธ์ในลิงก์เดิม…']
    ,cancelling: ['กำลังยกเลิกรูปนี้', 'ระบบจะลบไฟล์งานทันทีที่ออกจากขั้นตอนคำนวณปัจจุบัน…']
  };
  const [title, detail] = messages[stage] || ['กำลังทำงาน', 'กรุณารอสักครู่…'];
  const layer = card.querySelector('.processing-layer');
  layer.querySelector('strong').textContent = title;
  layer.querySelector('span').textContent = detail;
  const badge = card.querySelector('.badge');
  badge.textContent = 'กำลังทำ';
  card.querySelector('.result-meta').textContent = detail;
  saveCardRecord(card);
  updateBulkActions();
}

async function pollJob(statusUrl, card) {
  if (card.dataset.polling === 'true') return;
  card.dataset.polling = 'true';
  try {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const response = await fetch(statusUrl, {cache: 'no-store'});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'ตรวจสอบคิวไม่สำเร็จ');
      if (data.state === 'queued') {
        showQueuePosition(card, data.queue_ahead || 0);
        continue;
      }
      if (data.state === 'processing') {
        showProcessingStage(card, data.stage);
        continue;
      }
      if (data.state === 'error') throw new Error(data.error || 'ประมวลผลไม่สำเร็จ');
      if (data.state === 'cancelled') {
        markCancelled(card);
        return;
      }
      if (data.state === 'completed') {
        finishCard(card, data);
        return;
      }
    }
  } catch (error) {
    markError(card, error.message);
  } finally {
    card.dataset.polling = 'false';
  }
}

function finishCard(card, data) {
  card.dataset.state = 'completed';
  card.dataset.jobId = data.job_id;
  card.dataset.sourceUrl = data.source_url || card.dataset.sourceUrl || '';
  card.querySelector('img').src = `${data.preview_url}?v=${Date.now()}`;
  card.querySelector('.processing-layer')?.remove();
  const badge = card.querySelector('.badge');
  badge.className = 'badge done';
  badge.textContent = 'เสร็จแล้ว';
  card.querySelector('.result-meta').textContent = data.recovered
    ? `${data.width.toLocaleString()} × ${data.height.toLocaleString()} พิกเซล · กู้คืนไฟล์ผลลัพธ์สำเร็จแล้ว`
    : `${data.width.toLocaleString()} × ${data.height.toLocaleString()} พิกเซล · ${data.seconds} วินาที · ตรวจขอบ ${data.tiles} ส่วน`;
  const deliveryStatus = card.querySelector('.delivery-status');
  const deliveryMessages = [];
  if (data.delivery?.home?.ok) {
    deliveryMessages.push(`✓ เก็บที่คอมของ Donut · BG-Received/${data.delivery.home.folder}`);
  }
  if (data.delivery?.drive?.ok) {
    deliveryMessages.push(`✓ ส่งเข้า Drive ของ Donut · ลบBG/${data.delivery.drive.folder}`);
  } else if (data.delivery?.drive?.requested) {
    deliveryMessages.push('ส่ง Google Drive ไม่สำเร็จ: ยังไม่พบโฟลเดอร์ ลบBG');
  }
  if (data.delivery?.source_drive?.ok) {
    deliveryMessages.push(`✓ ส่งกลับโฟลเดอร์ต้นทาง · ${data.delivery.source_drive.folder}`);
  } else if (data.delivery?.source_drive?.requested) {
    deliveryMessages.push('ส่งกลับ Google Drive ไม่สำเร็จ กรุณาตรวจสิทธิ์ Editor');
  }
  if (deliveryMessages.length) {
    deliveryStatus.textContent = deliveryMessages.join(' · ');
    deliveryStatus.classList.remove('hidden');
  }
  const actions = card.querySelector('.result-actions');
  actions.classList.remove('hidden');
  const link = actions.querySelector('.download');
  link.href = data.download_url;
  link.download = data.output_name;
  preloadCardEditImages(card);
  completedJobs.push(data.job_id);
  finished += 1;
  updateSummary();
  saveCardRecord(card);
  updateBulkActions();
}

function markError(card, message) {
  if (card.dataset.state === 'cancelled') return;
  card.dataset.state = 'error';
  card.querySelector('.processing-layer')?.remove();
  const badge = card.querySelector('.badge');
  badge.className = 'badge error';
  badge.textContent = 'ไม่สำเร็จ';
  card.querySelector('.result-meta').textContent = 'ไฟล์นี้ยังไม่ได้รับการแก้ไข';
  const box = card.querySelector('.error-message');
  box.textContent = message;
  box.classList.remove('hidden');
  finished += 1;
  updateSummary();
  saveCardRecord(card);
  updateBulkActions();
}

function markCancelled(card) {
  card.dataset.state = 'cancelled';
  if (card.dataset.cancelCounted === 'true') {
    updateBulkActions();
    return;
  }
  card.dataset.cancelCounted = 'true';
  card.classList.add('cancelled');
  card.querySelector('.processing-layer')?.remove();
  const badge = card.querySelector('.badge');
  badge.className = 'badge error';
  badge.textContent = 'ยกเลิกแล้ว';
  card.querySelector('.result-meta').textContent = 'ยกเลิกรูปนี้แล้ว และจะไม่มีไฟล์ผลลัพธ์ถูกส่งออก';
  finished += 1;
  cancelled += 1;
  updateSummary();
  saveCardRecord(card);
  updateBulkActions();
}

function bindCardSelection(card) {
  card.querySelector('.card-checkbox').addEventListener('change', () => {
    saveCardRecord(card);
    updateBulkActions();
  });
  const previewImage = card.querySelector('.preview img');
  previewImage.title = 'ดับเบิลคลิกเพื่อดูภาพขนาดใหญ่';
  previewImage.addEventListener('dblclick', () => openImagePreview(card));
  updateBulkActions();
}

function renderImagePreviewSize(center = false) {
  if (!imagePreviewBaseWidth || !imagePreviewBaseHeight) return;
  const oldWidth = Math.max(1, imagePreviewStage.scrollWidth);
  const oldHeight = Math.max(1, imagePreviewStage.scrollHeight);
  const centerRatioX = (imagePreviewStage.scrollLeft + imagePreviewStage.clientWidth / 2) / oldWidth;
  const centerRatioY = (imagePreviewStage.scrollTop + imagePreviewStage.clientHeight / 2) / oldHeight;
  const width = imagePreviewBaseWidth * imagePreviewScale;
  const height = imagePreviewBaseHeight * imagePreviewScale;
  const previewElement = manualEditMode ? manualEditCanvas : imagePreviewLarge;
  previewElement.style.width = `${width}px`;
  previewElement.style.height = `${height}px`;
  imagePreviewCanvas.style.width = `${Math.max(imagePreviewStage.clientWidth, width)}px`;
  imagePreviewCanvas.style.height = `${Math.max(imagePreviewStage.clientHeight, height)}px`;
  zoomLevel.textContent = `${Math.round(imagePreviewScale * 100)}%`;
  requestAnimationFrame(() => {
    if (center) {
      imagePreviewStage.scrollLeft = Math.max(0, (imagePreviewStage.scrollWidth - imagePreviewStage.clientWidth) / 2);
      imagePreviewStage.scrollTop = Math.max(0, (imagePreviewStage.scrollHeight - imagePreviewStage.clientHeight) / 2);
    } else {
      imagePreviewStage.scrollLeft = Math.max(0, centerRatioX * imagePreviewStage.scrollWidth - imagePreviewStage.clientWidth / 2);
      imagePreviewStage.scrollTop = Math.max(0, centerRatioY * imagePreviewStage.scrollHeight - imagePreviewStage.clientHeight / 2);
    }
  });
}

function resetImagePreview() {
  imagePreviewScale = 1;
  renderImagePreviewSize(true);
}

function setImagePreviewZoom(nextScale) {
  imagePreviewScale = Math.min(IMAGE_PREVIEW_MAX_ZOOM, Math.max(IMAGE_PREVIEW_MIN_ZOOM, nextScale));
  renderImagePreviewSize();
}

function openImagePreview(card) {
  const cardImage = card.querySelector('.preview img');
  const fullResult = card.dataset.state === 'completed'
    ? card.querySelector('.download')?.href
    : '';
  const imageUrl = fullResult || cardImage.currentSrc || cardImage.src;
  if (!imageUrl) return;
  preloadCardEditImages(card);
  activePreviewCard = card;
  manualEditMode = false;
  manualEditCanvas.classList.add('hidden');
  imagePreviewLarge.classList.remove('hidden');
  eraseControls.classList.add('hidden');
  editorShortcutHelp.classList.add('hidden');
  imagePreviewModal.classList.remove('editing');
  startErase.classList.toggle('hidden', card.dataset.state !== 'completed');
  imagePreviewHelp.textContent = 'ซูมก่อนแล้วจับลากได้ทุกจุดบนภาพ · ใช้ปุ่มลูกศรช่วยเลื่อน · กด Esc เพื่อปิด';
  imagePreviewTitle.textContent = card.querySelector('.file-title strong')?.textContent || 'ดูภาพขนาดใหญ่';
  imagePreviewModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const showLoadedImage = (loadedImage = imagePreviewLarge) => {
    const fitRatio = Math.min(
      (imagePreviewStage.clientWidth * 0.92) / loadedImage.naturalWidth,
      (imagePreviewStage.clientHeight * 0.92) / loadedImage.naturalHeight,
      1
    );
    imagePreviewBaseWidth = Math.max(1, loadedImage.naturalWidth * fitRatio);
    imagePreviewBaseHeight = Math.max(1, loadedImage.naturalHeight * fitRatio);
    resetImagePreview();
  };
  imagePreviewLarge.onload = showLoadedImage;
  const preloaded = cachedImage(imageUrl, fullResultImageCache);
  if (preloaded) {
    imagePreviewLarge.onload = null;
    imagePreviewLarge.src = preloaded.src;
    showLoadedImage(preloaded);
  } else {
    imagePreviewLarge.src = imageUrl;
  }
}

function closeImagePreview() {
  cancelManualErase();
  imagePreviewModal.classList.add('hidden');
  imagePreviewLarge.removeAttribute('src');
  imagePreviewLarge.onload = null;
  activePreviewCard = null;
  document.body.style.overflow = '';
}

function updateEraseButtons() {
  undoErase.disabled = eraseStrokes.length === 0;
  resetErase.disabled = eraseStrokes.length === 0;
  saveErase.disabled = eraseStrokes.length === 0;
}

function drawEraseStroke(context, stroke) {
  if (!stroke.points.length) return;
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = stroke.size;
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(first.x, first.y);
    stroke.points.slice(1).forEach(point => context.lineTo(point.x, point.y));
    context.stroke();
  }
  context.restore();
}

function drawRestoreSegment(context, first, second, size) {
  const radius = size / 2;
  const minX = Math.max(0, Math.floor(Math.min(first.x, second.x) - radius - 2));
  const minY = Math.max(0, Math.floor(Math.min(first.y, second.y) - radius - 2));
  const maxX = Math.min(manualEditCanvas.width, Math.ceil(Math.max(first.x, second.x) + radius + 2));
  const maxY = Math.min(manualEditCanvas.height, Math.ceil(Math.max(first.y, second.y) + radius + 2));
  const angle = Math.atan2(second.y - first.y, second.x - first.x);
  const offsetX = Math.sin(angle) * radius;
  const offsetY = Math.cos(angle) * radius;
  context.save();
  context.beginPath();
  context.arc(first.x, first.y, radius, 0, Math.PI * 2);
  context.moveTo(second.x + radius, second.y);
  context.arc(second.x, second.y, radius, 0, Math.PI * 2);
  context.moveTo(first.x + offsetX, first.y - offsetY);
  context.lineTo(second.x + offsetX, second.y - offsetY);
  context.lineTo(second.x - offsetX, second.y + offsetY);
  context.lineTo(first.x - offsetX, first.y + offsetY);
  context.closePath();
  context.clip();
  if (maxX > minX && maxY > minY) {
    context.globalCompositeOperation = 'source-over';
    context.drawImage(
      manualEditOriginalSource || manualEditSource,
      minX, minY, maxX - minX, maxY - minY,
      minX, minY, maxX - minX, maxY - minY
    );
  }
  context.restore();
}

function drawRestoreStroke(context, stroke) {
  if (!stroke.points.length) return;
  if (stroke.points.length === 1) {
    drawRestoreSegment(context, stroke.points[0], stroke.points[0], stroke.size);
    return;
  }
  for (let index = 1; index < stroke.points.length; index += 1) {
    drawRestoreSegment(context, stroke.points[index - 1], stroke.points[index], stroke.size);
  }
}

function applySmartErase(operation) {
  const context = manualEditCanvas.getContext('2d');
  const width = manualEditCanvas.width;
  const height = manualEditCanvas.height;
  const seedX = Math.max(0, Math.min(width - 1, Math.round(operation.x)));
  const seedY = Math.max(0, Math.min(height - 1, Math.round(operation.y)));
  const seedPixel = context.getImageData(seedX, seedY, 1, 1).data;
  if (seedPixel[3] < 8) return {ok: false, reason: 'transparent', count: 0};
  const seedR = seedPixel[0];
  const seedG = seedPixel[1];
  const seedB = seedPixel[2];
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const tolerance = operation.tolerance;
  const distanceLimit = tolerance * tolerance * 3;
  const matches = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] < 8) return false;
    const red = pixels[offset] - seedR;
    const green = pixels[offset + 1] - seedG;
    const blue = pixels[offset + 2] - seedB;
    return red * red + green * green + blue * blue <= distanceLimit;
  };
  const stack = [seedX, seedY];
  const maximum = Math.min(Math.floor(width * height * 0.4), 8000000);
  let count = 0;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    let left = x;
    while (left >= 0 && matches(left, y)) left -= 1;
    left += 1;
    let spanUp = false;
    let spanDown = false;
    for (let scanX = left; scanX < width && matches(scanX, y); scanX += 1) {
      const offset = (y * width + scanX) * 4;
      pixels[offset + 3] = 0;
      count += 1;
      if (count > maximum) return {ok: false, reason: 'too_large', count};
      const upMatches = y > 0 && matches(scanX, y - 1);
      if (upMatches && !spanUp) stack.push(scanX, y - 1);
      spanUp = upMatches;
      const downMatches = y < height - 1 && matches(scanX, y + 1);
      if (downMatches && !spanDown) stack.push(scanX, y + 1);
      spanDown = downMatches;
    }
  }
  context.putImageData(imageData, 0, 0);
  return {ok: count > 0, count};
}

function redrawManualEdit() {
  if (!manualEditSource) return;
  const context = manualEditCanvas.getContext('2d');
  context.clearRect(0, 0, manualEditCanvas.width, manualEditCanvas.height);
  context.globalCompositeOperation = 'source-over';
  context.drawImage(manualEditSource, 0, 0);
  eraseStrokes.forEach(operation => {
    if (operation.type === 'smart' || operation.type === 'smart-drag') {
      operation.points.forEach(point => applySmartErase({...point, tolerance: operation.tolerance}));
    } else if (operation.type === 'restore') {
      drawRestoreStroke(context, operation);
    } else {
      drawEraseStroke(context, operation);
    }
  });
}

function setManualEditTool(tool) {
  manualEditTool = tool;
  brushEraseMode.classList.toggle('active', tool === 'brush');
  smartEraseMode.classList.toggle('active', tool === 'smart');
  restoreEraseMode.classList.toggle('active', tool === 'restore');
  manualEditCanvas.classList.toggle('smart-tool', tool === 'smart');
  manualEditCanvas.classList.toggle('restore-tool', tool === 'restore');
  updateBrushCursor();
  imagePreviewHelp.textContent = tool === 'smart'
    ? 'กดลากผ่านส่วนที่ไม่ต้องการ ระบบจะลบพื้นที่เชื่อมต่อให้อย่างต่อเนื่อง · ปรับความไวต่ำก่อนเพื่อรักษาขอบ'
    : tool === 'restore'
      ? 'ลบพลาดให้กดลากระบายตรงส่วนที่หาย ภาพเดิมบริเวณนั้นจะกลับมา'
      : 'ลากยางลบบนส่วนที่ไม่ต้องการ · กดล้อเมาส์ค้างเพื่อลากภาพ · ตรวจให้ดีก่อนบันทึก';
}

function updateBrushCursor(event = null) {
  if (event) {
    brushCursorClientX = event.clientX;
    brushCursorClientY = event.clientY;
  }
  const shouldShow = manualEditMode && brushCursorInside && !middleMousePanning && manualEditTool !== 'smart';
  brushCursor.classList.toggle('hidden', !shouldShow);
  if (!shouldShow || !manualEditCanvas.width) return;
  const rect = manualEditCanvas.getBoundingClientRect();
  const diameter = Math.max(6, Number(eraserSize.value) * (rect.width / manualEditCanvas.width));
  brushCursor.style.width = `${diameter}px`;
  brushCursor.style.height = `${diameter}px`;
  brushCursor.style.left = `${brushCursorClientX}px`;
  brushCursor.style.top = `${brushCursorClientY}px`;
  brushCursor.classList.toggle('restore', manualEditTool === 'restore');
}

function cancelManualErase() {
  if (!manualEditMode) return;
  manualEditMode = false;
  manualEditSource = null;
  manualEditOriginalSource = null;
  eraseStrokes = [];
  activeEraseStroke = null;
  activeSmartDrag = null;
  brushCursorInside = false;
  brushCursor.classList.add('hidden');
  manualEditCanvas.classList.add('hidden');
  imagePreviewLarge.classList.remove('hidden');
  eraseControls.classList.add('hidden');
  imagePreviewModal.classList.remove('editing');
  startErase.classList.toggle('hidden', activePreviewCard?.dataset.state !== 'completed');
  imagePreviewHelp.textContent = 'ซูมก่อนแล้วจับลากได้ทุกจุดบนภาพ · ใช้ปุ่มลูกศรช่วยเลื่อน · กด Esc เพื่อปิด';
  if (imagePreviewLarge.naturalWidth) {
    const fitRatio = Math.min(
      (imagePreviewStage.clientWidth * 0.92) / imagePreviewLarge.naturalWidth,
      (imagePreviewStage.clientHeight * 0.92) / imagePreviewLarge.naturalHeight,
      1
    );
    imagePreviewBaseWidth = imagePreviewLarge.naturalWidth * fitRatio;
    imagePreviewBaseHeight = imagePreviewLarge.naturalHeight * fitRatio;
    resetImagePreview();
  }
}

async function beginManualErase() {
  if (!activePreviewCard?.dataset.jobId || activePreviewCard.dataset.state !== 'completed') return;
  startErase.disabled = true;
  imagePreviewHelp.textContent = 'กำลังเตรียมภาพความละเอียดเต็มสำหรับเก็บงาน…';
  try {
    const resultUrl = activePreviewCard.querySelector('.download').href;
    let source = cachedImage(resultUrl, fullResultImageCache);
    if (!source) {
      source = new Image();
      source.decoding = 'async';
      source.src = imageUrlWithFreshToken(resultUrl);
      await source.decode();
      preloadImage(resultUrl, fullResultImageCache);
    }
    let originalSource = null;
    const sourceUrl = activePreviewCard.dataset.sourceUrl || '';
    if (sourceUrl) {
      try {
        originalSource = cachedImage(sourceUrl, originalImageCache);
        if (!originalSource) {
          originalSource = new Image();
          originalSource.decoding = 'async';
          originalSource.src = imageUrlWithFreshToken(sourceUrl);
          await originalSource.decode();
          preloadImage(sourceUrl, originalImageCache);
        }
        if (originalSource.naturalWidth !== source.naturalWidth || originalSource.naturalHeight !== source.naturalHeight) {
          originalSource = null;
        }
      } catch (_) {
        originalSource = null;
      }
    }
    manualEditSource = source;
    manualEditOriginalSource = originalSource || source;
    manualEditCanvas.width = source.naturalWidth;
    manualEditCanvas.height = source.naturalHeight;
    eraseStrokes = [];
    activeEraseStroke = null;
    activeSmartDrag = null;
    manualEditMode = true;
    setManualEditTool('brush');
    redrawManualEdit();
    imagePreviewLarge.classList.add('hidden');
    manualEditCanvas.classList.remove('hidden');
    eraseControls.classList.remove('hidden');
    editorShortcutHelp.classList.remove('hidden');
    imagePreviewModal.classList.add('editing');
    startErase.classList.add('hidden');
    const fitRatio = Math.min(
      (imagePreviewStage.clientWidth * 0.92) / source.naturalWidth,
      (imagePreviewStage.clientHeight * 0.92) / source.naturalHeight,
      1
    );
    imagePreviewBaseWidth = source.naturalWidth * fitRatio;
    imagePreviewBaseHeight = source.naturalHeight * fitRatio;
    resetImagePreview();
    updateEraseButtons();
    imagePreviewHelp.textContent = 'ลากยางลบบนส่วนที่ไม่ต้องการ · กดล้อเมาส์ค้างเพื่อลากภาพ · ตรวจให้ดีก่อนบันทึก';
  } catch (_) {
    imagePreviewHelp.textContent = 'เปิดภาพสำหรับแก้ไขไม่สำเร็จ กรุณาลองใหม่';
  } finally {
    startErase.disabled = false;
  }
}

function canvasPoint(event) {
  const rect = manualEditCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (manualEditCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (manualEditCanvas.height / rect.height),
  };
}

startErase.addEventListener('click', beginManualErase);
brushEraseMode.addEventListener('click', () => setManualEditTool('brush'));
smartEraseMode.addEventListener('click', () => setManualEditTool('smart'));
restoreEraseMode.addEventListener('click', () => setManualEditTool('restore'));
eraserSize.addEventListener('input', () => {
  eraserSizeLabel.textContent = `${eraserSize.value} px`;
  updateBrushCursor();
});
smartTolerance.addEventListener('input', () => {
  smartToleranceLabel.textContent = smartTolerance.value;
});
function undoLastManualEdit() {
  if (!eraseStrokes.length) return;
  eraseStrokes.pop();
  redrawManualEdit();
  updateEraseButtons();
}

function changeEraserSize(amount) {
  const minimum = Number(eraserSize.min);
  const maximum = Number(eraserSize.max);
  eraserSize.value = String(Math.max(minimum, Math.min(maximum, Number(eraserSize.value) + amount)));
  eraserSizeLabel.textContent = `${eraserSize.value} px`;
  updateBrushCursor();
}

undoErase.addEventListener('click', undoLastManualEdit);
resetErase.addEventListener('click', () => {
  eraseStrokes = [];
  redrawManualEdit();
  updateEraseButtons();
});
document.querySelector('#cancelErase').addEventListener('click', cancelManualErase);

function applySmartDragPoint(point) {
  if (!activeSmartDrag) return;
  const previous = activeSmartDrag.points.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 24) return;
  const result = applySmartErase({...point, tolerance: activeSmartDrag.tolerance});
  if (result.ok) {
    activeSmartDrag.points.push(point);
    activeSmartDrag.removed += result.count;
    if (!activeSmartDrag.added) {
      eraseStrokes.push(activeSmartDrag);
      activeSmartDrag.added = true;
    }
    imagePreviewHelp.textContent = `ลากลบต่อเนื่องแล้ว ${activeSmartDrag.removed.toLocaleString()} พิกเซล · หากกินขอบให้กดย้อนกลับและลดความไว`;
  } else if (result.reason === 'too_large') {
    redrawManualEdit();
    imagePreviewHelp.textContent = 'พื้นที่กว้างเกินไป ระบบยกเลิกจุดนั้นเพื่อป้องกันลบทั้งภาพ · ลดความไวแล้วลองใหม่';
  }
  updateEraseButtons();
}

manualEditCanvas.addEventListener('pointerdown', event => {
  if (!manualEditMode) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.button === 1) {
    middleMousePanning = true;
    imagePreviewPointerX = event.clientX;
    imagePreviewPointerY = event.clientY;
    manualEditCanvas.classList.add('middle-panning');
    updateBrushCursor();
    manualEditCanvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  if (manualEditTool === 'smart') {
    activeSmartDrag = {
      type: 'smart-drag',
      tolerance: Number(smartTolerance.value),
      points: [],
      removed: 0,
      added: false,
    };
    manualEditCanvas.setPointerCapture(event.pointerId);
    applySmartDragPoint(canvasPoint(event));
    return;
  }
  activeEraseStroke = {
    type: manualEditTool === 'restore' ? 'restore' : 'brush',
    size: Number(eraserSize.value),
    points: [canvasPoint(event)],
  };
  eraseStrokes.push(activeEraseStroke);
  manualEditCanvas.setPointerCapture(event.pointerId);
  if (activeEraseStroke.type === 'restore') {
    drawRestoreStroke(manualEditCanvas.getContext('2d'), activeEraseStroke);
  } else {
    drawEraseStroke(manualEditCanvas.getContext('2d'), activeEraseStroke);
  }
  updateEraseButtons();
});
manualEditCanvas.addEventListener('pointermove', event => {
  updateBrushCursor(event);
  if (middleMousePanning) {
    event.preventDefault();
    imagePreviewStage.scrollLeft -= event.clientX - imagePreviewPointerX;
    imagePreviewStage.scrollTop -= event.clientY - imagePreviewPointerY;
    imagePreviewPointerX = event.clientX;
    imagePreviewPointerY = event.clientY;
    return;
  }
  if (activeSmartDrag) {
    event.preventDefault();
    applySmartDragPoint(canvasPoint(event));
    return;
  }
  if (!activeEraseStroke) return;
  event.preventDefault();
  activeEraseStroke.points.push(canvasPoint(event));
  const segment = {size: activeEraseStroke.size, points: activeEraseStroke.points.slice(-2)};
  if (activeEraseStroke.type === 'restore') {
    drawRestoreStroke(manualEditCanvas.getContext('2d'), segment);
  } else {
    drawEraseStroke(manualEditCanvas.getContext('2d'), segment);
  }
});
['pointerup', 'pointercancel'].forEach(name => manualEditCanvas.addEventListener(name, () => {
  activeEraseStroke = null;
  activeSmartDrag = null;
  middleMousePanning = false;
  manualEditCanvas.classList.remove('middle-panning');
  updateBrushCursor();
}));
manualEditCanvas.addEventListener('pointerenter', event => {
  brushCursorInside = true;
  updateBrushCursor(event);
});
manualEditCanvas.addEventListener('pointerleave', () => {
  brushCursorInside = false;
  updateBrushCursor();
});
manualEditCanvas.addEventListener('auxclick', event => {
  if (event.button === 1) event.preventDefault();
});

saveErase.addEventListener('click', async () => {
  if (!activePreviewCard?.dataset.jobId || !eraseStrokes.length) return;
  if (!confirm('บันทึกส่วนที่ลบออกจาก PNG บนเว็บหรือไม่?\n\nสำเนาที่ส่งเข้า Google Drive หรือ BG-Received ก่อนหน้านี้จะไม่ถูกแก้ไข')) return;
  saveErase.disabled = true;
  saveErase.textContent = 'กำลังบันทึก…';
  try {
    const blob = await new Promise((resolve, reject) => {
      manualEditCanvas.toBlob(value => value ? resolve(value) : reject(new Error('สร้าง PNG ไม่สำเร็จ')), 'image/png');
    });
    const form = new FormData();
    form.append('file', blob, 'manual-edit.png');
    const response = await fetch(`/api/jobs/${encodeURIComponent(activePreviewCard.dataset.jobId)}/manual-edit`, {
      method: 'POST', body: form
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'บันทึกภาพไม่สำเร็จ');
    const cacheKey = `v=${Date.now()}`;
    activePreviewCard.querySelector('.preview img').src = `${data.preview_url}?${cacheKey}`;
    const downloadLink = activePreviewCard.querySelector('.download');
    downloadLink.href = `${data.download_url}?${cacheKey}`;
    preloadCardEditImages(activePreviewCard);
    cancelManualErase();
    imagePreviewLarge.onload = () => {
      const fitRatio = Math.min(
        (imagePreviewStage.clientWidth * 0.92) / imagePreviewLarge.naturalWidth,
        (imagePreviewStage.clientHeight * 0.92) / imagePreviewLarge.naturalHeight,
        1
      );
      imagePreviewBaseWidth = imagePreviewLarge.naturalWidth * fitRatio;
      imagePreviewBaseHeight = imagePreviewLarge.naturalHeight * fitRatio;
      resetImagePreview();
    };
    imagePreviewLarge.src = `${data.download_url}?${cacheKey}`;
    imagePreviewHelp.textContent = 'บันทึกภาพที่เก็บงานแล้ว · ดาวน์โหลด PNG ได้จากการ์ดด้านล่าง';
  } catch (error) {
    alert(error.message);
  } finally {
    saveErase.textContent = 'บันทึกภาพที่แก้แล้ว';
    updateEraseButtons();
  }
});

document.querySelector('#zoomIn').addEventListener('click', () => setImagePreviewZoom(imagePreviewScale + 0.25));
document.querySelector('#zoomOut').addEventListener('click', () => setImagePreviewZoom(imagePreviewScale - 0.25));
document.querySelector('#zoomReset').addEventListener('click', resetImagePreview);
document.querySelector('#closeImagePreview').addEventListener('click', closeImagePreview);
function panImagePreview(x, y) {
  imagePreviewStage.scrollLeft += x;
  imagePreviewStage.scrollTop += y;
}
document.querySelector('#panLeft').addEventListener('click', () => panImagePreview(-180, 0));
document.querySelector('#panRight').addEventListener('click', () => panImagePreview(180, 0));
document.querySelector('#panUp').addEventListener('click', () => panImagePreview(0, -180));
document.querySelector('#panDown').addEventListener('click', () => panImagePreview(0, 180));
imagePreviewStage.addEventListener('wheel', event => {
  event.preventDefault();
  setImagePreviewZoom(imagePreviewScale + (event.deltaY < 0 ? 0.2 : -0.2));
}, {passive: false});
imagePreviewStage.addEventListener('pointerdown', event => {
  if (manualEditMode && event.target === manualEditCanvas) return;
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault();
  imagePreviewDragging = true;
  imagePreviewPointerX = event.clientX;
  imagePreviewPointerY = event.clientY;
  imagePreviewStage.classList.add('dragging');
  imagePreviewStage.setPointerCapture(event.pointerId);
});
imagePreviewStage.addEventListener('pointermove', event => {
  if (!imagePreviewDragging) return;
  imagePreviewStage.scrollLeft -= event.clientX - imagePreviewPointerX;
  imagePreviewStage.scrollTop -= event.clientY - imagePreviewPointerY;
  imagePreviewPointerX = event.clientX;
  imagePreviewPointerY = event.clientY;
});
imagePreviewStage.addEventListener('pointerup', () => {
  imagePreviewDragging = false;
  imagePreviewStage.classList.remove('dragging');
});
imagePreviewStage.addEventListener('pointercancel', () => {
  imagePreviewDragging = false;
  imagePreviewStage.classList.remove('dragging');
});
imagePreviewStage.addEventListener('auxclick', event => {
  if (event.button === 1) event.preventDefault();
});
imagePreviewModal.addEventListener('click', event => {
  if (event.target === imagePreviewModal) closeImagePreview();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !imagePreviewModal.classList.contains('hidden')) {
    closeImagePreview();
    return;
  }
  if (!manualEditMode) return;
  const target = event.target;
  const typing = target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !['range', 'button'].includes(target.type)) ||
    target?.isContentEditable;
  if (typing) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoLastManualEdit();
    return;
  }
  const decrease = event.code === 'BracketLeft' || event.key === '[' || event.key === 'บ';
  const increase = event.code === 'BracketRight' || event.key === ']' || event.key === 'ล';
  if (decrease || increase) {
    event.preventDefault();
    const amount = event.shiftKey ? 25 : 10;
    changeEraserSize(increase ? amount : -amount);
  }
});

function selectedCards() {
  return [...results.querySelectorAll('.result-card')]
    .filter(card => card.querySelector('.card-checkbox')?.checked);
}

function updateBulkActions() {
  const selected = selectedCards();
  const cards = [...results.querySelectorAll('.result-card')];
  const downloadable = selected.filter(card => card.dataset.state === 'completed' && card.dataset.jobId);
  const cancellable = selected.filter(card =>
    ['queued', 'processing'].includes(card.dataset.state) &&
    card.dataset.cancelRequested !== 'true' && card.dataset.cancelUrl &&
    (isHomeDashboard || card.dataset.isMine === 'true')
  );
  const deletable = selected.filter(card =>
    card.dataset.state === 'completed' && card.dataset.jobId
  );
  const ownCards = cards.filter(card => card.dataset.isMine === 'true');
  downloadAll.disabled = downloadable.length === 0;
  cancelSelected.disabled = cancellable.length === 0;
  deleteSelected.disabled = deletable.length === 0;
  const everyOwnSelected = ownCards.length > 0 && ownCards.every(card => card.querySelector('.card-checkbox')?.checked);
  selectAll.disabled = ownCards.length === 0;
  selectAll.textContent = everyOwnSelected ? 'ล้างการเลือกงานของฉัน' : 'เลือกงานของฉันทั้งหมด';
  cancelSelected.textContent = `ยกเลิกงานที่เลือก (${cancellable.length})`;
  deleteSelected.textContent = `ลบงานเสร็จแล้วที่เลือก (${deletable.length})`;
  downloadAll.textContent = `ดาวน์โหลดที่เลือก (${downloadable.length}) (.zip)`;
  clearCompleted.textContent = 'ลบงานที่เสร็จแล้วทั้งหมด';
  clearCompleted.disabled = !cards.some(card =>
    card.dataset.state === 'completed'
  );
}

selectAll.addEventListener('click', () => {
  const cards = [...results.querySelectorAll('.result-card')]
    .filter(card => card.dataset.isMine === 'true');
  const shouldSelect = cards.length > 0 && !cards.every(card => card.querySelector('.card-checkbox')?.checked);
  cards.forEach(card => {
    card.querySelector('.card-checkbox').checked = shouldSelect;
    saveCardRecord(card);
  });
  updateBulkActions();
});

cancelSelected.addEventListener('click', async () => {
  const cards = selectedCards().filter(card =>
    ['queued', 'processing'].includes(card.dataset.state) &&
    card.dataset.cancelRequested !== 'true' && card.dataset.cancelUrl &&
    (isHomeDashboard || card.dataset.isMine === 'true')
  );
  if (!cards.length) return;
  cancelSelected.disabled = true;
  for (const card of cards) {
    try {
      const response = await fetch(card.dataset.cancelUrl, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client_id: clientId})
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'ยกเลิกไม่สำเร็จ');
      if (data.cancelled) {
        markCancelled(card);
      } else if (data.cancelling) {
        card.dataset.cancelRequested = 'true';
        showProcessingStage(card, 'cancelling');
      }
    } catch (error) {
      const box = card.querySelector('.error-message');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  }
  updateBulkActions();
});

async function deleteCompletedCards(cards) {
  for (const card of cards) {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(card.dataset.jobId)}/delete`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client_id: clientId})
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'ลบออกจากเว็บไม่สำเร็จ');
      removeStoredJob(card.dataset.jobId);
      card.remove();
    } catch (error) {
      const box = card.querySelector('.error-message');
      box.textContent = error.message;
      box.classList.remove('hidden');
    }
  }
  updateSummary();
  updateBulkActions();
}

deleteSelected.addEventListener('click', async () => {
  const cards = selectedCards().filter(card =>
    card.dataset.state === 'completed' && card.dataset.jobId
  );
  if (!cards.length) return;
  if (!confirm(`ลบ ${cards.length} รูปที่เลือกออกจากหน้าเว็บหรือไม่?\n\nไฟล์ที่ส่งเข้า Google Drive หรือเก็บไว้ในคอมแล้วจะไม่ถูกลบ`)) return;
  deleteSelected.disabled = true;
  await deleteCompletedCards(cards);
});

clearCompleted.addEventListener('click', async () => {
  if (!confirm('ลบงานที่เสร็จแล้วของทุกคนออกจากหน้าเว็บทั้งหมดหรือไม่?\n\nไฟล์ที่ส่งเข้า Google Drive หรือเก็บไว้ในคอมแล้วจะไม่ถูกลบ')) return;
  clearCompleted.disabled = true;
  try {
    const response = await fetch('/api/jobs/clear-completed', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({client_id: clientId})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'ลบงานออกจากเว็บไม่สำเร็จ');
    await syncSharedJobs();
  } catch (error) {
    alert(error.message);
  } finally {
    updateBulkActions();
  }
});

sendEmail.addEventListener('change', () => {
  emailField.classList.toggle('hidden', !sendEmail.checked);
  if (sendEmail.checked) recipientEmail.focus();
});

function selectSource(mode) {
  const driveMode = mode === 'drive';
  sourceDevice.classList.toggle('selected', !driveMode);
  sourceDriveLink.classList.toggle('selected', driveMode);
  driveLinkPanel.classList.toggle('hidden', !driveMode);
  deliveryPanel.classList.toggle('hidden', driveMode);
  dropzone.classList.toggle('hidden', driveMode);
  if (driveMode) driveFolderUrl.focus();
}

sourceDevice.addEventListener('click', () => selectSource('device'));
sourceDriveLink.addEventListener('click', () => selectSource('drive'));

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}

function showDriveResult(message, isError = false, asHtml = false) {
  if (asHtml) driveFolderResult.innerHTML = message;
  else driveFolderResult.textContent = message;
  driveFolderResult.classList.remove('hidden');
  driveFolderResult.classList.toggle('error', isError);
}

checkDriveFolder.addEventListener('click', async () => {
  importDriveFolder.classList.add('hidden');
  checkDriveFolder.disabled = true;
  showDriveResult('กำลังตรวจสอบลิงก์และนับรูป…');
  try {
    const response = await fetch('/api/drive-folder/check', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: driveFolderUrl.value.trim()})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'ตรวจสอบโฟลเดอร์ไม่สำเร็จ');
    if (!data.count) {
      showDriveResult('เปิดโฟลเดอร์ได้ แต่ไม่พบไฟล์รูปในโฟลเดอร์ชั้นแรก', true);
      return;
    }
    const names = data.files.slice(0, 5).map(file => escapeHtml(file.name)).join(' · ');
    showDriveResult(`<strong>พร้อมทำ ${data.count} รูป</strong><br>${names}${data.count > 5 ? ' · …' : ''}`, false, true);
    importDriveFolder.classList.remove('hidden');
  } catch (error) {
    showDriveResult(error.message, true);
  } finally {
    checkDriveFolder.disabled = false;
  }
});

importDriveFolder.addEventListener('click', async () => {
  importDriveFolder.disabled = true;
  showDriveResult('กำลังสร้างโฟลเดอร์ผลลัพธ์และนำรูปเข้าคิว…');
  try {
    const response = await fetch('/api/drive-folder/import', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: driveFolderUrl.value.trim(), save_home: false, client_id: clientId})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'เริ่มงานจาก Drive ไม่สำเร็จ');
    workSection.classList.remove('hidden');
    total += data.jobs.length;
    data.jobs.forEach(job => {
      job.result_drive_url = data.result_drive_url;
      job.result_folder = data.result_folder;
      job.owner_display_name = thisClientProfile?.display_name;
      job.is_mine = true;
      pollJob(job.status_url, createRemoteCard(job));
    });
    updateSummary();
    showDriveResult(`<strong>รับงานแล้ว ${data.jobs.length} รูป</strong><br>ผลลัพธ์จะอยู่ใน “${escapeHtml(data.result_folder)}” · <a href="${data.result_drive_url}" target="_blank" rel="noopener">เปิดโฟลเดอร์ผลลัพธ์ ↗</a>`, false, true);
    importDriveFolder.classList.add('hidden');
  } catch (error) {
    showDriveResult(error.message, true);
    importDriveFolder.disabled = false;
  }
});

async function registerThisClient(nickname = localStorage.getItem(NICKNAME_KEY) || '') {
  const response = await fetch('/api/client/register', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({client_id: clientId, nickname})
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'ลงทะเบียนเครื่องไม่สำเร็จ');
  clientTitle.textContent = data.display_name;
  thisClientProfile = data;
  nicknameInput.value = data.nickname || '';
  if (data.nickname) localStorage.setItem(NICKNAME_KEY, data.nickname);
  return data;
}

saveNickname.addEventListener('click', async () => {
  saveNickname.disabled = true;
  try {
    const profile = await registerThisClient(nicknameInput.value.trim());
    localStorage.setItem(NICKNAME_KEY, profile.nickname || '');
    saveNickname.textContent = 'บันทึกแล้ว';
    await refreshMachineQueue();
  } catch (error) {
    clientTitle.textContent = error.message;
  } finally {
    setTimeout(() => {
      saveNickname.textContent = 'บันทึกชื่อเล่น';
      saveNickname.disabled = false;
    }, 1200);
  }
});

async function refreshMachineQueue() {
  try {
    const response = await fetch(`/api/queue/status?client_id=${encodeURIComponent(clientId)}`, {cache: 'no-store'});
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    if (data.current) {
      const ownerText = data.current.is_mine
        ? `กำลังทำงานของคุณ — ${data.current.display_name}`
        : `กำลังทำคิวของ ${data.current.display_name}`;
      machineQueueState.textContent = data.current.online
        ? `${ownerText} · ออนไลน์`
        : `${ownerText} · ปิดหน้าเว็บแล้ว แต่งานยังทำต่อ`;
      machineQueueState.closest('.queue-live')?.classList.toggle('offline', !data.current.online);
    } else {
      machineQueueState.textContent = 'เครื่องว่าง พร้อมรับงาน';
      machineQueueState.closest('.queue-live')?.classList.remove('offline');
    }
    machineQueueCount.textContent = data.waiting_count
      ? `รอคิว ${data.waiting_count} รูป · ${data.waiting_machine_count || 0} เครื่อง`
      : 'ไม่มีรูปกำลังรอคิว';
    machineQueueList.replaceChildren();
    const queueGroups = data.waiting_groups || data.waiting || [];
    queueGroups.slice(0, 8).forEach(item => {
      const row = document.createElement('div');
      const start = item.start_position || item.position;
      const end = item.end_position || item.position;
      const count = item.count || 1;
      const positionText = start === end ? `ลำดับ ${start}` : `ลำดับ ${start}–${end}`;
      const presenceText = item.online ? 'ออนไลน์' : 'ปิดหน้าเว็บแล้ว แต่งานยังทำต่อ';
      row.textContent = `${item.display_name}${item.is_mine ? ' · งานของคุณ' : ''} — ${count} รูป (${positionText}) · ${presenceText}`;
      row.classList.toggle('mine', item.is_mine);
      row.classList.toggle('offline', !item.online);
      machineQueueList.append(row);
    });
    if (queueGroups.length > 8) {
      const more = document.createElement('div');
      more.textContent = `และอีก ${queueGroups.length - 8} เครื่อง/ชุดงาน`;
      machineQueueList.append(more);
    }
  } catch (_) {
    machineQueueState.textContent = 'กำลังเชื่อมต่อคิวส่วนกลางใหม่…';
  }
}

registerThisClient().catch(() => {
  clientTitle.textContent = 'ยังลงทะเบียนเครื่องไม่สำเร็จ';
});
refreshMachineQueue();
setInterval(refreshMachineQueue, 1500);

async function syncSharedJobs() {
  try {
    const response = await fetch(`/api/jobs/shared?client_id=${encodeURIComponent(clientId)}`, {cache: 'no-store'});
    const data = await response.json();
    if (!response.ok || !data.ok) return;
    if (data.jobs.length) workSection.classList.remove('hidden');
    const sharedIds = new Set(data.jobs.map(job => job.job_id));
    [...results.querySelectorAll('.result-card[data-job-id]')].forEach(card => {
      if (!sharedIds.has(card.dataset.jobId)) {
        removeStoredJob(card.dataset.jobId);
        card.remove();
      }
    });
    data.jobs.forEach(job => {
      let card = results.querySelector(`[data-job-id="${CSS.escape(job.job_id)}"]`);
      if (!card) {
        total += 1;
        card = createRemoteCard(job);
        pollJob(job.status_url, card);
      } else {
        setCardOwner(card, job.owner_display_name, job.is_mine);
        card.dataset.sourceUrl = job.source_url || card.dataset.sourceUrl || '';
        const image = card.querySelector('img');
        if (job.source_url && !image.getAttribute('src')) image.src = job.source_url;
      }
    });
    updateSummary();
    updateBulkActions();
  } catch (_) {}
}

syncSharedJobs();
setInterval(syncSharedJobs, 2500);

function restoreStoredJobs() {
  const records = readStoredJobs();
  if (!records.length) return;
  workSection.classList.remove('hidden');
  total += records.length;
  const driveRecord = [...records].reverse().find(record => record.resultDriveUrl);
  if (driveRecord) {
    selectSource('drive');
    showDriveResult(`<strong>กู้คืนรายการงานหลังรีเฟรชแล้ว</strong><br>ผลลัพธ์จาก Drive อยู่ใน “${escapeHtml(driveRecord.resultFolder)}” · <a href="${driveRecord.resultDriveUrl}" target="_blank" rel="noopener">เปิดโฟลเดอร์ผลลัพธ์ ↗</a>`, false, true);
  }
  records.forEach(record => {
    const card = createRemoteCard({
      job_id: record.jobId,
      original_name: record.name,
      status_url: record.statusUrl,
      queue_ahead: 0,
      result_drive_url: record.resultDriveUrl,
      result_folder: record.resultFolder,
      source_url: record.sourceUrl
    });
    card.querySelector('.card-checkbox').checked = Boolean(record.selected);
    saveCardRecord(card);
    pollJob(record.statusUrl, card);
  });
  updateSummary();
  updateBulkActions();
}

restoreStoredJobs();

async function checkDeliveryConnections() {
  try {
    const response = await fetch('/api/health', {cache: 'no-store'});
    const data = await response.json();
    const driveOption = sendDrive.closest('.delivery-option');
    const driveText = document.querySelector('#driveStatusText');
    if (data.delivery?.drive) {
      sendDrive.disabled = false;
      driveOption.classList.remove('unavailable');
      driveText.textContent = 'พร้อมส่งเข้า ลบBG ของ Donut และสร้างโฟลเดอร์วันเวลา';
    } else {
      sendDrive.checked = false;
      sendDrive.disabled = true;
      driveOption.classList.add('unavailable');
      driveText.textContent = 'กำลังรอเชื่อมบัญชี Google';
    }
  } catch (_) {}
}

checkDeliveryConnections();
setInterval(checkDeliveryConnections, 5000);

function updateSummary() {
  const cards = [...results.querySelectorAll('.result-card')];
  const completedCount = cards.filter(card => card.dataset.state === 'completed').length;
  const cancelledCount = cards.filter(card => card.dataset.state === 'cancelled').length;
  const errorCount = cards.filter(card => card.dataset.state === 'error').length;
  const workingCount = cards.filter(card => ['uploading', 'queued', 'processing'].includes(card.dataset.state)).length;
  if (!cards.length) {
    summary.textContent = 'ยังไม่มีงานบนกระดาน';
    workSection.classList.add('hidden');
    return;
  }
  const parts = [`ทั้งหมด ${cards.length} รูป`, `เสร็จแล้ว ${completedCount} รูป`];
  if (workingCount) parts.push(`กำลังทำ/รอคิว ${workingCount} รูป`);
  if (cancelledCount) parts.push(`ยกเลิก ${cancelledCount} รูป`);
  if (errorCount) parts.push(`ไม่สำเร็จ ${errorCount} รูป`);
  summary.textContent = parts.join(' · ');
}

document.querySelectorAll('.preview-switch button').forEach(button => {
  button.addEventListener('click', () => {
    previewBackground = button.dataset.bg;
    document.querySelectorAll('.preview-switch button').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.preview').forEach(preview => preview.className = `preview ${previewBackground}`);
  });
});

downloadAll.addEventListener('click', async () => {
  const selectedJobIds = selectedCards()
    .filter(card => card.dataset.state === 'completed' && card.dataset.jobId)
    .map(card => card.dataset.jobId);
  if (!selectedJobIds.length) return;
  const response = await fetch('/api/zip', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ job_ids: selectedJobIds })
  });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'transparent-images.zip'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelector('#openFolder')?.addEventListener('click', () => fetch('/api/open-folder', {method: 'POST'}));
document.querySelector('#shutdown')?.addEventListener('click', async () => {
  if (!confirm('ปิดแอปลบพื้นหลังตอนนี้หรือไม่?')) return;
  await fetch('/api/shutdown', {method: 'POST'});
  document.body.innerHTML = '<div style="font-family:system-ui;padding:60px;text-align:center"><h2>ปิดแอปแล้ว</h2><p>ปิดหน้าต่างนี้ได้เลย</p></div>';
});

async function refreshShareStatus() {
  if (!sharePanel) return;
  const response = await fetch('/api/share/status');
  if (!response.ok) return;
  const data = await response.json();
  if (data.url) {
    shareUrl.value = data.url;
    document.querySelector('#shareState').textContent = 'ลิงก์พร้อมใช้งาน';
    copyShare.disabled = false;
  } else if (data.running) {
    setTimeout(refreshShareStatus, 900);
  }
}

shareButton?.addEventListener('click', async () => {
  sharePanel.classList.remove('hidden');
  shareUrl.value = 'กำลังเตรียม…';
  copyShare.disabled = true;
  const response = await fetch('/api/share/start', {method: 'POST'});
  const data = await response.json();
  if (!response.ok || !data.ok) {
    document.querySelector('#shareState').textContent = 'สร้างลิงก์ไม่สำเร็จ';
    shareUrl.value = data.error || 'กรุณาลองใหม่';
    return;
  }
  refreshShareStatus();
});

copyShare?.addEventListener('click', async () => {
  const message = `เว็บลบพื้นหลัง: ${shareUrl.value}`;
  await navigator.clipboard.writeText(message);
  copyShare.textContent = 'คัดลอกแล้ว';
  setTimeout(() => { copyShare.textContent = 'คัดลอกลิงก์'; }, 1600);
});

stopShare?.addEventListener('click', async () => {
  await fetch('/api/share/stop', {method: 'POST'});
  sharePanel.classList.add('hidden');
  shareUrl.value = '';
});
