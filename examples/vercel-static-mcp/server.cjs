const readline = require('node:readline');
const { setTimeout: wait } = require('node:timers/promises');

const serverName = 'vercel-static-deploy';
const version = '1.1.0';
const projectPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const deploymentPattern = /^dpl_[a-zA-Z0-9]+$/;
const teamPattern = /^team_[a-zA-Z0-9]+$/;
const staticPathPattern = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:html|css|js|mjs|json|txt|svg)$/;
const credentials = {
  access_token: {
    type: 'string',
    description: 'Vercel Access Token，在 AgentX 工作室的参数预设中填写。请勿在对话中索取或显示。',
  },
  team_id: {
    type: 'string',
    description: '可选。Vercel 团队 ID（team_ 开头），与令牌的作用域一致。',
  },
};
const tools = [
  {
    name: 'vercel_deploy_static',
    description: '根据用户的网页需求生成静态前端，再调用此工具发布到预设 Vercel 项目的生产环境。工具接收助理生成的 HTML 和静态资源，返回 Vercel 的部署 ID、状态和网址。',
    inputSchema: {
      type: 'object',
      properties: {
        ...credentials,
        project_name: {
          type: 'string',
          description: '专用于这次部署的 Vercel 项目名。建议在参数预设中填写。',
        },
        html: { type: 'string', description: '由助理根据用户需求生成的完整 index.html。简单页面可内联 CSS。' },
        assets: {
          type: 'array',
          description: '由助理生成且 HTML 引用的可选 UTF-8 静态资源，例如 styles.css 或 scripts/main.js。',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件相对路径。' },
              content: { type: 'string', description: '文件内容。' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['access_token', 'project_name', 'html'],
    },
  },
  {
    name: 'vercel_deployment_status',
    description: '用发布工具返回的部署 ID 查询同一次 Vercel 部署的状态和网址。',
    inputSchema: {
      type: 'object',
      properties: {
        ...credentials,
        deployment_id: { type: 'string', description: '发布工具结果中的 deployment_id，以 dpl_ 开头。' },
      },
      required: ['access_token', 'deployment_id'],
    },
  },
];

class ToolError extends Error {}

function vercelCredentials(args) {
  const token = typeof args.access_token === 'string' ? args.access_token.trim() : '';
  if (!/^[\x21-\x7e]{1,512}$/.test(token)) {
    throw new ToolError('请在 AgentX 工作室打开工具的「参数预设」，填写有效的 Vercel Access Token。');
  }
  const teamId = args.team_id ?? '';
  if (teamId !== '' && (typeof teamId !== 'string' || !teamPattern.test(teamId))) {
    throw new ToolError('team_id 必须是 team_ 开头的 Vercel 团队 ID。');
  }
  return { token, teamId };
}

function projectFiles(html, assets = []) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new ToolError('请输入非空的 index.html 源码。');
  }
  if (!Array.isArray(assets) || assets.length > 15) {
    throw new ToolError('最多可附带 15 个静态文件。');
  }
  const files = [{ file: 'public/index.html', data: html, encoding: 'utf-8' }];
  const paths = new Set(['index.html']);
  let size = Buffer.byteLength(html);
  for (const asset of assets) {
    const { path, content } = asset ?? {};
    if (typeof path !== 'string' || path.length > 160 || !staticPathPattern.test(path)
      || path.split('/')[0] === 'api' || typeof content !== 'string') {
      throw new ToolError('资源需为 UTF-8 静态文件，路径可包含目录，扩展名支持 html、css、js、mjs、json、txt、svg。');
    }
    const normalized = path.toLowerCase();
    if (paths.has(normalized)) {
      throw new ToolError('静态文件路径重复，index.html 由 html 参数提供。');
    }
    paths.add(normalized);
    size += Buffer.byteLength(content);
    files.push({ file: 'public/' + path, data: content, encoding: 'utf-8' });
  }
  if (size > 256 * 1024) {
    throw new ToolError('演示工具的网页和资源总大小不能超过 256 KiB。');
  }
  return files;
}

async function vercelRequest(path, { token, teamId }, body) {
  const url = new URL(path, 'https://api.vercel.com');
  if (teamId) url.searchParams.set('teamId', teamId);
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ToolError(body ? 'Vercel 请求未确认，先在控制台核对有无新部署，再决定是否重试。' : '连接 Vercel 超时或失败，请稍后查询。');
  }
  if (!response.ok) {
    const hint = {
      400: '请检查项目及团队设置。',
      401: '请检查 Access Token 是否有效。',
      403: '请确认令牌对该团队或项目具有部署权限。',
      404: '请检查部署 ID 和团队 ID。',
      429: '请求受到限流，请稍后再试。',
    }[response.status] ?? '请在 Vercel 控制台检查项目。';
    throw new ToolError('Vercel API 返回 HTTP ' + response.status + '。' + hint);
  }
  return response.json();
}

