const { exec } = require('child_process');

console.log('--- Starting Main Application Server ---');
// Start the server process
const serverProcess = exec('npm start --prefix server');

// Pipe the server's console output to this script's output
serverProcess.stdout.pipe(process.stdout);
serverProcess.stderr.pipe(process.stderr);

serverProcess.on('exit', (code) => {
  console.log(`Server process exited with code ${code}`);
});


console.log('--- Starting Telegram Bot ---');
// Start the bot process
const botProcess = exec('npm start --prefix bot');

// Pipe the bot's console output to this script's output
botProcess.stdout.pipe(process.stdout);
botProcess.stderr.pipe(process.stderr);

botProcess.on('exit', (code) => {
  console.log(`Bot process exited with code ${code}`);
});