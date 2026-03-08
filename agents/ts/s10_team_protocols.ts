#!/usr/bin/env tsx
/**
 * s10_team_protocols.ts - 团队协议
 *
 * 关闭协议和计划审批协议，都使用相同的 request_id 关联模式。
 * 基于 s09 的团队消息系统构建。
 *
 *     关闭 FSM: pending -> approved | rejected
 *
 *     Lead                              Teammate
 *     +---------------------+          +---------------------+
 *     | shutdown_request     |          |                     |
 *     | {                    | -------> | 接收请求            |
 *     |   request_id: abc    |          | 决定：批准？        |
 *     | }                    |          |                     |
 *     +---------------------+          +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | shutdown_response    | <------- | shutdown_response   |
 *     | {                    |          | {                   |
 *     |   request_id: abc    |          |   request_id: abc   |
 *     |   approve: true      |          |   approve: true     |
 *     | }                    |          | }                   |
 *     +---------------------+          +---------------------+
 *             |
 *             v
 *     status -> "shutdown", 线程停止
 *
 *     计划审批 FSM: pending -> approved | rejected
 *
 *     Teammate                          Lead
 *     +---------------------+          +---------------------+
 *     | plan_approval        |          |                     |
 *     | submit: {plan:"..."}| -------> | 审查计划文本        |
 *     +---------------------+          | 批准/拒绝？         |
 *                                      +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | plan_approval_resp   | <------- | plan_approval       |
 *     | {approve: true}      |          | review: {req_id,    |
 *     +---------------------+          |   approve: true}     |
 *                                      +---------------------+
 *
 *     跟踪器: {request_id: {"target|from": name, "status": "pending|..."}}
 *
 * 关键洞察："相同的 request_id 关联模式，两个领域。"
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

// 系统提示词：定义 lead 的角色和协议能力
const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;

// 有效的消息类型集合
const VALID_MSG_TYPES = new Set([
  "message",                  // 普通消息
  "broadcast",                // 广播消息
  "shutdown_request",         // 关闭请求
  "shutdown_response",        // 关闭响应
  "plan_approval_response",   // 计划审批响应
]);

// -- 请求跟踪器：通过 request_id 关联请求和响应 --

/**
 * 关闭请求接口：跟踪关闭请求的状态
 */
interface ShutdownRequest {
  target: string;                                // 目标队友名称
  status: "pending" | "approved" | "rejected";   // 请求状态
}

/**
 * 计划请求接口：跟踪计划审批请求的状态
 */
interface PlanRequest {
  from: string;                                  // 提交者名称
  plan: string;                                  // 计划内容
  status: "pending" | "approved" | "rejected";   // 审批状态
}

// 全局请求跟踪器：使用 Map 存储请求状态
const shutdownRequests = new Map<string, ShutdownRequest>();  // 关闭请求映射
const planRequests = new Map<string, PlanRequest>();          // 计划请求映射

// -- 类型定义 --

/**
 * 消息接口：JSONL 收件箱中的消息格式
 */
interface Message {
  type: string;        // 消息类型
  from: string;        // 发送者名称
  content: string;     // 消息内容
  timestamp: number;   // 时间戳（秒）
  [key: string]: any;  // 额外字段（如 request_id）
}

/**
 * 团队成员接口：描述一个队友的状态
 */
interface TeamMember {
  name: string;                                // 成员名称
  role: string;                                // 角色
  status: "idle" | "working" | "shutdown";     // 状态
}

/**
 * 团队配置接口：存储在 .team/config.json 中
 */
interface TeamConfig {
  team_name: string;      // 团队名称
  members: TeamMember[];  // 成员列表
}

/**
 * 消息总线：基于 JSONL 文件的异步消息系统
 * 与 s09 相同，支持多种消息类型
 */
