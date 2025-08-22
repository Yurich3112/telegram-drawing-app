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

	// Track remote users' stroke states to avoid conflicts
	const remoteStrokes = new Map(); // userId -> { lastX, lastY, color, size, tool, started }

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
		// Outline the drawing area for clear boundaries
		displayCtx.save();
		displayCtx.strokeStyle = 'rgba(0,0,0,0.6)';
		displayCtx.lineWidth = Math.max(1 / (viewScale * dpr), 0.5 / dpr);
		displayCtx.strokeRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		displayCtx.restore();
		displayCtx.setTransform(1, 0, 0, 1, 0, 0);
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
		ctx.globalCompositeOperation = 'source-over';
		ctx.beginPath();
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = data.size;
		ctx.strokeStyle = isEraser ? '#ffffff' : data.color;
		[lastX, lastY] = [data.x, data.y];
		ctx.moveTo(lastX, lastY);
		ctx.lineTo(lastX, lastY);
		ctx.stroke();
		render();
	}

	function handleDraw(data) {
		const midX = (lastX + data.x) / 2;
		const midY = (lastY + data.y) / 2;
		// Begin a separate path per segment to prevent interference with remote paths
		ctx.beginPath();
		ctx.moveTo(lastX, lastY);
		ctx.quadraticCurveTo(lastX, lastY, midX, midY);
		ctx.stroke();
		[lastX, lastY] = [data.x, data.y];
		render();
	}

	function handleStopDrawing() { ctx.beginPath(); }

	// --- Remote drawing handlers (per user) ---
	function handleRemoteStartDrawing(data) {
		const { userId, x, y, color, size, tool } = data;
		const isEraser = tool === 'eraser';
		remoteStrokes.set(userId, { lastX: x, lastY: y, color, size, tool, started: true });
		// Draw initial dot without affecting local path
		ctx.save();
		ctx.globalCompositeOperation = 'source-over';
		ctx.beginPath();
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = size;
		ctx.strokeStyle = isEraser ? '#ffffff' : color;
		ctx.moveTo(x, y);
		ctx.lineTo(x, y);
		ctx.stroke();
		ctx.restore();
		render();
	}

	function handleRemoteDraw(data) {
		const { userId, x, y } = data;
		const s = remoteStrokes.get(userId);
		if (!s || !s.started) return;
		const midX = (s.lastX + x) / 2;
		const midY = (s.lastY + y) / 2;
		ctx.save();
		ctx.globalCompositeOperation = 'source-over';
		ctx.beginPath();
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = s.size;
		ctx.strokeStyle = s.tool === 'eraser' ? '#ffffff' : s.color;
		ctx.moveTo(s.lastX, s.lastY);
		ctx.quadraticCurveTo(s.lastX, s.lastY, midX, midY);
		ctx.stroke();
		ctx.restore();
		s.lastX = x; s.lastY = y;
		render();
	}

	function handleRemoteStopDrawing(data) {
		const { userId } = data || {};
		const s = userId ? remoteStrokes.get(userId) : null;
		if (s) s.started = false;
		// Ensure local path is not affected; no-op on ctx path
	}

	function switchTool(tool) {
		currentTool = tool;
		[brushBtn, eraserBtn, fillBtn].forEach(b => b.classList.remove('active'));
		const id = tool === 'brush' ? 'brushBtn' : tool === 'eraser' ? 'eraserBtn' : 'fillBtn';
		document.getElementById(id).classList.add('active');
		updateCursor();
	}

	function floodFill({ startX, startY, color }) {
		const tolerance = 32;
		const width = drawingCanvas.width;
		const height = drawingCanvas.height;
		const imageData = ctx.getImageData(0, 0, width, height);
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
		ctx.drawImage(tempCanvas, 0, 0);
		render();
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
	socket.on('startDrawing', (data) => { handleRemoteStartDrawing(data); });
	socket.on('draw', (data) => { handleRemoteDraw(data); });
	socket.on('stopDrawing', (data) => { handleRemoteStopDrawing(data); });
	socket.on('fill', (data) => { floodFill(data); });
	socket.on('clearCanvas', () => { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height); render(); });

	// Drawing lock events
	socket.on('drawingLocked', (data) => {
		isCanvasLocked = true;
		lockMessage = data.message;
		showNotification(data.message, 4000);
		updateCursor();
		
		// Add visual locked state
		displayCanvas.classList.add('locked');
		canvasContainer.classList.add('locked');
		
		// Cancel any pending drawing operations
		if (isDrawing || pendingStroke) {
			isDrawing = false;
			pendingStroke = null;
			strokeStarted = false;
			drawingPointerId = null;
		}
	});

	socket.on('drawingUnlocked', (data) => {
		isCanvasLocked = false;
		lockMessage = '';
		showNotification(data.message, 2000);
		updateCursor();
		
		// Remove visual locked state
		displayCanvas.classList.remove('locked');
		canvasContainer.classList.remove('locked');
	});

	socket.on('loadCanvas', ({ dataUrl }) => {
		const img = new Image();
		img.src = dataUrl;
		img.onload = () => {
			ctx.globalCompositeOperation = 'source-over';
			ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
			ctx.drawImage(img, 0, 0);
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
		socket.emit('startDrawing', data);
	}

	// Handle server rejection of drawing request
	socket.on('drawingLocked', (data) => {
		// If we were trying to start drawing, cancel it
		if (strokeStarted && !isCanvasLocked) {
			strokeStarted = false;
			isDrawing = false;
			pendingStroke = null;
			drawingPointerId = null;
			handleStopDrawing();
		}
	});

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

		// Check if canvas is locked for drawing
		if (isCanvasLocked && currentTool !== 'fill') {
			showNotification('Canvas is locked. Please wait for the current drawing to finish.', 2000);
			e.preventDefault();
			return;
		}

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
				socket.emit('draw', data);
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
				socket.emit('fill', data);
				floodFill(data);
				socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
			}
		}

		if (drawingPointerId === e.pointerId && (isDrawing || pendingStroke)) {
			// If no movement occurred and stroke not started, treat as dot tap
			if (!strokeStarted && pendingStroke) {
				beginStroke(pendingStroke);
				handleStopDrawing();
				socket.emit('stopDrawing');
				socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
			} else if (strokeStarted) {
				isDrawing = false;
				socket.emit('stopDrawing');
				socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
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
		if (isCanvasLocked) {
			showNotification('Please wait for the current drawing to finish before clearing.', 2000);
			return;
		}
		ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		render();
		socket.emit('clearCanvas');
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