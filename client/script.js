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

	// --- Guide overlay canvases ---
	const suggestionCanvas = document.createElement('canvas');
	suggestionCanvas.width = 2048;
	suggestionCanvas.height = 2048;
	const suggestionCtx = suggestionCanvas.getContext('2d');

	const stepCanvas = document.createElement('canvas');
	stepCanvas.width = 2048;
	stepCanvas.height = 2048;
	const stepCtx = stepCanvas.getContext('2d');

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
		displayCtx.drawImage(drawingCanvas, 0, 0);
		// Draw suggestion overlay (semi-transparent)
		displayCtx.drawImage(suggestionCanvas, 0, 0);
		// Draw current step painting
		displayCtx.drawImage(stepCanvas, 0, 0);
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
		ctx.save();
		ctx.globalCompositeOperation = 'source-over';
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = size;
		ctx.strokeStyle = isEraser ? '#ffffff' : color;
		ctx.beginPath();
		if (points.length === 1) {
			const p = points[0];
			ctx.moveTo(p.x, p.y);
			ctx.lineTo(p.x, p.y);
			ctx.stroke();
			ctx.restore();
			render();
			return;
		}
		let prev = points[0];
		ctx.moveTo(prev.x, prev.y);
		for (let i = 1; i < points.length; i++) {
			const curr = points[i];
			const midX = (prev.x + curr.x) / 2;
			const midY = (prev.y + curr.y) / 2;
			ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
			prev = curr;
		}
		ctx.lineTo(prev.x, prev.y);
		ctx.stroke();
		ctx.restore();
		render();
	}

	function applyStepStrokeFromServer(stroke) {
		if (!stroke || !stroke.points || stroke.points.length === 0) return;
		const { tool, color, size, points } = stroke;
		const isEraser = tool === 'eraser';
		stepCtx.save();
		stepCtx.globalCompositeOperation = 'source-over';
		stepCtx.lineCap = 'round';
		stepCtx.lineJoin = 'round';
		stepCtx.lineWidth = size;
		stepCtx.strokeStyle = isEraser ? '#ffffff' : color;
		stepCtx.beginPath();
		if (points.length === 1) {
			const p = points[0];
			stepCtx.moveTo(p.x, p.y);
			stepCtx.lineTo(p.x, p.y);
			stepCtx.stroke();
			stepCtx.restore();
			render();
			return;
		}
		let prev = points[0];
		stepCtx.moveTo(prev.x, prev.y);
		for (let i = 1; i < points.length; i++) {
			const curr = points[i];
			const midX = (prev.x + curr.x) / 2;
			const midY = (prev.y + curr.y) / 2;
			stepCtx.quadraticCurveTo(prev.x, prev.y, midX, midY);
			prev = curr;
		}
		stepCtx.lineTo(prev.x, prev.y);
		stepCtx.stroke();
		stepCtx.restore();
		render();
	}

	function emitCompletedStroke() {
		if (!currentStrokeMeta || currentStrokePoints.length === 0) return;
		const stroke = {
			tool: currentStrokeMeta.tool,
			color: currentStrokeMeta.color,
			size: currentStrokeMeta.size,
			points: currentStrokePoints.slice()
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
		// Clear preview before starting a new stroke
		previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
		previewCtx.globalCompositeOperation = 'source-over';
		previewCtx.beginPath();
		previewCtx.lineCap = 'round';
		previewCtx.lineJoin = 'round';
		previewCtx.lineWidth = data.size;
		previewCtx.strokeStyle = isEraser ? '#ffffff' : data.color;
		[lastX, lastY] = [data.x, data.y];
		previewCtx.moveTo(lastX, lastY);
		previewCtx.lineTo(lastX, lastY);
		previewCtx.stroke();
		render();
	}

	function handleDraw(data) {
		const midX = (lastX + data.x) / 2;
		const midY = (lastY + data.y) / 2;
		previewCtx.quadraticCurveTo(lastX, lastY, midX, midY);
		previewCtx.stroke();
		[lastX, lastY] = [data.x, data.y];
		render();
	}

	function handleStopDrawing() { ctx.beginPath(); }

	function switchTool(tool) {
		currentTool = tool;
		[brushBtn, eraserBtn, fillBtn].forEach(b => b.classList.remove('active'));
		const id = tool === 'brush' ? 'brushBtn' : tool === 'eraser' ? 'eraserBtn' : 'fillBtn';
		document.getElementById(id).classList.add('active');
		updateCursor();
	}

	function floodFillOn(ctxTarget, canvasTarget, { startX, startY, color }) {
		const tolerance = 32;
		const width = canvasTarget.width;
		const height = canvasTarget.height;
		const imageData = ctxTarget.getImageData(0, 0, width, height);
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

		tempCtx.putImageData(maskData, 0, 0);
		tempCtx.globalCompositeOperation = 'source-in';
		tempCtx.fillStyle = color;
		tempCtx.fillRect(0, 0, width, height);
		ctxTarget.drawImage(tempCanvas, 0, 0);
		render();
	}

	function floodFill(data) { floodFillOn(ctx, drawingCanvas, data); }
	function stepFloodFill(data) { floodFillOn(stepCtx, stepCanvas, data); }

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
	socket.on('fill', (data) => { floodFill(data); });
	socket.on('stepFill', (data) => { stepFloodFill(data); });
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
			suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);
			stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
			render();
		};
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
			const data = pendingFill;
			pendingFill = null;
			fillPointerId = null;
			if (!pinchState) {
				if (guideActive) {
					socket.emit('stepFill', data);
					stepFloodFill(data);
				} else {
					socket.emit('fill', data);
					floodFill(data);
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
				// Composite preview onto active target layer, clear preview, then emit
				if (guideActive) {
					stepCtx.drawImage(previewCanvas, 0, 0);
					previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
					const stroke = {
						tool: currentStrokeMeta.tool,
						color: currentStrokeMeta.color,
						size: currentStrokeMeta.size,
						points: currentStrokePoints.slice()
					};
					socket.emit('stepStroke', stroke);
				} else {
					ctx.drawImage(previewCanvas, 0, 0);
					previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
					emitCompletedStroke();
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

	undoBtn.addEventListener('click', () => socket.emit('undo'));
	redoBtn.addEventListener('click', () => socket.emit('redo'));

	clearBtn.addEventListener('click', () => {
		ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
		suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);
		stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
		render();
		socket.emit('clearCanvas');
		socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
	});

	// --- Guide UI and Logic ---
	const guideToggleBtn = document.getElementById('guideToggleBtn');
	const guidePanel = document.getElementById('guidePanel');
	const guidePrevBtn = document.getElementById('guidePrevBtn');
	const guideNextBtn = document.getElementById('guideNextBtn');
	const guidePickBtn = document.getElementById('guidePickBtn');
	const guideImageList = document.getElementById('guideImageList');
	const guideStatus = document.getElementById('guideStatus');

	let guideActive = false;
	let guideSvgPath = null;
	let originalSvgDocument = null;
	let originalSvgString = null;
	let guideGroups = [];
	let guideStepIndex = -1;
	let guideViewBox = null; // {minX, minY, width, height}

	function toggleGuidePanel() {
		guidePanel.classList.toggle('hidden');
	}

	guideToggleBtn.addEventListener('click', toggleGuidePanel);
	guidePickBtn.addEventListener('click', async () => {
		if (!guideImageList.classList.contains('hidden')) {
			guideImageList.classList.add('hidden');
			return;
		}
		guideImageList.innerHTML = '';
		guideStatus.textContent = 'Loading images...';
		guideImageList.classList.remove('hidden');
		try {
			const res = await fetch('/api/svgs');
			const files = await res.json();
			guideImageList.innerHTML = '';
			files.forEach(f => {
				const item = document.createElement('div');
				item.className = 'guide-item';
				item.innerHTML = `<img src="${f.url}" alt=""><span>${f.name}</span>`;
				item.addEventListener('click', () => {
					guideImageList.classList.add('hidden');
					guideStatus.textContent = 'Setting guide...';
					socket.emit('guideSet', { svgPath: f.url, stepIndex: 0 });
				});
				guideImageList.appendChild(item);
			});
			guideStatus.textContent = files.length ? 'Pick an image' : 'No SVGs found.';
		} catch (e) {
			guideStatus.textContent = 'Failed to load image list.';
		}
	});

	guidePrevBtn.addEventListener('click', () => {
		if (!guideActive) return;
		const nextIndex = Math.max(-1, guideStepIndex - 1);
		socket.emit('guideStep', { stepIndex: nextIndex });
		// Clear current step layer when moving back
		stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
		render();
	});

	guideNextBtn.addEventListener('click', () => {
		if (!guideActive) return;
		// Commit current step drawings to base first
		socket.emit('commitStep');
		// Advance step after commit
		const nextIndex = Math.min(guideGroups.length - 1, guideStepIndex + 1);
		socket.emit('guideStep', { stepIndex: nextIndex });
	});

	function clearSuggestion() {
		suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);
	}

	function clearStepLayer() {
		stepCtx.clearRect(0, 0, stepCanvas.width, stepCanvas.height);
	}

	function parseSvgAndGroup(svgString) {
		const parser = new DOMParser();
		const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
		if (svgDoc.querySelector('parsererror')) {
			throw new Error('Invalid SVG');
		}
		const svgEl = svgDoc.documentElement;
		const vb = svgEl.getAttribute('viewBox');
		if (vb) {
			const parts = vb.trim().split(/\s+/).map(Number);
			guideViewBox = { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
		} else {
			const width = parseFloat(svgEl.getAttribute('width')) || 2048;
			const height = parseFloat(svgEl.getAttribute('height')) || 2048;
			guideViewBox = { minX: 0, minY: 0, width, height };
		}
		// assign data-guide-id to each shape and compute groups
		const rawShapes = svgEl.querySelectorAll('rect, circle, ellipse, polygon, path');
		let idCounter = 0;
		const grouped = {};
		rawShapes.forEach(shape => {
			shape.setAttribute('data-guide-id', String(idCounter));
			idCounter++;
			let color = getEffectiveColor(shape);
			if (!color || color === 'none') return;
			color = color.toLowerCase().trim();
			const area = calculateShapeArea(shape);
			if (area <= 0) return;
			if (!grouped[color]) grouped[color] = [];
			grouped[color].push({ id: shape.getAttribute('data-guide-id'), area });
		});
		const groups = [];
		for (const color in grouped) {
			const arr = grouped[color];
			const totalArea = arr.reduce((s, a) => s + a.area, 0);
			groups.push({ color, totalArea, ids: arr.map(a => a.id) });
		}
		groups.sort((a, b) => b.totalArea - a.totalArea);
		return { svgEl, groups };
	}

	function getEffectiveColor(element) {
		let color = element.getAttribute('fill');
		if (color && color !== 'none') return color;
		color = element.getAttribute('stroke');
		if (color && color !== 'none') return color;
		try {
			const computedStyle = window.getComputedStyle(element);
			color = computedStyle.getPropertyValue('fill');
			if (color && color !== 'none' && color !== 'rgba(0, 0, 0, 0)') return color;
			color = computedStyle.getPropertyValue('stroke');
			if (color && color !== 'none' && color !== 'rgba(0, 0, 0, 0)') return color;
		} catch (e) { }
		return null;
	}

	function calculateShapeArea(element) {
		let area = 0;
		try {
			switch (element.tagName.toLowerCase()) {
				case 'rect': {
					const width = parseFloat(element.getAttribute('width'));
					const height = parseFloat(element.getAttribute('height'));
					if (!isNaN(width) && !isNaN(height)) area = width * height;
					break;
				}
				case 'circle': {
					const r = parseFloat(element.getAttribute('r'));
					if (!isNaN(r)) area = Math.PI * r * r;
					break;
				}
				case 'ellipse': {
					const rx = parseFloat(element.getAttribute('rx'));
					const ry = parseFloat(element.getAttribute('ry'));
					if (!isNaN(rx) && !isNaN(ry)) area = Math.PI * rx * ry;
					break;
				}
				case 'polygon': {
					const pointsString = element.getAttribute('points');
					if (pointsString) area = calculatePolygonArea(pointsString);
					break;
				}
				case 'path': {
					const bbox = element.getBBox();
					area = bbox.width * bbox.height;
					break;
				}
				default: area = 0; break;
			}
		} catch (e) {
			try { const bbox = element.getBBox(); area = bbox.width * bbox.height; } catch (_) { area = 0; }
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

	async function loadGuideSvg(svgPath, stepIndex) {
		guideStatus.textContent = 'Loading SVG...';
		const res = await fetch(svgPath);
		const svgString = await res.text();
		originalSvgString = svgString;
		const { svgEl, groups } = parseSvgAndGroup(svgString);
		originalSvgDocument = svgEl;
		guideGroups = groups;
		guideActive = true;
		guideSvgPath = svgPath;
		guideStepIndex = typeof stepIndex === 'number' ? stepIndex : -1;
		renderSuggestion();
		const total = guideGroups.length;
		guideStatus.textContent = total ? `Ready. ${total} color groups.` : 'No drawable groups found.';
	}

	function renderSuggestion() {
		clearSuggestion();
		if (!guideActive || guideStepIndex < 0 || guideStepIndex >= guideGroups.length) { render(); return; }
		const group = guideGroups[guideStepIndex];
		// clone svg and hide non-group shapes
		const clone = originalSvgDocument.cloneNode(true);
		const all = clone.querySelectorAll('rect, circle, ellipse, polygon, path');
		all.forEach(el => {
			const id = el.getAttribute('data-guide-id');
			if (!group.ids.includes(id)) {
				el.setAttribute('opacity', '0');
			} else {
				el.setAttribute('opacity', '0.45');
				el.setAttribute('stroke', '#000000');
				el.setAttribute('stroke-width', '1');
			}
		});
		// serialize and render into suggestion canvas with viewBox fit
		const serializer = new XMLSerializer();
		const svgStr = serializer.serializeToString(clone);
		const blob = new Blob([svgStr], { type: 'image/svg+xml' });
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			suggestionCtx.save();
			suggestionCtx.clearRect(0, 0, suggestionCanvas.width, suggestionCanvas.height);
			const vb = guideViewBox || { minX: 0, minY: 0, width: img.width, height: img.height };
			const scale = Math.min(2048 / vb.width, 2048 / vb.height);
			const drawW = vb.width * scale;
			const drawH = vb.height * scale;
			const dx = Math.floor((2048 - drawW) / 2 - vb.minX * scale);
			const dy = Math.floor((2048 - drawH) / 2 - vb.minY * scale);
			suggestionCtx.imageSmoothingEnabled = true;
			suggestionCtx.drawImage(img, dx, dy, drawW, drawH);
			suggestionCtx.restore();
			URL.revokeObjectURL(url);
			render();
		};
		img.onerror = () => { URL.revokeObjectURL(url); };
		img.src = url;
	}

	// Socket sync for guide
	socket.on('guideSet', async ({ svgPath, stepIndex }) => {
		try {
			await loadGuideSvg(svgPath, stepIndex);
			guideStatus.textContent = 'Guide ready.';
		} catch (e) {
			guideStatus.textContent = 'Failed to load guide.';
		}
	});

	socket.on('guideStep', ({ stepIndex }) => {
		guideStepIndex = stepIndex;
		renderSuggestion();
	});

	socket.on('guideEnd', () => {
		guideActive = false;
		guideSvgPath = null;
		originalSvgDocument = null;
		originalSvgString = null;
		guideGroups = [];
		guideStepIndex = -1;
		clearSuggestion();
		clearStepLayer();
		render();
	});

	socket.on('applyStepStroke', (stroke) => { applyStepStrokeFromServer(stroke); });

	socket.on('commitStep', () => {
		// merge step layer onto base and clear
		ctx.drawImage(stepCanvas, 0, 0);
		clearStepLayer();
		render();
		// save state of base after commit
		socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
	});

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