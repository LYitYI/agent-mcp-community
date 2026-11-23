const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, 'server.cjs'), 'utf8');
const config = {
  mcpServers: {
    'starbridge-camp-refund': {
      command: 'node',
      args: ['-e', source],
    },
  },
};

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
