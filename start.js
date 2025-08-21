const { exec } = require('child_process');

const shouldStartServer = process.env.START_SERVER !== '0';
const shouldStartBot = process.env.START_BOT !== '0';

if (shouldStartServer) {
	console.log('--- Starting Main Application Server ---');
	// Start the server process
	const serverProcess = exec('npm start --prefix server');

	// Pipe the server's console output to this script's output
	serverProcess.stdout.pipe(process.stdout);
	serverProcess.stderr.pipe(process.stderr);

	serverProcess.on('exit', (code) => {
		console.log(`Server process exited with code ${code}`);
	});
} else {
	console.log('Skipping server start (START_SERVER=0)');
}

if (shouldStartBot) {
	console.log('--- Starting Telegram Bot ---');
	// Start the bot process
	const botProcess = exec('npm start --prefix bot');

	// Pipe the bot's console output to this script's output
	botProcess.stdout.pipe(process.stdout);
	botProcess.stderr.pipe(process.stderr);

	botProcess.on('exit', (code) => {
		console.log(`Bot process exited with code ${code}`);
	});
} else {
	console.log('Skipping bot start (START_BOT=0)');
}