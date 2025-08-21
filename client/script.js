window.addEventListener('load', () => {
    // Change this line in client/script.js
const socket = io('https://our-drawing-app-server.onrender.com');

    // --- NEW: Modal and User List Elements ---
    const signatureModal = document.getElementById('signature-modal');
    const signatureCanvas = document.getElementById('signature-canvas');
    const sigCtx = signatureCanvas.getContext('2d');
    const confirmBtn = document.getElementById('confirm-signature');
    const userListDiv = document.getElementById('user-list');

    // --- Main Canvas & Toolbar Elements ---
    const canvas = document.getElementById('drawing-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
    let currentSize = brushSize.value;
    let lastX = 0;
    let lastY = 0;
    let recentColors = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', null, null, null, null, null];

    // Functions for Main App
    function resizeCanvas() {
        canvas.width = window.innerWidth - document.getElementById('toolbar').offsetWidth;
        // Adjust height to account for the new user list div
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
             canvas.height = mainContent.offsetHeight;
        } else {
             canvas.height = window.innerHeight;
        }

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        socket.emit('requestCanvasState'); // Ask server for the latest drawing to redraw after resize
    }
    
    function startDrawing(e) {
        if (currentTool === 'fill') {
            const data = { startX: e.offsetX, startY: e.offsetY, color: currentColor };
            socket.emit('fill', data); 
            floodFill(data); 
            socket.emit('saveState', { dataUrl: canvas.toDataURL() }); 
            return;
        }
        isDrawing = true;
        const data = { x: e.offsetX, y: e.offsetY, tool: currentTool, color: currentColor, size: currentSize };
        handleStartDrawing(data);
        socket.emit('startDrawing', data);
    }
    
    function draw(e) {
        if (!isDrawing) return;
        const data = { x: e.offsetX, y: e.offsetY };
        handleDraw(data);
        socket.emit('draw', data);
    }
    
    function stopDrawing() {
        if (isDrawing) {
            isDrawing = false;
            socket.emit('stopDrawing');
            socket.emit('saveState', { dataUrl: canvas.toDataURL() });
        }
    }

    function handleStartDrawing(data) {
        ctx.globalCompositeOperation = data.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.beginPath();
        ctx.lineWidth = data.size;
        ctx.strokeStyle = data.color;
        [lastX, lastY] = [data.x, data.y];
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(lastX, lastY);
        ctx.stroke();
    }

    function handleDraw(data) {
        const midX = (lastX + data.x) / 2;
        const midY = (lastY + data.y) / 2;
        ctx.quadraticCurveTo(lastX, lastY, midX, midY);
        ctx.stroke();
        [lastX, lastY] = [data.x, data.y];
    }
    
    function handleStopDrawing() {
        ctx.beginPath();
    }
    
    function switchTool(tool) {
        currentTool = tool;
        document.querySelectorAll('.tool').forEach(t => t.classList.remove('active'));
        document.getElementById(`${tool}Btn`).classList.add('active');
        canvas.style.cursor = tool === 'fill' ? 'pointer' : 'crosshair';
    }

    function floodFill({ startX, startY, color }) {
        const tolerance = 32;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const startIdx = (startY * canvas.width + startX) * 4;
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
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        const maskData = tempCtx.createImageData(canvas.width, canvas.height);
        const visited = new Set();
        const queue = [[startX, startY]];
        visited.add(`${startX},${startY}`);
        while (queue.length > 0) {
            const [x, y] = queue.shift();
            const idx = (y * canvas.width + x) * 4;
            maskData.data[idx + 3] = 255;
            const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
            for (const [nx, ny] of neighbors) {
                const key = `${nx},${ny}`;
                if (nx >= 0 && nx < canvas.width && ny >= 0 && ny < canvas.height && !visited.has(key)) {
                    visited.add(key);
                    if (colorsMatch((ny * canvas.width + nx) * 4)) queue.push([nx, ny]);
                }
            }
        }
        tempCtx.putImageData(maskData, 0, 0);
        tempCtx.globalCompositeOperation = 'source-in';
        tempCtx.fillStyle = color;
        tempCtx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tempCanvas, 0, 0);
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
    socket.on('startDrawing', handleStartDrawing);
    socket.on('draw', handleDraw);
    socket.on('stopDrawing', handleStopDrawing);
    socket.on('fill', (data) => floodFill(data));
    socket.on('clearCanvas', () => ctx.clearRect(0, 0, canvas.width, canvas.height));
    
    // Listen for history and user list updates from the server
    socket.on('loadCanvas', ({ dataUrl }) => {
        const img = new Image();
        img.src = dataUrl;
        img.onload = () => {
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
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

    // Setup local user input event listeners
    window.addEventListener('resize', resizeCanvas);
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseleave', stopDrawing);
    brushBtn.addEventListener('click', () => switchTool('brush'));
    eraserBtn.addEventListener('click', () => switchTool('eraser'));
    fillBtn.addEventListener('click', () => switchTool('fill'));
    colorPicker.addEventListener('change', (e) => { currentColor = e.target.value; addColorToPalette(e.target.value); });
    colorPicker.addEventListener('input', (e) => currentColor = e.target.value);
    brushSize.addEventListener('input', (e) => currentSize = e.target.value);
    
    undoBtn.addEventListener('click', () => socket.emit('undo'));
    redoBtn.addEventListener('click', () => socket.emit('redo'));
    
    clearBtn.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        socket.emit('clearCanvas');
        socket.emit('saveState', { dataUrl: canvas.toDataURL() });
    });

    // --- 4. Initial Calls on Page Load ---
    resizeCanvas();
    updatePalette();
    switchTool('brush');
});