class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * 发送消息到指定队友的收件箱
   * @param sender - 发送者名称
   * @param to - 接收者名称
   * @param content - 消息内容
   * @param msgType - 消息类型
   * @param extra - 额外字段（如 request_id, approve）
   */
  send(sender: string, to: string, content: string, msgType: string = "message", extra?: any): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(", ")}`;
    }
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  /**
   * 读取并清空收件箱
   */
  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    const messages: Message[] = [];
    const lines = fs.readFileSync(inboxPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  /**
   * 广播消息给所有队友
   */
  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

/**
 * 队友管理器：支持关闭和计划审批协议
 *
 * 新增功能（相比 s09）：
 * - 处理 shutdown_request 消息
 * - 处理 shutdown_response 工具调用
 * - 处理 plan_approval 工具调用
 */
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, Promise<void>> = new Map();

  constructor(teamDir: string) {
    this.dir = teamDir;
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.configPath = path.join(this.dir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  /**
   * 生成队友
   */
  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    const thread = this.teammateLoop(name, role, prompt);
    this.threads.set(name, thread);

    return `Spawned '${name}' (role: ${role})`;
  }

  /**
   * 队友的 agent 循环
   *
   * 新增行为：
   * - 提示队友在重大工作前提交计划
   * - 响应 shutdown_request
   */
  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt =
      `You are '${name}', role: ${role}, at ${WORKDIR}. ` +
      `Submit plans via plan_approval before major work. ` +
      `Respond to shutdown_request with shutdown_response.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();
    let shouldExit = false;  // 关闭标志

    for (let i = 0; i < 50; i++) {
      // 检查收件箱
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      // 如果收到关闭批准，退出循环
      if (shouldExit) {
        break;
      }

      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages,
          tools,
          max_tokens: 8000,
        });
      } catch {
        break;
      }

      messages.push({
        role: "assistant",
        content: response.content,
      });

      if (response.stop_reason !== "tool_use") {
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = this.exec(name, block.name, block.input as Record<string, any>);
          console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
          // 检查是否批准了关闭请求
          if (block.name === "shutdown_response" && (block.input as any).approve) {
            shouldExit = true;
          }
        }
      }
      messages.push({
        role: "user",
        content: results,
      });
    }

    // 更新最终状态
    const member = this.findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      this.saveConfig();
    }
  }

  /**
   * 执行队友的工具调用
   *
   * 新增工具：
   * - shutdown_response: 响应关闭请求
   * - plan_approval: 提交计划审批
   */
  private exec(sender: string, toolName: string, args: any): string {
    // 基础工具（与 s02 相同）
    if (toolName === "bash") {
      return runBash(args.command);
    }
    if (toolName === "read_file") {
      return runRead(args.path);
    }
    if (toolName === "write_file") {
      return runWrite(args.path, args.content);
    }
    if (toolName === "edit_file") {
      return runEdit(args.path, args.old_text, args.new_text);
    }
    if (toolName === "send_message") {
      return BUS.send(sender, args.to, args.content, args.msg_type || "message");
    }
    if (toolName === "read_inbox") {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    // 协议工具：关闭响应
    if (toolName === "shutdown_response") {
      const reqId = args.request_id;
      const approve = args.approve;
      const req = shutdownRequests.get(reqId);
      if (req) {
        req.status = approve ? "approved" : "rejected";
      }
      // 发送响应给 lead
      BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
        request_id: reqId,
        approve,
      });
      return `Shutdown ${approve ? "approved" : "rejected"}`;
    }
    // 协议工具：计划审批
    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = randomUUID().slice(0, 8);  // 生成短 UUID
      planRequests.set(reqId, {
        from: sender,
        plan: planText,
        status: "pending",
      });
      // 发送计划给 lead 审批
      BUS.send(sender, "lead", planText, "plan_approval_response", {
        request_id: reqId,
        plan: planText,
      });
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
    return `Unknown tool: ${toolName}`;
  }

  /**
   * 队友可用的工具列表
   *
   * 新增工具：
   * - shutdown_response: 响应关闭请求
   * - plan_approval: 提交计划审批
   */
  private teammateTools(): Anthropic.Tool[] {
    // 基础工具定义（与 s02 相同）
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request. Approve to shut down, reject to keep working.",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval. Provide plan text.",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
    ];
  }

  listAll(): string {
    if (this.config.members.length === 0) {
      return "No teammates.";
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// -- 基础工具实现（与 s02 相同）--

/**
 * 安全路径检查：防止路径遍历攻击
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
      maxBuffer: 50000 * 1024,
    });
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (error: any) {
    return "Error: Timeout (120s)";
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const fullPath = safePath(filePath);
    const text = fs.readFileSync(fullPath, "utf-8");
    const lines = text.split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more)`].join("\n").slice(0, 50000);
    }
    return text.slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fullPath, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// -- Lead 专用协议处理函数 --

/**
 * 处理关闭请求：向队友发送关闭请求
 * @param teammate - 目标队友名称
 * @returns 请求状态消息
 */
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);  // 生成短 UUID
  // 创建关闭请求跟踪记录
  shutdownRequests.set(reqId, {
    target: teammate,
    status: "pending",
  });
  // 发送关闭请求消息
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
    request_id: reqId,
  });
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

