window.addEventListener('load', () => {
	// Tell the Telegram client that the app is ready.
	window.Telegram.WebApp.ready();

	// Socket connection
	const socket = io('https://our-drawing-app-server.onrender.com');

	// --- NEW: Modal and User List Elements ---
	const signatureModal = document.getElementById('signature-modal');
	const signatureCanvas = document.getElementById('signature-canvas');
	const sigCtx = signatureCanvas.getContext('2d');
	const confirmBtn = document.getElementById('confirm-signature');
	const userListDiv = document.getElementById('user-list');

	// --- Main Canvas & Toolbar Elements ---
	const displayCanvas = document.getElementById('drawing-canvas'); // Visible canvas (viewport)
	const displayCtx = displayCanvas.getContext('2d');
	const canvasContainer = document.getElementById('canvas-container');

	// Offscreen drawing surface (fixed size 2048x2048)
	const drawingCanvas = document.createElement('canvas');
	drawingCanvas.width = 2048;
	drawingCanvas.height = 2048;
	const ctx = drawingCanvas.getContext('2d', { willReadFrequently: true });

	const colorPicker = document.getElementById('colorPicker');
	const brushSize = document.getElementById('brushSize');
	const clearBtn = document.getElementById('clearBtn');
	const undoBtn = document.getElementById('undoBtn');
	const redoBtn = document.getElementById('redoBtn');
	const brushBtn = document.getElementById('brushBtn');
	const eraserBtn = document.getElementById('eraserBtn');
	const fillBtn = document.getElementById('fillBtn');
	const paletteContainer = document.getElementById('color-palette');

	// --- 1. Signature Pad Logic ---
	let isSigDrawing = false;
	let lastSigX = 0;
	let lastSigY = 0;
	sigCtx.strokeStyle = '#000000';
	sigCtx.lineWidth = 3;
	sigCtx.lineCap = 'round';

	function handleSigStart(e) {
		isSigDrawing = true;
		[lastSigX, lastSigY] = [e.offsetX, e.offsetY];
		confirmBtn.disabled = false; // Enable button once they start drawing
	}

	function handleSigDraw(e) {
		if (!isSigDrawing) return;
		sigCtx.beginPath();
		sigCtx.moveTo(lastSigX, lastSigY);
		sigCtx.lineTo(e.offsetX, e.offsetY);
		sigCtx.stroke();
		[lastSigX, lastSigY] = [e.offsetX, e.offsetY];
	}

	function handleSigStop() {
		isSigDrawing = false;
	}

	signatureCanvas.addEventListener('mousedown', handleSigStart);
	signatureCanvas.addEventListener('mousemove', handleSigDraw);
	signatureCanvas.addEventListener('mouseup', handleSigStop);
	signatureCanvas.addEventListener('mouseleave', handleSigStop);

	// Join button sends signature to server and hides the modal
	confirmBtn.addEventListener('click', () => {
		const signatureDataUrl = signatureCanvas.toDataURL();
		socket.emit('userSignedUp', { signature: signatureDataUrl });
		signatureModal.classList.add('hidden');
	});

	// --- 2. Main Application Logic ---

	// State Variables for Main App
	let isDrawing = false;
	let currentTool = 'brush';
	let currentColor = colorPicker.value;
	let currentSize = Number(brushSize.value);
	let lastX = 0;
	let lastY = 0;
	let recentColors = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', null, null, null, null, null];

	// Viewport transform state (applied to visible canvas only)
	let viewScale = 1;
	let viewOffsetX = 0;
	let viewOffsetY = 0;
	const MIN_SCALE = 0.25;
	const MAX_SCALE = 8;

	// Active pointers for pinch-zoom/pan
	const activePointers = new Map(); // id -> { clientX, clientY }
	let drawingPointerId = null;
	let pinchState = null; // { startDist, startScale, startOffsetX, startOffsetY, centerX, centerY }

	function clampScale(s) {
		return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
	}

	function getDPR() {
		return window.devicePixelRatio || 1;
	}

	function resizeCanvas() {
		// Fit display canvas to container size (CSS pixels) and account for DPR
		const rect = canvasContainer.getBoundingClientRect();
		const dpr = getDPR();
		displayCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
		displayCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
		displayCanvas.style.width = rect.width + 'px';
		displayCanvas.style.height = rect.height + 'px';
		render();
		// Ask server for the latest drawing to redraw after resize
		socket.emit('requestCanvasState');
	}

	function render() {
		// Clear display and draw offscreen canvas using current view transform
		const dpr = getDPR();
		displayCtx.setTransform(1, 0, 0, 1, 0, 0);
		displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
		displayCtx.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, viewOffsetX * dpr, viewOffsetY * dpr);
		displayCtx.imageSmoothingEnabled = false;
		displayCtx.drawImage(drawingCanvas, 0, 0);
		displayCtx.setTransform(1, 0, 0, 1, 0, 0);
	}

	function canvasPointFromClient(clientX, clientY) {
		// Map from screen (client) coordinates to drawingCanvas coordinates
		const rect = displayCanvas.getBoundingClientRect();
		const xCss = clientX - rect.left;
		const yCss = clientY - rect.top;
		const x = (xCss - viewOffsetX) / viewScale;
		const y = (yCss - viewOffsetY) / viewScale;
		return { x, y };
	}

	function handleStartDrawing(data) {
		ctx.globalCompositeOperation = data.tool === 'eraser' ? 'destination-out' : 'source-over';
		ctx.beginPath();
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = data.size;
		ctx.strokeStyle = data.color;
		[lastX, lastY] = [data.x, data.y];
		ctx.moveTo(lastX, lastY);
		ctx.lineTo(lastX, lastY);
		ctx.stroke();
		render();
	}

	function handleDraw(data) {
		const midX = (lastX + data.x) / 2;
		const midY = (lastY + data.y) / 2;
		ctx.quadraticCurveTo(lastX, lastY, midX, midY);
		ctx.stroke();
		[lastX, lastY] = [data.x, data.y];
		render();
	}

	function handleStopDrawing() {
		ctx.beginPath();
	}

	function switchTool(tool) {
		currentTool = tool;
		document.querySelectorAll('.tool').forEach(t => t.classList.remove('active'));
		document.getElementById(`${tool}Btn`).classList.add('active');
		displayCanvas.style.cursor = tool === 'fill' ? 'pointer' : 'crosshair';
	}

	function floodFill({ startX, startY, color }) {
		const tolerance = 32;
		const imageData = ctx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height);
		const data = imageData.data;
		const startIdx = (Math.floor(startY) * drawingCanvas.width + Math.floor(startX)) * 4;
		const targetColor = [data[startIdx], data[startIdx + 1], data[startIdx + 2]];
		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
		if (!result) return;
		const fillColorRgb = [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
		if (targetColor.join(',') === fillColorRgb.join(',')) return;
		function colorsMatch(idx) {
			const rDiff = data[idx] - targetColor[0];
			const gDiff = data[idx + 1] - targetColor[1];
			const bDiff = data[idx + 2] - targetColor[2];
			return (rDiff * rDiff + gDiff * gDiff + bDiff * bDiff) < tolerance * tolerance;
		}
		const tempCanvas = document.createElement('canvas');
		tempCanvas.width = drawingCanvas.width;
		tempCanvas.height = drawingCanvas.height;
		const tempCtx = tempCanvas.getContext('2d');
		const maskData = tempCtx.createImageData(drawingCanvas.width, drawingCanvas.height);
		const visited = new Set();
		const queue = [[Math.floor(startX), Math.floor(startY)]];
		visited.add(`${Math.floor(startX)},${Math.floor(startY)}`);
		while (queue.length > 0) {
			const [x, y] = queue.shift();
			const idx = (y * drawingCanvas.width + x) * 4;
			maskData.data[idx + 3] = 255;
			const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
			for (const [nx, ny] of neighbors) {
				const key = `${nx},${ny}`;
				if (nx >= 0 && nx < drawingCanvas.width && ny >= 0 && ny < drawingCanvas.height && !visited.has(key)) {
					visited.add(key);
					if (colorsMatch((ny * drawingCanvas.width + nx) * 4)) queue.push([nx, ny]);
				}
			}
		}
		tempCtx.putImageData(maskData, 0, 0);
		tempCtx.globalCompositeOperation = 'source-in';
		tempCtx.fillStyle = color;
		tempCtx.fillRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		ctx.drawImage(tempCanvas, 0, 0);
		render();
	}

	function updatePalette() {
		paletteContainer.innerHTML = '';
		recentColors.forEach(color => {
			const colorCircle = document.createElement('div');
			colorCircle.classList.add('palette-color');
			if (color) {
				colorCircle.style.backgroundColor = color;
				colorCircle.addEventListener('click', () => {
					currentColor = color;
					colorPicker.value = color;
				});
			} else {
				colorCircle.classList.add('empty');
			}
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

	// --- 3. Setup Socket and Event Listeners for the Main App ---

	// Listen for drawing events from the server
	socket.on('startDrawing', (data) => { handleStartDrawing(data); });
	socket.on('draw', (data) => { handleDraw(data); });
	socket.on('stopDrawing', () => { handleStopDrawing(); });
	socket.on('fill', (data) => { floodFill(data); });
	socket.on('clearCanvas', () => { ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height); render(); });

	// Listen for history and user list updates from the server
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

	// Pointer input handling (supports mouse, touch, pen)
	function onPointerDown(e) {
		displayCanvas.setPointerCapture(e.pointerId);
		activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

		if (activePointers.size === 2) {
			// Start pinch-zoom
			const [p1, p2] = Array.from(activePointers.values());
			const dx = p2.clientX - p1.clientX;
			const dy = p2.clientY - p1.clientY;
			const centerX = (p1.clientX + p2.clientX) / 2;
			const centerY = (p1.clientY + p2.clientY) / 2;
			pinchState = {
				startDist: Math.hypot(dx, dy),
				startScale: viewScale,
				startOffsetX: viewOffsetX,
				startOffsetY: viewOffsetY,
				centerX,
				centerY
			};
			drawingPointerId = null; // Cancel any drawing when pinch begins
		} else if (activePointers.size === 1) {
			// Single pointer: draw or fill
			const { x, y } = canvasPointFromClient(e.clientX, e.clientY);
			if (currentTool === 'fill') {
				const data = { startX: x, startY: y, color: currentColor };
				socket.emit('fill', data);
				floodFill(data);
				socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
			} else {
				isDrawing = true;
				drawingPointerId = e.pointerId;
				const data = { x, y, tool: currentTool, color: currentColor, size: Number(currentSize) };
				handleStartDrawing(data);
				socket.emit('startDrawing', data);
			}
		}
		e.preventDefault();
	}

	function onPointerMove(e) {
		if (!activePointers.has(e.pointerId)) return;
		activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

		if (activePointers.size >= 2 && pinchState) {
			// Update pinch-zoom and pan
			const [p1, p2] = Array.from(activePointers.values());
			const dx = p2.clientX - p1.clientX;
			const dy = p2.clientY - p1.clientY;
			const newDist = Math.hypot(dx, dy);
			const newCenterX = (p1.clientX + p2.clientX) / 2;
			const newCenterY = (p1.clientY + p2.clientY) / 2;

			let newScale = clampScale(pinchState.startScale * (newDist / Math.max(1, pinchState.startDist)));

			// Keep the canvas point under the gesture center stable
			const startCenter = { x: pinchState.centerX, y: pinchState.centerY };
			const canvasPointX = (startCenter.x - pinchState.startOffsetX) / pinchState.startScale;
			const canvasPointY = (startCenter.y - pinchState.startOffsetY) / pinchState.startScale;
			viewScale = newScale;
			viewOffsetX = newCenterX - canvasPointX * newScale;
			viewOffsetY = newCenterY - canvasPointY * newScale;

			render();
			return;
		}

		// Drawing with single pointer
		if (isDrawing && drawingPointerId === e.pointerId) {
			const { x, y } = canvasPointFromClient(e.clientX, e.clientY);
			const data = { x, y };
			handleDraw(data);
			socket.emit('draw', data);
		}
		e.preventDefault();
	}

	function onPointerUp(e) {
		if (drawingPointerId === e.pointerId && isDrawing) {
			isDrawing = false;
			socket.emit('stopDrawing');
			socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
		}
		activePointers.delete(e.pointerId);
		if (activePointers.size < 2) {
			pinchState = null;
		}
		e.preventDefault();
	}

	// Setup local user input event listeners
	window.addEventListener('resize', resizeCanvas);
	displayCanvas.addEventListener('pointerdown', onPointerDown, { passive: false });
	displayCanvas.addEventListener('pointermove', onPointerMove, { passive: false });
	displayCanvas.addEventListener('pointerup', onPointerUp, { passive: false });
	displayCanvas.addEventListener('pointercancel', onPointerUp, { passive: false });

	brushBtn.addEventListener('click', () => switchTool('brush'));
	eraserBtn.addEventListener('click', () => switchTool('eraser'));
	fillBtn.addEventListener('click', () => switchTool('fill'));
	colorPicker.addEventListener('change', (e) => { currentColor = e.target.value; addColorToPalette(e.target.value); });
	colorPicker.addEventListener('input', (e) => currentColor = e.target.value);
	brushSize.addEventListener('input', (e) => currentSize = Number(e.target.value));

	undoBtn.addEventListener('click', () => socket.emit('undo'));
	redoBtn.addEventListener('click', () => socket.emit('redo'));

	clearBtn.addEventListener('click', () => {
		ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
		render();
		socket.emit('clearCanvas');
		socket.emit('saveState', { dataUrl: drawingCanvas.toDataURL() });
	});

	// --- 4. Initial Calls on Page Load ---
	resizeCanvas();
	updatePalette();
	switchTool('brush');
	render();
});