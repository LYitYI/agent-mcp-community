const readline = require('node:readline');

const tool = {
  name: 'calculate_camp_refund',
  description: '按已确认的政策比例计算星桥营地退款。金额统一使用人民币分，比例为 0 到 100 的整数。调用前从知识库确认适用的退款比例。',
  inputSchema: {
    type: 'object',
    properties: {
      amount_cents: { type: 'integer', minimum: 1, maximum: 100000000, description: '实际支付金额，单位为人民币分' },
      refund_percent: { type: 'integer', minimum: 0, maximum: 100, description: '知识库确认的退款百分比，例如 65 表示 65%' },
    },
    required: ['amount_cents', 'refund_percent'],
    additionalProperties: false,
  },
};

function calculateRefund(args = {}) {
  const { amount_cents: amount, refund_percent: percent } = args;
  if (!Number.isInteger(amount) || amount < 1 || amount > 100_000_000) {
    return { isError: true, content: [{ type: 'text', text: 'amount_cents 必须是 1 到 100000000 之间的整数。' }] };
  }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    return { isError: true, content: [{ type: 'text', text: 'refund_percent 必须是 0 到 100 之间的整数。' }] };
  }

  const refund = Math.floor((amount * percent + 50) / 100);
  const result = { currency: 'CNY', amount_cents: amount, refund_percent: percent, refund_cents: refund, retained_cents: amount - refund };
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
}

function handle(request) {
  if (!Object.hasOwn(request, 'id')) return;
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      return reply(id, { result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'starbridge-camp-refund', version: '1.0.0' },
      } });
    case 'ping':
      return reply(id, { result: {} });
    case 'tools/list':
      return reply(id, { result: { tools: [tool] } });
    case 'tools/call':
      if (params?.name !== tool.name) {
        return reply(id, { error: { code: -32602, message: 'Unknown tool name' } });
      }
      return reply(id, { result: calculateRefund(params.arguments ?? {}) });
    default:
      return reply(id, { error: { code: -32601, message: 'Method not found' } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply(null, { error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request === null || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    reply(request?.id ?? null, { error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  handle(request);
});