/**
 * 处理计划审批：批准或拒绝队友提交的计划
 * @param requestId - 计划请求 ID
 * @param approve - 是否批准
 * @param feedback - 可选：反馈意见
 * @returns 审批结果消息
 */
function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests.get(requestId);
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  // 更新请求状态
  req.status = approve ? "approved" : "rejected";
  // 发送审批响应给队友
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

/**
 * 检查关闭请求状态
 * @param requestId - 请求 ID
 * @returns 请求状态的 JSON 字符串
 */
function checkShutdownStatus(requestId: string): string {
  const req = shutdownRequests.get(requestId);
  if (!req) {
    return JSON.stringify({ error: "not found" });
  }
  return JSON.stringify(req);
}

// -- Lead 工具调度映射（12 个工具）--
type ToolHandler = (input: any) => string;

/**
 * Lead 工具处理函数映射表
 *
 * 新增工具（相比 s09）：
 * - shutdown_request: 请求队友关闭
 * - shutdown_response: 检查关闭请求状态
 * - plan_approval: 审批队友的计划
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  spawn_teammate: (input) => TEAM.spawn(input.name, input.role, input.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (input) => BUS.send("lead", input.to, input.content, input.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (input) => BUS.broadcast("lead", input.content, TEAM.memberNames()),
  shutdown_request: (input) => handleShutdownRequest(input.teammate),        // 发起关闭请求
  shutdown_response: (input) => checkShutdownStatus(input.request_id || ""), // 检查关闭状态
  plan_approval: (input) => handlePlanReview(input.request_id, input.approve, input.feedback || ""), // 审批计划
};

// Lead 工具定义数组（基础工具与 s02 相同）
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent teammate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "Check the status of a shutdown request by request_id.",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
];

/**
 * Lead 的 agent 循环：与 s09 相同
 * 每次循环前检查收件箱，处理队友的响应
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 检查收件箱：可能有关闭响应或计划审批请求
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({
      role: "user",
      content: results,
    });
  }
}

/**
 * 主函数：交互式命令行界面
 *
 * 支持的特殊命令：
 * - /team: 列出所有队友
 * - /inbox: 查看 lead 的收件箱
 * - q/exit: 退出程序
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt("\x1b[36ms10 >> \x1b[0m");
      if (!query || ["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        continue;
      }
      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        continue;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);

      const lastMessage = history[history.length - 1];
      if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === "text") {
            console.log(block.text);
          }
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof Error && error.message.includes("EOF")) {
        break;
      }
      throw error;
    }
  }

  rl.close();
}

// 仅当直接运行此文件时执行
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