function summarizeDeployment(deployment) {
  if (!deploymentPattern.test(deployment.id ?? '')) throw new ToolError('Vercel 返回的部署 ID 无效。');
  // Report the production alias only after Vercel has assigned it.
  const alias = deployment.aliasAssigned ? deployment.alias?.find(name => /\.vercel\.app$/.test(name)) : undefined;
  const host = alias ?? deployment.url;
  const url = typeof host === 'string' && /^[a-z0-9][a-z0-9.-]*\.vercel\.app$/i.test(host)
    ? 'https://' + host : null;
  return {
    deployment_id: deployment.id,
    state: deployment.readyState ?? 'UNKNOWN',
    url,
  };
}

async function deployStatic(args) {
  const auth = vercelCredentials(args);
  const project = args.project_name;
  if (typeof project !== 'string' || !projectPattern.test(project)) {
    throw new ToolError('project_name 需为 1 到 64 个小写字母、数字或连字符，首尾为字母或数字。');
  }
  const files = projectFiles(args.html, args.assets);
  const initial = await vercelRequest('/v13/deployments', auth, {
    name: project,
    target: 'production',
    files,
    projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: 'public' },
  });
  let result = summarizeDeployment(initial);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && ['QUEUED', 'INITIALIZING', 'BUILDING'].includes(result.state)) {
    await wait(2_000);
    try {
      result = summarizeDeployment(await vercelRequest('/v13/deployments/' + result.deployment_id, auth));
    } catch {
      // The submission succeeded. Keep its ID available for a later status check.
      break;
    }
  }
  return result;
}

async function deploymentStatus(args) {
  const auth = vercelCredentials(args);
  if (typeof args.deployment_id !== 'string' || !deploymentPattern.test(args.deployment_id)) {
    throw new ToolError('请输入以 dpl_ 开头的部署 ID。');
  }
  return summarizeDeployment(await vercelRequest('/v13/deployments/' + args.deployment_id, auth));
}

const handlers = new Map([
  ['vercel_deploy_static', deployStatic],
  ['vercel_deployment_status', deploymentStatus],
]);

function reply(id, body) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
}

async function handle(request) {
  if (request === null || typeof request !== 'object' || request.jsonrpc !== '2.0'
    || typeof request.method !== 'string') {
    return reply(request?.id ?? null, { error: { code: -32600, message: 'Invalid request' } });
  }
  if (!Object.hasOwn(request, 'id')) return;
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      return reply(id, { result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version },
      } });
    case 'ping':
      return reply(id, { result: {} });
    case 'tools/list':
      return reply(id, { result: { tools } });
    case 'tools/call': {
      const call = handlers.get(params?.name);
      if (!call) return reply(id, { error: { code: -32602, message: 'Unknown tool name' } });
      try {
        const result = await call(params.arguments ?? {});
        return reply(id, { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } catch (error) {
        const text = error instanceof ToolError ? error.message : 'Vercel 返回异常，请在控制台核对部署。';
        return reply(id, { result: { isError: true, content: [{ type: 'text', text }] } });
      }
    }
    default:
      return reply(id, { error: { code: -32601, message: 'Method not found' } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return reply(null, { error: { code: -32700, message: 'Parse error' } });
  }
  void handle(request);
});
