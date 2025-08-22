window.addEventListener('load', async () => {
	// Tell the Telegram client that the app is ready.
	window.Telegram.WebApp.ready();

	// Parse room from URL or derive via Telegram WebApp initData (no token)
	const params = new URLSearchParams(window.location.search);
	let room = params.get('room');

	if (!room) {
		const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
		const initDataUnsafe = tg ? tg.initDataUnsafe : {};
		const startParam = (initDataUnsafe && initDataUnsafe.start_param) ? initDataUnsafe.start_param : null;
		if (startParam && startParam.startsWith('r_')) {
			room = decodeURIComponent(startParam.slice(2));
		}
		if (!room && initDataUnsafe && initDataUnsafe.chat && initDataUnsafe.chat.id) {
			room = String(initDataUnsafe.chat.id);
		}
		if (!room && initDataUnsafe && initDataUnsafe.user && initDataUnsafe.user.id) {
			room = String(initDataUnsafe.user.id);
		}
	}

	if (!room) {
		alert('Missing room parameter. Please open the app from the bot button.');
		return;
	}

	// Socket connection with auth (room only)
	const socket = io('https://our-drawing-app-server.onrender.com', { auth: { room } });

	// --- Modal and User List Elements ---
	const signatureModal = document.getElementById('signature-modal');
	const signatureCanvas = document.getElementById('signature-canvas');
	const sigCtx = signatureCanvas.getContext('2d');
	const confirmBtn = document.getElementById('confirm-signature');
	const userListDiv = document.getElementById('user-list');

	// --- Canvas Elements ---
	const displayCanvas = document.getElementById('drawing-canvas');
	const displayCtx = displayCanvas.getContext('2d');
	const canvasContainer = document.getElementById('canvas-container');

	// Offscreen drawing surface (fixed size 2048x2048)
	const drawingCanvas = document.createElement('canvas');
	drawingCanvas.width = 2048;
	drawingCanvas.height = 2048;
	const ctx = drawingCanvas.getContext('2d', { willReadFrequently: true });
	// Initialize with white background so the drawable area is opaque
	ctx.save();
	ctx.globalCompositeOperation = 'source-over';
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
	ctx.restore();

	// --- Preview canvas for local in-progress stroke ---
	const previewCanvas = document.createElement('canvas');
	previewCanvas.width = 2048;
	previewCanvas.height = 2048;
	const previewCtx = previewCanvas.getContext('2d');

	// --- Guide mode canvases ---
	// Suggestion layer (semi-transparent overlay showing what to draw)
	const suggestionCanvas = document.createElement('canvas');
	suggestionCanvas.width = 2048;
	suggestionCanvas.height = 2048;
	const suggestionCtx = suggestionCanvas.getContext('2d');

	// Current step canvas (what the user draws for the current step)
	const stepCanvas = document.createElement('canvas');
	stepCanvas.width = 2048;
	stepCanvas.height = 2048;
	const stepCtx = stepCanvas.getContext('2d');

	// Remote committed strokes (normal mode)
	const remoteCanvas = document.createElement('canvas');
	remoteCanvas.width = 2048;
	remoteCanvas.height = 2048;
	const remoteCtx = remoteCanvas.getContext('2d');

	// Remote guide step strokes
	const remoteStepCanvas = document.createElement('canvas');
	remoteStepCanvas.width = 2048;
	remoteStepCanvas.height = 2048;
	const remoteStepCtx = remoteStepCanvas.getContext('2d');

	// --- Bottom bar elements ---
	const expansionPanel = document.getElementById('expansion-panel');
	const panelTools = document.getElementById('panel-tools');
	const panelSize = document.getElementById('panel-size');
	const panelColor = document.getElementById('panel-color');
	const panelHistory = document.getElementById('panel-history');
	const toolToggleBtn = document.getElementById('toolToggleBtn');
	const sizeToggleBtn = document.getElementById('sizeToggleBtn');
	const colorToggleBtn = document.getElementById('colorToggleBtn');
	const historyToggleBtn = document.getElementById('historyToggleBtn');
	const sizeDot = document.getElementById('sizeDot');
	const colorSwatch = document.getElementById('colorSwatch');

	const colorPicker = document.getElementById('colorPicker');
	const brushSize = document.getElementById('brushSize');
	const clearBtn = document.getElementById('clearBtn');
	const undoBtn = document.getElementById('undoBtn');
	const redoBtn = document.getElementById('redoBtn');
	const brushBtn = document.getElementById('brushBtn');
	const eraserBtn = document.getElementById('eraserBtn');
	const fillBtn = document.getElementById('fillBtn');
	const paletteContainer = document.getElementById('color-palette');

	// --- Signature Pad Logic ---
	let isSigDrawing = false;
	let lastSigX = 0;
	let lastSigY = 0;
	sigCtx.strokeStyle = '#000000';
	sigCtx.lineWidth = 3;
	sigCtx.lineCap = 'round';

	function getSigCoords(e) {
		const rect = signatureCanvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		return { x, y };
	}

	function handleSigStart(e) {
		isSigDrawing = true;
		const p = e.offsetX !== undefined ? { x: e.offsetX, y: e.offsetY } : getSigCoords(e);
		[lastSigX, lastSigY] = [p.x, p.y];
		confirmBtn.disabled = false;
	}

	function handleSigDraw(e) {
		if (!isSigDrawing) return;
		sigCtx.beginPath();
		sigCtx.moveTo(lastSigX, lastSigY);
		const p = e.offsetX !== undefined ? { x: e.offsetX, y: e.offsetY } : getSigCoords(e);
		sigCtx.lineTo(p.x, p.y);
		sigCtx.stroke();
		[lastSigX, lastSigY] = [p.x, p.y];
	}

	function handleSigStop() { isSigDrawing = false; }

	signatureCanvas.addEventListener('mousedown', handleSigStart);
	signatureCanvas.addEventListener('mousemove', handleSigDraw);
	signatureCanvas.addEventListener('mouseup', handleSigStop);
	signatureCanvas.addEventListener('mouseleave', handleSigStop);
	signatureCanvas.addEventListener('pointerdown', (e) => { handleSigStart(e); e.preventDefault(); }, { passive: false });
	signatureCanvas.addEventListener('pointermove', (e) => { handleSigDraw(e); e.preventDefault(); }, { passive: false });
	signatureCanvas.addEventListener('pointerup', (e) => { handleSigStop(); e.preventDefault(); }, { passive: false });
	signatureCanvas.addEventListener('pointercancel', (e) => { handleSigStop(); e.preventDefault(); }, { passive: false });

	confirmBtn.addEventListener('click', () => {
		const signatureDataUrl = signatureCanvas.toDataURL();
		socket.emit('userSignedUp', { signature: signatureDataUrl });
		signatureModal.classList.add('hidden');
	});

	// --- Main Application Logic ---
	let isDrawing = false;
	let currentTool = 'brush';
	let currentColor = colorPicker.value;
	let currentSize = Number(brushSize.value);
	let lastX = 0;
	let lastY = 0;
	let recentColors = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#1abc9c', '#e67e22', '#2c3e50'];

	// Viewport transform state
	let viewScale = 1;
	let viewOffsetX = 0;
	let viewOffsetY = 0;

	// Guide mode variables
	let isGuideMode = false;
	let currentGuideStep = -1;
	let sortedColorGroups = [];
	let loadedSvgDocument = null;
	let currentSvgPath = null;
	let mountedSvgRoot = null; // SVG element mounted in hidden DOM for computed styles/bbox
	let guideHiddenHost = null; // Hidden host div
	let loadedSvgViewBox = null; // {minX, minY, width, height}

	// Per-step local undo/redo for guide mode
	const MAX_STEP_HISTORY = 30;
	let stepHistory = [];
	let stepHistoryIndex = -1;

	function initStepHistory() {
		stepHistory = [];
		stepHistoryIndex = -1;
		pushStepSnapshot();
	}

	function pushStepSnapshot() {
		try {
			const img = stepCtx.getImageData(0, 0, stepCanvas.width, stepCanvas.height);
			if (stepHistoryIndex < stepHistory.length - 1) {
				stepHistory = stepHistory.slice(0, stepHistoryIndex + 1);
			}
			stepHistory.push(img);
			if (stepHistory.length > MAX_STEP_HISTORY) {
				stepHistory.shift();
			} else {
				stepHistoryIndex++;
			}
		} catch (_) {}
	}

	function restoreStepSnapshot(index) {
		if (index < 0 || index >= stepHistory.length) return;
		const img = stepHistory[index];
		try {
			stepCtx.putImageData(img, 0, 0);
			render();
		} catch (_) {}
	}
	let MIN_SCALE = 0.02;
	const MAX_SCALE = 8;

	// Pointer state
	const activePointers = new Map();
	let drawingPointerId = null;
	let pinchState = null;

	// PC pan state
	let isSpaceDown = false;
	let isPanning = false;
	let panPointerId = null;
	let panLastClientX = 0;
	let panLastClientY = 0;

	// NEW: pending stroke to avoid initial dot during pinch
	let pendingStroke = null; // { x, y, tool, color, size }
	let strokeStarted = false;
	const STROKE_START_TOLERANCE_SQ = 4; // px^2
	// Stroke batching (client-only while drawing)
	let currentStrokePoints = [];
	let currentStrokeMeta = null; // { tool, color, size }

	// Pending fill to avoid accidental fill during pinch/zoom
	let pendingFill = null; // { startX, startY, color }
	let fillPointerId = null;

	// Drawing lock state
	let isCanvasLocked = false;
	let lockMessage = '';
	let lockTimeout = null;

	// Create notification element for lock messages
	const notificationDiv = document.createElement('div');
	notificationDiv.id = 'drawing-notification';
	notificationDiv.style.cssText = `
		position: fixed;
		top: 20px;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(0, 0, 0, 0.8);
		color: white;
		padding: 12px 20px;
		border-radius: 8px;
		font-size: 14px;
		z-index: 1000;
		opacity: 0;
		transition: opacity 0.3s ease;
		pointer-events: none;
		max-width: 300px;
		text-align: center;
	`;
	document.body.appendChild(notificationDiv);

	function showNotification(message, duration = 3000) {
		notificationDiv.textContent = message;
		notificationDiv.style.opacity = '1';
		
		if (lockTimeout) {
			clearTimeout(lockTimeout);
		}
		
		lockTimeout = setTimeout(() => {
			notificationDiv.style.opacity = '0';
		}, duration);
	}

	function updateCursor() {
		if (isPanning || isSpaceDown) { 
			displayCanvas.style.cursor = 'grab'; 
			return; 
		}
		
		if (isCanvasLocked) {
			displayCanvas.style.cursor = 'not-allowed';
			return;
		}
		
		displayCanvas.style.cursor = currentTool === 'fill' ? 'pointer' : 'crosshair';
	}

	function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }
	function getDPR() { return window.devicePixelRatio || 1; }

	function resizeCanvas() {
		const rect = canvasContainer.getBoundingClientRect();
		const dpr = getDPR();
		displayCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
		displayCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
		displayCanvas.style.width = rect.width + 'px';
		displayCanvas.style.height = rect.height + 'px';
		// Allow zooming out to at least fit the full canvas (with a small margin)
		const fitScale = Math.min(rect.width / drawingCanvas.width, rect.height / drawingCanvas.height);
		MIN_SCALE = Math.min(fitScale * 0.98, 0.02);
		render();
		socket.emit('requestCanvasState');
	}

	function render() {
		const dpr = getDPR();
		displayCtx.setTransform(1, 0, 0, 1, 0, 0);
		// Darker background outside the canvas to highlight edges
		displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
		displayCtx.fillStyle = '#1f2a35';
		displayCtx.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
		// Draw the offscreen canvas with the current transform
		displayCtx.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, viewOffsetX * dpr, viewOffsetY * dpr);
		displayCtx.imageSmoothingEnabled = false;
		// Base order: committed base, then remote base (others), then our step, then remote step, then suggestion, then preview
		displayCtx.drawImage(drawingCanvas, 0, 0);
		displayCtx.drawImage(remoteCanvas, 0, 0);
		// Draw suggestion layer (semi-transparent) if in guide mode
		if (isGuideMode && suggestionCtx) {
			displayCtx.save();
			displayCtx.globalAlpha = 0.5;
			// Ensure suggestion sits under the step layers
			displayCtx.drawImage(suggestionCanvas, 0, 0);
			displayCtx.restore();
		}
		// Draw current step layer if in guide mode
		if (isGuideMode && stepCtx) {
			displayCtx.drawImage(stepCanvas, 0, 0);
			displayCtx.drawImage(remoteStepCanvas, 0, 0);
		}
		// Draw preview layer over base
		displayCtx.drawImage(previewCanvas, 0, 0);
		// Outline the drawing area for clear boundaries
		displayCtx.save();
		displayCtx.strokeStyle = 'rgba(0,0,0,0.6)';
		displayCtx.lineWidth = Math.max(1 / (viewScale * dpr), 0.5 / dpr);
		displayCtx.strokeRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		displayCtx.restore();
		displayCtx.setTransform(1, 0, 0, 1, 0, 0);
	}

	function applyStrokeFromServer(stroke) {
		if (!stroke || !stroke.points || stroke.points.length === 0) return;
		const { tool, color, size, points } = stroke;
		const isEraser = tool === 'eraser';
		const targetCtx = stroke.guide ? remoteStepCtx : remoteCtx;
		targetCtx.save();
		targetCtx.globalCompositeOperation = stroke.guide && isEraser ? 'destination-out' : 'source-over';
		targetCtx.lineCap = 'round';
		targetCtx.lineJoin = 'round';
		targetCtx.lineWidth = size;
		targetCtx.strokeStyle = isEraser && !stroke.guide ? '#ffffff' : color;
		targetCtx.beginPath();
		if (points.length === 1) {
			const p = points[0];
			targetCtx.moveTo(p.x, p.y);
			targetCtx.lineTo(p.x, p.y);
			targetCtx.stroke();
			targetCtx.restore();
			render();
			return;
		}
		let prev = points[0];
		targetCtx.moveTo(prev.x, prev.y);
		for (let i = 1; i < points.length; i++) {
			const curr = points[i];
			const midX = (prev.x + curr.x) / 2;
			const midY = (prev.y + curr.y) / 2;
			targetCtx.quadraticCurveTo(prev.x, prev.y, midX, midY);
			prev = curr;
		}
		targetCtx.lineTo(prev.x, prev.y);
		targetCtx.stroke();
		targetCtx.restore();
		render();
	}

	function emitCompletedStroke(isGuide = false) {
		if (!currentStrokeMeta || currentStrokePoints.length === 0) return;
		const stroke = {
			tool: currentStrokeMeta.tool,
			color: currentStrokeMeta.color,
			size: currentStrokeMeta.size,
			points: currentStrokePoints.slice(),
			guide: !!isGuide
		};
		socket.emit('stroke', stroke);
	}

	function canvasPointFromClient(clientX, clientY) {
		const rect = displayCanvas.getBoundingClientRect();
		const xCss = clientX - rect.left;
		const yCss = clientY - rect.top;
		const x = (xCss - viewOffsetX) / viewScale;
		const y = (yCss - viewOffsetY) / viewScale;
		return { x, y };
	}

	function handleStartDrawing(data) {
		const isEraser = data.tool === 'eraser';
		// Choose the appropriate canvas based on guide mode
		const targetCtx = isGuideMode ? stepCtx : previewCtx;
		const targetCanvas = isGuideMode ? stepCanvas : previewCanvas;
		
		// In normal mode, clear preview layer for a fresh stroke preview
		if (!isGuideMode) {
			targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
		}
		// Set composite mode
		if (isGuideMode && isEraser) targetCtx.globalCompositeOperation = 'destination-out';
		else targetCtx.globalCompositeOperation = 'source-over';
		
		targetCtx.beginPath();
		targetCtx.lineCap = 'round';
		targetCtx.lineJoin = 'round';
		targetCtx.lineWidth = data.size;
		targetCtx.strokeStyle = isEraser && !isGuideMode ? '#ffffff' : data.color;
		[lastX, lastY] = [data.x, data.y];
		targetCtx.moveTo(lastX, lastY);
		targetCtx.lineTo(lastX, lastY);
		targetCtx.stroke();
		render();
	}

	function handleDraw(data) {
		const targetCtx = isGuideMode ? stepCtx : previewCtx;
		const midX = (lastX + data.x) / 2;
		const midY = (lastY + data.y) / 2;
		targetCtx.quadraticCurveTo(lastX, lastY, midX, midY);
		targetCtx.stroke();
		[lastX, lastY] = [data.x, data.y];
		render();
	}

	function handleStopDrawing() { ctx.beginPath(); stepCtx.beginPath(); previewCtx.beginPath(); }

	function switchTool(tool) {
		currentTool = tool;
		[brushBtn, eraserBtn, fillBtn].forEach(b => b.classList.remove('active'));
		const id = tool === 'brush' ? 'brushBtn' : tool === 'eraser' ? 'eraserBtn' : 'fillBtn';
		document.getElementById(id).classList.add('active');
		updateCursor();
	}

	function floodFill({ startX, startY, color, guide }) {
		const tolerance = 32;
		// In guide mode, fill operates on the step canvas
		const useGuide = guide || isGuideMode;
		const targetCanvas = useGuide ? stepCanvas : drawingCanvas;
		const targetCtx = useGuide ? stepCtx : ctx;
		const width = targetCanvas.width;
		const height = targetCanvas.height;
		// Build a composite snapshot for region detection so fills respect all visible strokes
		const analysisCanvas = document.createElement('canvas');
		analysisCanvas.width = width; analysisCanvas.height = height;
		const analysisCtx = analysisCanvas.getContext('2d');
		analysisCtx.globalCompositeOperation = 'source-over';
		analysisCtx.drawImage(drawingCanvas, 0, 0);
		analysisCtx.drawImage(remoteCanvas, 0, 0);
		if (useGuide) {
			analysisCtx.drawImage(stepCanvas, 0, 0);
			analysisCtx.drawImage(remoteStepCanvas, 0, 0);
		}
		const imageData = analysisCtx.getImageData(0, 0, width, height);
		const data = imageData.data;
		const sx = Math.floor(startX);
		const sy = Math.floor(startY);
		if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;
		const startIdx = (sy * width + sx) * 4;
		const targetR = data[startIdx];
		const targetG = data[startIdx + 1];
		const targetB = data[startIdx + 2];
		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
		if (!result) return;
		const fillR = parseInt(result[1], 16);
		const fillG = parseInt(result[2], 16);
		const fillB = parseInt(result[3], 16);
		if (targetR === fillR && targetG === fillG && targetB === fillB) return;
		const tolSq = tolerance * tolerance;
		function matchesAt(x, y) {
			const i = (y * width + x) * 4;
			const rDiff = data[i] - targetR;
			const gDiff = data[i + 1] - targetG;
			const bDiff = data[i + 2] - targetB;
			return (rDiff * rDiff + gDiff * gDiff + bDiff * bDiff) < tolSq;
		}
		const tempCanvas = document.createElement('canvas');
		tempCanvas.width = width;
		tempCanvas.height = height;
		const tempCtx = tempCanvas.getContext('2d');
		const maskData = tempCtx.createImageData(width, height);
		const mask = maskData.data;
		const visited = new Uint8Array(width * height);
		const stack = [[sx, sy]];
		visited[sy * width + sx] = 1;

		while (stack.length) {
			const [x, y] = stack.pop();
			// find left bound
			let xL = x;
			while (xL - 1 >= 0 && !visited[y * width + (xL - 1)] && matchesAt(xL - 1, y)) {
				xL--;
			}
			// find right bound
			let xR = x;
			while (xR + 1 < width && !visited[y * width + (xR + 1)] && matchesAt(xR + 1, y)) {
				xR++;
			}
			// fill the scanline and enqueue spans above and below
			for (let xi = xL; xi <= xR; xi++) {
				const idx = y * width + xi;
				visited[idx] = 1;
				mask[idx * 4 + 3] = 255; // set alpha in mask
			}
			// check the line above
			if (y - 1 >= 0) {
				let inSpan = false;
				for (let xi = xL; xi <= xR; xi++) {
					const idx = (y - 1) * width + xi;
					if (!visited[idx] && matchesAt(xi, y - 1)) {
						if (!inSpan) {
							stack.push([xi, y - 1]);
							inSpan = true;
						}
					} else if (inSpan) {
						inSpan = false;
					}
				}
			}
			// check the line below
			if (y + 1 < height) {
				let inSpan = false;
				for (let xi = xL; xi <= xR; xi++) {
					const idx = (y + 1) * width + xi;
					if (!visited[idx] && matchesAt(xi, y + 1)) {
						if (!inSpan) {
							stack.push([xi, y + 1]);
							inSpan = true;
						}
					} else if (inSpan) {
						inSpan = false;
					}
				}
			}
		}

		// Expand mask by 1px to overlap anti-aliased edges
		{
			const expanded = new Uint8Array(width * height);
			for (let y = 0; y < height; y++) {
				const rowOffset = y * width;
				for (let x = 0; x < width; x++) {
					const base = (rowOffset + x) * 4;
					if (mask[base + 3]) {
						for (let oy = -1; oy <= 1; oy++) {
							const ny = y + oy;
							if (ny < 0 || ny >= height) continue;
							const nRowOffset = ny * width;
							for (let ox = -1; ox <= 1; ox++) {
								const nx = x + ox;
								if (nx < 0 || nx >= width) continue;
								expanded[nRowOffset + nx] = 1;
							}
						}
					}
				}
			}
			for (let i = 0; i < expanded.length; i++) {
				mask[i * 4 + 3] = expanded[i] ? 255 : 0;
			}
		}

		// Package the mask as a dataURL so others can apply the exact same fill region
		tempCtx.putImageData(maskData, 0, 0);
		tempCtx.globalCompositeOperation = 'source-in';
		tempCtx.fillStyle = color;
		tempCtx.fillRect(0, 0, width, height);
		const dataUrl = tempCanvas.toDataURL();
		// Apply locally
		targetCtx.drawImage(tempCanvas, 0, 0);
		render();
		// Broadcast exact fill mask so receivers composite it identically
		socket.emit('fill', { dataUrl, guide: useGuide });
	}

	function applyFillMaskImage({ dataUrl, guide }) {
		const img = new Image();
		img.onload = () => {
			const targetCtx = guide ? remoteStepCtx : remoteCtx;
			targetCtx.drawImage(img, 0, 0);
			render();
		};
		img.src = dataUrl;
	}

	function updatePalette() {
		paletteContainer.innerHTML = '';
		recentColors.forEach(color => {
			const colorCircle = document.createElement('div');
			colorCircle.classList.add('palette-color');
			colorCircle.style.backgroundColor = color;
			colorCircle.addEventListener('click', () => {
				currentColor = color;
				colorPicker.value = color;
				colorSwatch.style.backgroundColor = color;
			});
			paletteContainer.appendChild(colorCircle);
		});
	}

	function addColorToPalette(color) {
		if (recentColors.includes(color)) {
			const index = recentColors.indexOf(color);
			recentColors.splice(index, 1);
			recentColors.unshift(color);
		} else {
			recentColors.pop();
			recentColors.unshift(color);
		}
		updatePalette();
	}

	// Socket events
	// Remote stroke application (sent only after another user finishes a stroke)
	socket.on('applyStroke', (stroke) => { applyStrokeFromServer(stroke); });
	socket.on('fill', (data) => {
		if (data && data.dataUrl) {
			applyFillMaskImage(data);
		} else {
			floodFill({ ...data, guide: !!data.guide });
			// If we filled in guide mode locally, persist the step layer
			if (isGuideMode || data.guide) {
				try {
					// Save composite of local step and remote step
					const composite = document.createElement('canvas');
					composite.width = stepCanvas.width; composite.height = stepCanvas.height;
					const cctx = composite.getContext('2d');
					cctx.drawImage(remoteStepCanvas, 0, 0);
					cctx.drawImage(stepCanvas, 0, 0);
					const url = composite.toDataURL();
					socket.emit('saveGuideStepState', { step: currentGuideStep, dataUrl: url });
					stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
					render();
				} catch (_) {}
			}
		}
	});

	// Guide synchronization
	socket.on('guideCommitAndGotoStep', async ({ step, svgPath, baseDataUrl }) => {
		// Commit any remote step drawings into our base if we have our own step visible
		if (isGuideMode) {
			ctx.drawImage(stepCanvas, 0, 0);
			ctx.drawImage(remoteStepCanvas, 0, 0);
			stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
		}
		// Merge sender base snapshot if provided (ensures everyone aligns)
		if (baseDataUrl) {
			try {
				const img = new Image();
				img.onload = () => { ctx.drawImage(img, 0, 0); render(); };
				img.src = baseDataUrl;
			} catch (_) {}
		}
		// Clear remote step buffer when switching steps
		remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
		// Ensure we have the same SVG loaded
		if (currentSvgPath !== svgPath) {
			try {
				const response = await fetch(svgPath);
				const svgText = await response.text();
				processSvgForGuide(svgText, svgPath);
			} catch (_) {}
		}
		currentGuideStep = step;
		renderCurrentStep();
		updateGuideControls();
		initStepHistory();
	});

	socket.on('guideExit', ({ baseDataUrl }) => {
		// Clear suggestion and remote step overlay
		// Before clearing, merge any step layers into base
		ctx.drawImage(stepCanvas, 0, 0);
		ctx.drawImage(remoteStepCanvas, 0, 0);
		stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
		remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
		suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);
		// Merge base snapshot if provided
		if (baseDataUrl) {
			try {
				const img = new Image();
				img.onload = () => { ctx.drawImage(img, 0, 0); render(); };
				img.src = baseDataUrl;
			} catch (_) {}
		}
		// Reset local guide state if active
		isGuideMode = false;
		currentGuideStep = -1;
		sortedColorGroups = [];
		loadedSvgDocument = null;
		currentSvgPath = null;
		loadedSvgViewBox = null;
		cleanupMountedSvg();
		exitGuideModeBtn.classList.add('hidden');
		render();
	});
	socket.on('clearCanvas', () => { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height); previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height); render(); });

	// No locking in the new model

	socket.on('loadCanvas', ({ dataUrl }) => {
		const img = new Image();
		img.src = dataUrl;
		img.onload = () => {
			ctx.globalCompositeOperation = 'source-over';
			ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
			ctx.drawImage(img, 0, 0);
			previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
			render();
		};
	});

	// Initial full state on connect/reconnect
	socket.on('initState', async ({ baseDataUrl, guide }) => {
		if (baseDataUrl) {
			try {
				const baseImg = new Image();
				baseImg.onload = () => { ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height); ctx.drawImage(baseImg, 0, 0); render(); };
				baseImg.src = baseDataUrl;
			} catch (_) {}
		}
		if (guide && guide.active && guide.svgPath) {
			try {
				const response = await fetch(guide.svgPath);
				const svgText = await response.text();
				processSvgForGuide(svgText, guide.svgPath);
				currentGuideStep = typeof guide.step === 'number' ? guide.step : -1;
				renderCurrentStep();
				updateGuideControls();
				if (guide.stepDataUrl) {
					const img = new Image();
					img.onload = () => { remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height); remoteStepCtx.drawImage(img, 0, 0); stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height); render(); };
					img.src = guide.stepDataUrl;
				} else {
					remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
					stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
					render();
				}
			} catch (_) {}
		}
	});

	// Sync shared guide step layer snapshot
	socket.on('loadGuideStepLayer', ({ step, dataUrl }) => {
		if (!isGuideMode) return;
		if (typeof step === 'number' && step !== currentGuideStep) return;
		if (dataUrl) {
			const img = new Image();
			img.onload = () => { remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height); remoteStepCtx.drawImage(img, 0, 0); stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height); render(); };
			img.src = dataUrl;
		} else {
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
			render();
		}
	});

	socket.on('updateUserList', (signatures) => {
		userListDiv.innerHTML = '<h3>Who is here:</h3>';
		signatures.forEach(sigUrl => {
			const img = document.createElement('img');
			img.src = sigUrl;
			img.className = 'user-signature-img';
			userListDiv.appendChild(img);
		});
	});

	socket.on('guideStepSync', async ({ step, svgPath }) => {
		// Only sync if we're not already on this step
		if (currentGuideStep !== step || currentSvgPath !== svgPath) {
			// Load the SVG if it's different
			if (currentSvgPath !== svgPath) {
				try {
					const response = await fetch(svgPath);
					const svgText = await response.text();
					processSvgForGuide(svgText, svgPath);
				} catch (error) {
					console.error('Error syncing guide:', error);
					return;
				}
			}
			
			// Update to the synchronized step
			currentGuideStep = step;
			renderCurrentStep();
			updateGuideControls();
		}
	});

	// UI: toggle logic for bottom bar
	function showPanel(which) {
		[panelTools, panelSize, panelColor, panelHistory].forEach(p => p.classList.add('hidden'));
		if (which === 'tools') panelTools.classList.remove('hidden');
		if (which === 'size') panelSize.classList.remove('hidden');
		if (which === 'color') panelColor.classList.remove('hidden');
		if (which === 'history') panelHistory.classList.remove('hidden');
		expansionPanel.classList.remove('hidden');
	}
	function hidePanels() { expansionPanel.classList.add('hidden'); }

	function togglePanel(which) {
		const isOpen = !expansionPanel.classList.contains('hidden');
		const isThisVisible = !document.getElementById(`panel-${which}`).classList.contains('hidden');
		if (!isOpen || !isThisVisible) {
			showPanel(which);
		} else {
			hidePanels();
		}
	}

	toolToggleBtn.addEventListener('click', () => togglePanel('tools'));
	sizeToggleBtn.addEventListener('click', () => togglePanel('size'));
	colorToggleBtn.addEventListener('click', () => togglePanel('color'));
	historyToggleBtn.addEventListener('click', () => togglePanel('history'));

	function shouldPanOnPointerDown(e) {
		const isMiddleButton = e.button === 1 || (e.pointerType === 'mouse' && (e.buttons & 4) !== 0);
		return isSpaceDown || isMiddleButton;
	}

	function beginStroke(data) {
		strokeStarted = true;
		handleStartDrawing(data);
	}

	// No lock rejection handling in the new model

	function onPointerDown(e) {
		displayCanvas.setPointerCapture(e.pointerId);
		activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

		if (shouldPanOnPointerDown(e)) {
			isPanning = true;
			panPointerId = e.pointerId;
			panLastClientX = e.clientX;
			panLastClientY = e.clientY;
			displayCanvas.style.cursor = 'grabbing';
			e.preventDefault();
			return;
		}

		if (activePointers.size === 2) {
			const [p1, p2] = Array.from(activePointers.values());
			const dx = p2.clientX - p1.clientX;
			const dy = p2.clientY - p1.clientY;
			const centerX = (p1.clientX + p2.clientX) / 2;
			const centerY = (p1.clientY + p2.clientY) / 2;
			pinchState = { startDist: Math.hypot(dx, dy), startScale: viewScale, startOffsetX: viewOffsetX, startOffsetY: viewOffsetY, centerX, centerY };
			// Cancel any pending stroke to avoid a dot
			isDrawing = false;
			pendingStroke = null;
			strokeStarted = false;
			drawingPointerId = null;
			// Cancel any pending fill during pinch
			pendingFill = null;
			fillPointerId = null;
			return;
		}

		// No canvas lock checks

		// Single pointer
		const { x, y } = canvasPointFromClient(e.clientX, e.clientY);
		if (currentTool === 'fill') {
			pendingFill = { startX: x, startY: y, color: currentColor };
			fillPointerId = e.pointerId;
		} else {
			isDrawing = true;
			drawingPointerId = e.pointerId;
			pendingStroke = { x, y, tool: currentTool, color: currentColor, size: Number(currentSize) };
			strokeStarted = false;
			currentStrokeMeta = { tool: currentTool, color: currentColor, size: Number(currentSize) };
			currentStrokePoints = [ { x, y } ];
		}
		e.preventDefault();
	}

	function onPointerMove(e) {
		if (!activePointers.has(e.pointerId)) return;
		activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

		if (isPanning && panPointerId === e.pointerId) {
			const dx = e.clientX - panLastClientX;
			const dy = e.clientY - panLastClientY;
			viewOffsetX += dx;
			viewOffsetY += dy;
			panLastClientX = e.clientX;
			panLastClientY = e.clientY;
			render();
			e.preventDefault();
			return;
		}

		if (activePointers.size >= 2 && pinchState) {
			const [p1, p2] = Array.from(activePointers.values());
			const dx = p2.clientX - p1.clientX;
			const dy = p2.clientY - p1.clientY;
			const newDist = Math.hypot(dx, dy);
			const newCenterX = (p1.clientX + p2.clientX) / 2;
			const newCenterY = (p1.clientY + p2.clientY) / 2;
			let newScale = clampScale(pinchState.startScale * (newDist / Math.max(1, pinchState.startDist)));
			const startCenter = { x: pinchState.centerX, y: pinchState.centerY };
			const canvasPointX = (startCenter.x - pinchState.startOffsetX) / pinchState.startScale;
			const canvasPointY = (startCenter.y - pinchState.startOffsetY) / pinchState.startScale;
			viewScale = newScale;
			viewOffsetX = newCenterX - canvasPointX * newScale;
			viewOffsetY = newCenterY - canvasPointY * newScale;
			render();
			return;
		}

		if (isDrawing && drawingPointerId === e.pointerId) {
			const { x, y } = canvasPointFromClient(e.clientX, e.clientY);
			if (!strokeStarted && pendingStroke) {
				const dx = x - pendingStroke.x;
				const dy = y - pendingStroke.y;
				if ((dx * dx + dy * dy) >= STROKE_START_TOLERANCE_SQ) {
					beginStroke(pendingStroke);
				}
			}
			if (strokeStarted) {
				const data = { x, y };
				handleDraw(data);
				currentStrokePoints.push({ x, y });
			}
		}
		e.preventDefault();
	}

	function onPointerUp(e) {
		// Commit pending fill only if not pinching/zooming
		if (pendingFill && e.pointerId === fillPointerId) {
			const data = { ...pendingFill, guide: isGuideMode };
			pendingFill = null;
			fillPointerId = null;
			if (!pinchState) {
				floodFill(data);
				if (!isGuideMode) {
					socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
				}
			}
		}

		if (drawingPointerId === e.pointerId && (isDrawing || pendingStroke)) {
			// If no movement occurred and stroke not started, treat as dot tap
			if (!strokeStarted && pendingStroke) {
				beginStroke(pendingStroke);
			}
			if (strokeStarted) {
				if (isGuideMode) {
					// In guide mode, broadcast the finished stroke and persist the shared step layer
					emitCompletedStroke(/*guide*/true);
					pushStepSnapshot();
					try {
						const dataUrl = stepCanvas.toDataURL();
						socket.emit('saveGuideStepState', { step: currentGuideStep, dataUrl });
						// Clear local step; server will broadcast the authoritative layer back
						stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
						render();
					} catch (_) {}
				} else {
					// Normal mode: composite preview onto base
					ctx.drawImage(previewCanvas, 0, 0);
					previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
					emitCompletedStroke(/*guide*/false);
					socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
				}
			}
		}
		if (panPointerId === e.pointerId) {
			isPanning = false;
			panPointerId = null;
			updateCursor();
		}
		activePointers.delete(e.pointerId);
		if (activePointers.size < 2) { pinchState = null; }
		// Reset stroke state
		pendingStroke = null;
		strokeStarted = false;
		isDrawing = false;
		drawingPointerId = null;
		currentStrokePoints = [];
		currentStrokeMeta = null;
		e.preventDefault();
	}

	function onWheel(e) {
		const rect = displayCanvas.getBoundingClientRect();
		const xCss = e.clientX - rect.left;
		const yCss = e.clientY - rect.top;
		const zoomFactor = Math.exp(-e.deltaY * 0.001);
		const newScale = clampScale(viewScale * zoomFactor);
		const canvasX = (xCss - viewOffsetX) / viewScale;
		const canvasY = (yCss - viewOffsetY) / viewScale;
		viewScale = newScale;
		viewOffsetX = xCss - canvasX * newScale;
		viewOffsetY = yCss - canvasY * newScale;
		render();
		e.preventDefault();
	}

	function onKeyDown(e) { if (e.code === 'Space') { isSpaceDown = true; updateCursor(); e.preventDefault(); } }
	function onKeyUp(e) { if (e.code === 'Space') { isSpaceDown = false; updateCursor(); e.preventDefault(); } }

	// Events
	window.addEventListener('resize', resizeCanvas);
	window.addEventListener('keydown', onKeyDown, { passive: false });
	window.addEventListener('keyup', onKeyUp, { passive: false });
	displayCanvas.addEventListener('pointerdown', onPointerDown, { passive: false });
	displayCanvas.addEventListener('pointermove', onPointerMove, { passive: false });
	displayCanvas.addEventListener('pointerup', onPointerUp, { passive: false });
	displayCanvas.addEventListener('pointercancel', onPointerUp, { passive: false });
	displayCanvas.addEventListener('wheel', onWheel, { passive: false });

	brushBtn.addEventListener('click', () => switchTool('brush'));
	eraserBtn.addEventListener('click', () => switchTool('eraser'));
	fillBtn.addEventListener('click', () => switchTool('fill'));
	colorPicker.addEventListener('change', (e) => { currentColor = e.target.value; addColorToPalette(e.target.value); colorSwatch.style.backgroundColor = currentColor; });
	colorPicker.addEventListener('input', (e) => { currentColor = e.target.value; colorSwatch.style.backgroundColor = currentColor; });
	brushSize.addEventListener('input', (e) => { currentSize = Number(e.target.value); sizeDot.style.width = sizeDot.style.height = Math.max(8, Math.min(32, currentSize)) + 'px'; });

	undoBtn.addEventListener('click', () => {
		if (isGuideMode) { socket.emit('guideUndo'); return; }
		socket.emit('undo');
	});
	redoBtn.addEventListener('click', () => {
		if (isGuideMode) { socket.emit('guideRedo'); return; }
		socket.emit('redo');
	});

	clearBtn.addEventListener('click', () => {
		if (isGuideMode) {
			// Clear only the active step layer and persist
			stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			const emptyUrl = remoteStepCanvas.toDataURL();
			socket.emit('saveGuideStepState', { step: currentGuideStep, dataUrl: emptyUrl });
			render();
			return;
		}
		ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
		render();
		socket.emit('clearCanvas');
		socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
	});

	// Guide mode event listeners
	const guideModeBtn = document.getElementById('guide-mode-btn');
	const guideModal = document.getElementById('guide-modal');
	const closeGuideModal = document.querySelector('.close-guide-modal');
	const guidePrev = document.getElementById('guide-prev');
	const guideNext = document.getElementById('guide-next');
	const guideSelectImage = document.getElementById('guide-select-image');
	const imageSelection = document.getElementById('image-selection');
	const imageList = document.getElementById('image-list');
	const guideStatus = document.getElementById('guide-status');
	const exitGuideModeBtn = document.getElementById('exit-guide-mode');

	guideModeBtn.addEventListener('click', () => {
		guideModal.classList.remove('hidden');
	});

	closeGuideModal.addEventListener('click', () => {
		guideModal.classList.add('hidden');
		imageSelection.classList.add('hidden');
	});

	exitGuideModeBtn.addEventListener('click', () => {
		exitGuideMode();
		guideModal.classList.add('hidden');
	});

	guideSelectImage.addEventListener('click', () => {
		imageSelection.classList.toggle('hidden');
		if (!imageSelection.classList.contains('hidden')) {
			loadAvailableImages();
		}
	});

	guidePrev.addEventListener('click', showPreviousStep);
	guideNext.addEventListener('click', showNextStep);

	// Guide mode functions
	function loadAvailableImages() {
		// For now, we'll hardcode the available images
		// In a real implementation, this would be fetched from the server
		const svgImages = [
			'hand-drawn-image-of-two-yellow-baby-chicken-being- (1).svg',
			'two-cute-turtles-swimming-in-the-sea-.svg',
			'two-happy-dolphins-.svg'
		];

		imageList.innerHTML = '';
		svgImages.forEach(imageName => {
			const imageItem = document.createElement('div');
			imageItem.className = 'image-item';
			imageItem.innerHTML = `<img src="/images/SVG/${imageName}" alt="${imageName}">`;
			imageItem.addEventListener('click', () => {
				loadSvgForGuide(`/images/SVG/${imageName}`);
				imageSelection.classList.add('hidden');
			});
			imageList.appendChild(imageItem);
		});
	}

	async function loadSvgForGuide(svgPath) {
		try {
			const response = await fetch(svgPath);
			const svgText = await response.text();
			processSvgForGuide(svgText, svgPath);
			// Announce start of guide so server can persist active SVG for reconnects
			socket.emit('guideStart', { svgPath });
		} catch (error) {
			console.error('Error loading SVG:', error);
			guideStatus.textContent = 'Error loading image';
		}
	}

	function processSvgForGuide(svgString, svgPath) {
		currentSvgPath = svgPath;
		const parser = new DOMParser();
		const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');

		if (svgDoc.querySelector('parsererror')) {
			guideStatus.textContent = 'Error parsing SVG';
			return;
		}

		const svgElement = svgDoc.documentElement;
		if (svgElement.tagName.toLowerCase() !== 'svg') {
			guideStatus.textContent = 'Invalid SVG file';
			return;
		}

		// Mount a cloned SVG into a hidden host so computed styles and getBBox work
		cleanupMountedSvg();
		guideHiddenHost = document.createElement('div');
		guideHiddenHost.style.position = 'fixed';
		guideHiddenHost.style.left = '-10000px';
		guideHiddenHost.style.top = '-10000px';
		guideHiddenHost.style.width = '0';
		guideHiddenHost.style.height = '0';
		guideHiddenHost.style.overflow = 'hidden';
		mountedSvgRoot = svgElement.cloneNode(true);
		// Ensure the SVG has displayable size; if missing, use viewBox or defaults
		const vb = mountedSvgRoot.getAttribute('viewBox');
		if (vb) {
			const parts = vb.split(/\s+/).map(Number);
			if (parts.length === 4 && parts.every(n => !isNaN(n))) {
				loadedSvgViewBox = { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
			}
		}
		if (!mountedSvgRoot.getAttribute('width') || !mountedSvgRoot.getAttribute('height')) {
			const w = loadedSvgViewBox ? loadedSvgViewBox.width : 1000;
			const h = loadedSvgViewBox ? loadedSvgViewBox.height : 1000;
			mountedSvgRoot.setAttribute('width', String(w));
			mountedSvgRoot.setAttribute('height', String(h));
		}
		guideHiddenHost.appendChild(mountedSvgRoot);
		document.body.appendChild(guideHiddenHost);

		loadedSvgDocument = mountedSvgRoot;
		extractAndSortShapes();
		
		if (sortedColorGroups.length === 0) {
			guideStatus.textContent = 'No shapes found in SVG';
			// Still allow exit and cleanup
			cleanupMountedSvg();
			return;
		}

		// Start guide mode
		isGuideMode = true;
		currentGuideStep = -1;
		guideStatus.textContent = `Loaded ${sortedColorGroups.length} color groups. Click Next to start.`;
		updateGuideControls();
		exitGuideModeBtn.classList.remove('hidden');
		render();
		initStepHistory();

		// Ensure remote step buffer is cleared at start to maintain correct z-order
		remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
	}

	function extractAndSortShapes() {
		const rawShapes = loadedSvgDocument.querySelectorAll('rect, circle, ellipse, polygon, path');
		const groupedShapes = {};

		rawShapes.forEach(shape => {
			const color = getEffectiveColor(shape);
			if (!color) return;
			const normalized = color.toLowerCase().trim();
			if (normalized === 'none' || normalized === 'transparent' || normalized === 'rgba(0, 0, 0, 0)') return;
			const area = calculateShapeArea(shape);
			if (area > 0) {
				if (!groupedShapes[normalized]) groupedShapes[normalized] = [];
				groupedShapes[normalized].push({ element: shape, area });
			}
		});

		sortedColorGroups = [];
		for (const color in groupedShapes) {
			const shapesInGroup = groupedShapes[color];
			const totalArea = shapesInGroup.reduce((sum, s) => sum + s.area, 0);
			sortedColorGroups.push({ color: color, totalArea: totalArea, shapes: shapesInGroup });
		}

		sortedColorGroups.sort((a, b) => b.totalArea - a.totalArea);
	}

	function getEffectiveColor(element) {
		// Prefer inline attributes if present
		let color = element.getAttribute('fill');
		if (color && color !== 'none') return color;
		color = element.getAttribute('stroke');
		if (color && color !== 'none') return color;
		// Walk up ancestors to inherit fill/stroke if specified
		let ancestor = element.parentElement;
		while (ancestor && ancestor !== loadedSvgDocument) {
			let ancFill = ancestor.getAttribute && ancestor.getAttribute('fill');
			if (ancFill && ancFill !== 'none') return ancFill;
			let ancStroke = ancestor.getAttribute && ancestor.getAttribute('stroke');
			if (ancStroke && ancStroke !== 'none') return ancStroke;
			ancestor = ancestor.parentElement;
		}
		// Fallback to computed style (requires mountedSVG in DOM)
		try {
			const computedStyle = window.getComputedStyle(element);
			color = computedStyle.getPropertyValue('fill');
			if (color && color !== 'none' && color !== 'rgba(0, 0, 0, 0)') return color;
			color = computedStyle.getPropertyValue('stroke');
			if (color && color !== 'none' && color !== 'rgba(0, 0, 0, 0)') return color;
		} catch (_) {}
		return null;
	}

	function calculateShapeArea(element) {
		let area = 0;
		try {
			switch (element.tagName.toLowerCase()) {
				case 'rect':
					const width = parseFloat(element.getAttribute('width'));
					const height = parseFloat(element.getAttribute('height'));
					if (!isNaN(width) && !isNaN(height)) area = width * height;
					break;
				case 'circle':
					const r = parseFloat(element.getAttribute('r'));
					if (!isNaN(r)) area = Math.PI * r * r;
					break;
				case 'ellipse':
					const rx = parseFloat(element.getAttribute('rx'));
					const ry = parseFloat(element.getAttribute('ry'));
					if (!isNaN(rx) && !isNaN(ry)) area = Math.PI * rx * ry;
					break;
				case 'polygon':
					const pointsString = element.getAttribute('points');
					if (pointsString) area = calculatePolygonArea(pointsString);
					break;
				case 'path':
					const bbox = element.getBBox();
					area = bbox.width * bbox.height;
					break;
			}
		} catch (e) {
			try {
				const bbox = element.getBBox();
				area = bbox.width * bbox.height;
			} catch (bboxError) {
				area = 0;
			}
		}
		return area;
	}

	function calculatePolygonArea(pointsString) {
		const points = pointsString.trim().split(/\s+|,/).filter(n => n !== '').map(Number);
		let area = 0;
		for (let i = 0; i < points.length; i += 2) {
			const x1 = points[i];
			const y1 = points[i + 1];
			const x2 = points[(i + 2) % points.length];
			const y2 = points[(i + 3) % points.length];
			area += (x1 * y2) - (y1 * x2);
		}
		return Math.abs(area / 2);
	}

	function showNextStep() {
		if (currentGuideStep < sortedColorGroups.length - 1) {
			// Move current step drawing to base canvas
			if (currentGuideStep >= 0) {
				ctx.drawImage(stepCanvas, 0, 0);
				ctx.drawImage(remoteStepCanvas, 0, 0);
				stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
				remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			}

			currentGuideStep++;
			renderCurrentStep();
			updateGuideControls();
			
			// Clear remote guide buffer for the new step to avoid stale overlays and sync commit
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			// Emit commit-and-goto so others also commit and switch overlay
			socket.emit('guideCommitAndGotoStep', { step: currentGuideStep, svgPath: currentSvgPath });
			initStepHistory();
		}
	}

	function showPreviousStep() {
		if (currentGuideStep > -1) {
			// Commit both local and remote step layers before moving
			ctx.drawImage(stepCanvas, 0, 0);
			ctx.drawImage(remoteStepCanvas, 0, 0);
			stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			currentGuideStep--;
			renderCurrentStep();
			updateGuideControls();
			
			// Clear remote guide buffer for the new step to avoid stale overlays
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			// Emit commit-and-goto backward so others align as well
			socket.emit('guideCommitAndGotoStep', { step: currentGuideStep, svgPath: currentSvgPath });
			initStepHistory();
		}
	}

	function renderCurrentStep() {
		// Clear suggestion canvas
		suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);

		if (currentGuideStep === -1 || !loadedSvgDocument) {
			guideStatus.textContent = 'Click Next to start';
			render();
			return;
		}

		// Draw the current step's shapes on suggestion canvas
		const group = sortedColorGroups[currentGuideStep];
		
		// Create temporary canvas to render SVG shapes
		const tempCanvas = document.createElement('canvas');
		const tempCtx = tempCanvas.getContext('2d');
		
		// Get SVG dimensions using width/height or viewBox/bbox
		let svgWidth = loadedSvgDocument.width && loadedSvgDocument.width.baseVal ? loadedSvgDocument.width.baseVal.value : null;
		let svgHeight = loadedSvgDocument.height && loadedSvgDocument.height.baseVal ? loadedSvgDocument.height.baseVal.value : null;
		if ((!svgWidth || !svgHeight) && loadedSvgViewBox) {
			svgWidth = loadedSvgViewBox.width;
			svgHeight = loadedSvgViewBox.height;
		}
		if (!svgWidth || !svgHeight) {
			// Fallback to bbox of the whole svg content
			try {
				const bbox = loadedSvgDocument.getBBox();
				svgWidth = bbox.width || 1000;
				svgHeight = bbox.height || 1000;
			} catch (_) {
				svgWidth = 1000; svgHeight = 1000;
			}
		}
		
		// Calculate scale to fit in our canvas
		const scale = Math.min(suggestionCanvas.width / svgWidth, suggestionCanvas.height / svgHeight) * 0.8;
		const offsetX = (suggestionCanvas.width - svgWidth * scale) / 2;
		const offsetY = (suggestionCanvas.height - svgHeight * scale) / 2;

		// Set suggested color in palette but draw hint shapes using a pattern to add mystery
		currentColor = group.color;
		colorPicker.value = group.color;
		colorSwatch.style.backgroundColor = group.color;
		addColorToPalette(group.color);

		// Create grey pattern for suggestion shapes
		const patternSize = 16;
		const pat = document.createElement('canvas');
		pat.width = patternSize; pat.height = patternSize;
		const pctx = pat.getContext('2d');
		pctx.fillStyle = '#b0b0b0';
		pctx.fillRect(0, 0, patternSize, patternSize);
		pctx.strokeStyle = '#8c8c8c';
		pctx.lineWidth = 2;
		pctx.beginPath();
		pctx.moveTo(0, 0); pctx.lineTo(patternSize, patternSize);
		pctx.moveTo(0, patternSize); pctx.lineTo(patternSize, 0);
		pctx.stroke();
		const fillPattern = suggestionCtx.createPattern(pat, 'repeat');

		// Draw shapes for current step using the pattern
		group.shapes.forEach(shapeData => {
			drawSvgShape(suggestionCtx, shapeData.element, scale, offsetX, offsetY, fillPattern, /*usePattern*/true);
		});

		guideStatus.textContent = `Step ${currentGuideStep + 1} of ${sortedColorGroups.length}: Color "${group.color}"`;
		render();
	}

	function drawSvgShape(ctx, element, scale, offsetX, offsetY, color, usePattern = false) {
		ctx.save();
		ctx.fillStyle = color;
		ctx.strokeStyle = usePattern ? '#666666' : color;
		
		switch (element.tagName.toLowerCase()) {
			case 'rect':
				const x = parseFloat(element.getAttribute('x') || 0) * scale + offsetX;
				const y = parseFloat(element.getAttribute('y') || 0) * scale + offsetY;
				const width = parseFloat(element.getAttribute('width') || 0) * scale;
				const height = parseFloat(element.getAttribute('height') || 0) * scale;
				ctx.fillRect(x, y, width, height);
				break;
			case 'circle':
				const cx = parseFloat(element.getAttribute('cx') || 0) * scale + offsetX;
				const cy = parseFloat(element.getAttribute('cy') || 0) * scale + offsetY;
				const r = parseFloat(element.getAttribute('r') || 0) * scale;
				ctx.beginPath();
				ctx.arc(cx, cy, r, 0, Math.PI * 2);
				ctx.fill();
				break;
			case 'ellipse':
				const ex = parseFloat(element.getAttribute('cx') || 0) * scale + offsetX;
				const ey = parseFloat(element.getAttribute('cy') || 0) * scale + offsetY;
				const rx = parseFloat(element.getAttribute('rx') || 0) * scale;
				const ry = parseFloat(element.getAttribute('ry') || 0) * scale;
				ctx.beginPath();
				ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
				ctx.fill();
				break;
			case 'polygon':
				const points = element.getAttribute('points');
				if (points) {
					const coords = points.trim().split(/\s+|,/).filter(n => n !== '').map(Number);
					ctx.beginPath();
					for (let i = 0; i < coords.length; i += 2) {
						const px = coords[i] * scale + offsetX;
						const py = coords[i + 1] * scale + offsetY;
						if (i === 0) ctx.moveTo(px, py);
						else ctx.lineTo(px, py);
					}
					ctx.closePath();
					ctx.fill();
				}
				break;
			case 'path':
				// Render a path using Path2D if available
				try {
					const d = element.getAttribute('d');
					if (d && window.Path2D) {
						const p = new Path2D(d);
						ctx.translate(offsetX, offsetY);
						ctx.scale(scale, scale);
						ctx.fill(p);
					} else {
						const bbox = element.getBBox();
						ctx.fillRect(bbox.x * scale + offsetX, bbox.y * scale + offsetY, bbox.width * scale, bbox.height * scale);
					}
				} catch (_) {
					const bbox = element.getBBox();
					ctx.fillRect(bbox.x * scale + offsetX, bbox.y * scale + offsetY, bbox.width * scale, bbox.height * scale);
				}
				break;
		}
		
		ctx.restore();
	}

	function updateGuideControls() {
		guidePrev.disabled = currentGuideStep <= -1;
		guideNext.disabled = currentGuideStep >= sortedColorGroups.length - 1 || sortedColorGroups.length === 0;
		
		// Check if all steps are completed
		if (currentGuideStep >= sortedColorGroups.length - 1 && sortedColorGroups.length > 0) {
			guideStatus.textContent = `All steps completed! You can exit guide mode now.`;
		}
	}

	function exitGuideMode() {
		if (isGuideMode) {
			// Move all drawings from step canvas (local + remote) to main canvas
			ctx.drawImage(stepCanvas, 0, 0);
			ctx.drawImage(remoteStepCanvas, 0, 0);
			stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
			remoteStepCtx.clearRect(0, 0, remoteStepCanvas.width, remoteStepCanvas.height);
			
			// Clear suggestion canvas
			suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);
			
			// Reset guide mode state
			isGuideMode = false;
			currentGuideStep = -1;
			sortedColorGroups = [];
			loadedSvgDocument = null;
			currentSvgPath = null;
			loadedSvgViewBox = null;
			cleanupMountedSvg();
			
			// Hide exit button
			exitGuideModeBtn.classList.add('hidden');
			
			// Prepare authoritative base snapshot and save
			const baseDataUrl = drawingCanvas.toDataURL();
			socket.emit('saveState', { dataUrl: baseDataUrl });
			render();
			// Notify others to exit and apply this snapshot
			socket.emit('guideExit', { baseDataUrl });
		}
	}

	function cleanupMountedSvg() {
		if (guideHiddenHost) {
			try { document.body.removeChild(guideHiddenHost); } catch (_) {}
		}
		guideHiddenHost = null;
		mountedSvgRoot = null;
	}

	// Initial
	resizeCanvas();
	updatePalette();
	switchTool('brush');
	render();
	updateCursor();
	// reflect current UI state
	colorSwatch.style.backgroundColor = currentColor;
	sizeDot.style.width = sizeDot.style.height = Math.max(8, Math.min(32, currentSize)) + 'px';
});