#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

config();

// ── Types ───────────────────────────────────────────────────────────────────

interface SurgeConfig {
  email: string;
  password: string;
  isLoggedIn: boolean;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function execPromise(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

function spawnPromise(
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, ...options });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(`Exit ${code}: ${err || out}`));
      }
    });
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const platform = os.platform();
    await execPromise(`${platform === 'win32' ? 'where' : 'which'} ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

function generateRandomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ── Netrc helpers ───────────────────────────────────────────────────────────

const NETRC_PATH = path.join(os.homedir(), '.netrc');

function writeNetrc(email: string, password: string): void {
  const content = `machine surge.sh\n  login ${email}\n  password ${password}\n`;
  fs.writeFileSync(NETRC_PATH, content, { mode: 0o600 });
  console.error('[Auth] .netrc written');
}

function clearNetrc(): void {
  try {
    if (fs.existsSync(NETRC_PATH)) {
      fs.unlinkSync(NETRC_PATH);
      console.error('[Auth] .netrc removed');
    }
  } catch {
    // ignore
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

class SurgeServer {
  private server: Server;
  private config: SurgeConfig | null = null;
  private netrcWritten = false;

  constructor() {
    this.server = new Server(
      { name: 'surge-server', version: '0.2.0' },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    if (this.netrcWritten) clearNetrc();
    await this.server.close();
  }

  private ensureLoggedIn(): SurgeConfig {
    if (!this.config?.isLoggedIn) {
      throw new McpError(ErrorCode.InvalidRequest, 'Not logged in. Call surge_login first.');
    }
    return this.config;
  }

  // ── Handler registration ────────────────────────────────────────────────

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'surge_login',
          description: 'Login to surge.sh. Credentials are persisted to ~/.netrc for subsequent calls.',
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'Surge account email' },
              password: { type: 'string', description: 'Surge account password' },
            },
            required: ['email', 'password'],
          },
        },
        {
          name: 'surge_deploy',
          description: 'Deploy a static site directory to surge.sh. Specify a custom domain or get a random one.',
          inputSchema: {
            type: 'object',
            properties: {
              directory: { type: 'string', description: 'Path to the directory to deploy' },
              domain: {
                type: 'string',
                description: 'Custom surge.sh subdomain (e.g., my-site.surge.sh). Random if omitted.',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'surge_teardown',
          description: 'Remove a deployed surge.sh site by its domain.',
          inputSchema: {
            type: 'object',
            properties: {
              domain: { type: 'string', description: 'The surge.sh domain to tear down (e.g., my-site.surge.sh)' },
            },
            required: ['domain'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`[Tool] ${name}`, JSON.stringify(args));

      switch (name) {
        case 'surge_login':
          return await this.handleLogin(args ?? {});
        case 'surge_deploy':
          return await this.handleDeploy(args ?? {});
        case 'surge_teardown':
          return await this.handleTeardown(args ?? {});
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    });
  }

  // ── Login ────────────────────────────────────────────────────────────────

  private async handleLogin(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const email = (args.email as string) || process.env.SURGE_EMAIL || '';
    const password = (args.password as string) || process.env.SURGE_PASSWORD || '';

    if (!email || !password) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing credentials. Provide email/password or set SURGE_EMAIL/SURGE_PASSWORD env vars.');
    }

    try {
      writeNetrc(email, password);
      this.netrcWritten = true;

      const { stdout } = await execPromise('surge whoami');
      console.error(`[Login] whoami: ${stdout.trim()}`);

      if (stdout.includes(email)) {
        this.config = { email, password, isLoggedIn: true };
        return {
          content: [{ type: 'text', text: `Logged in as ${email}` }],
        };
      }

      throw new Error(`Login verification failed. whoami returned: ${stdout.trim()}`);
    } catch (error) {
      clearNetrc();
      this.netrcWritten = false;
      throw new McpError(ErrorCode.InternalError, `Login failed: ${getErrorMessage(error)}`);
    }
  }

  // ── Deploy ───────────────────────────────────────────────────────────────

  private async handleDeploy(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.ensureLoggedIn();

    const directory = args.directory as string;
    if (!directory) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: directory');
    }

    if (!fs.existsSync(directory)) {
      throw new McpError(ErrorCode.InvalidParams, `Directory not found: ${directory}`);
    }
    if (!fs.statSync(directory).isDirectory()) {
      throw new McpError(ErrorCode.InvalidParams, `Not a directory: ${directory}`);
    }

    const domain = (args.domain as string) || `${generateRandomString(10)}.surge.sh`;
    console.error(`[Deploy] directory: ${directory}, domain: ${domain}`);

    try {
      const { stdout, stderr } = await spawnPromise('surge', [
        '--project', directory,
        '--domain', domain,
      ]);

      console.error(`[Deploy] stdout: ${stdout.trim()}`);
      if (stderr) console.error(`[Deploy] stderr: ${stderr.trim()}`);

      return {
        content: [{ type: 'text', text: `Deployed to https://${domain}` }],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Deploy failed: ${getErrorMessage(error)}`);
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  private async handleTeardown(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.ensureLoggedIn();

    const domain = args.domain as string;
    if (!domain) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter: domain');
    }

    try {
      const { stdout } = await execPromise(`surge teardown ${domain}`);
      console.error(`[Teardown] ${stdout.trim()}`);

      return {
        content: [{ type: 'text', text: `Torn down: ${domain}` }],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Teardown failed: ${getErrorMessage(error)}`);
    }
  }

  // ── Start ────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    console.error('[Server] Surge MCP server starting');
    await this.server.connect(transport);
    console.error('[Server] Surge MCP server running on stdio');
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function checkDependencies(): Promise<void> {
  console.error('[Dep] Checking surge CLI...');
  if (!(await commandExists('surge'))) {
    console.error('[Dep] Installing surge...');
    try {
      await spawnPromise('npm', ['install', '-g', 'surge']);
      console.error('[Dep] surge installed');
    } catch (error) {
      console.error(`[Dep] Failed to install surge: ${getErrorMessage(error)}`);
      console.error('[Dep] Please install manually: npm install -g surge');
    }
  } else {
    console.error('[Dep] surge CLI found');
  }
}

const server = new SurgeServer();

checkDependencies()
  .then(() => server.run())
  .catch((error) => {
    console.error(`[Fatal] ${getErrorMessage(error)}`);
    process.exit(1);
  });
