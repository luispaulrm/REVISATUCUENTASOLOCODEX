import net from 'net';
import process from 'process';

const port = parseInt(process.argv[2] || '5000', 10);
const host = process.argv[3] || '127.0.0.1';
const timeout = 300000; // 300 seconds (5 minutes)
const start = Date.now();

function checkPort() {
    const socket = new net.Socket();
    socket.setTimeout(2000);

    socket.on('connect', () => {
        console.log(`\n✅ Port ${port} is ready! Starting frontend...`);
        socket.destroy();
        process.exit(0);
    });

    socket.on('timeout', () => {
        socket.destroy();
        retry();
    });

    socket.on('error', (err) => {
        socket.destroy();
        retry();
    });

    socket.connect(port, host);
}

function retry() {
    if (Date.now() - start > timeout) {
        console.error(`\n❌ Timeout waiting for port ${port}`);
        process.exit(1);
    }
    // Use process.stdout.write if available, otherwise console.log with replacement?
    // ESM usually has process.stdout.
    process.stdout.write('.');
    setTimeout(checkPort, 1000);
}

console.log(`⏳ Waiting for backend on port ${port}...`);
checkPort();
