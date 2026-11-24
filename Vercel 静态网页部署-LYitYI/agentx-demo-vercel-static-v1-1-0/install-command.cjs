const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, 'server.cjs'), 'utf8');
process.stdout.write(JSON.stringify({
  mcpServers: { 'vercel-static-deploy': { command: 'node', args: ['-e', source] } },
}, null, 2) + '\n');
