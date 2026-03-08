#!/usr/bin/env tsx
/**
 * s_full.ts - 完整参考 Agent
 *
 * 集大成实现，整合了 s01-s11 的所有机制。
 * Session s12（任务感知的 worktree 隔离）单独教学。
 * 这不是教学 session —— 这是"集成所有功能"的参考实现。
 *
 *     +------------------------------------------------------------------+
 *     |                        完整 AGENT                                 |
 *     |                                                                   |
 *     |  系统提示词（s05 技能，任务优先 + 可选的 todo 提醒）              |
 *     |                                                                   |
 *     |  每次 LLM 调用前：                                                |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | 微压缩 (s06)       |  | 排空后台 (s08)   |  | 检查收件箱   |  |
 *     |  | 自动压缩 (s06)     |  | 通知             |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  工具调度（s02 模式）：                                           |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  子 agent (s04):  生成 -> 工作 -> 返回摘要                        |
 *     |  队友 (s09):      生成 -> 工作 -> 空闲 -> 自动认领 (s11)         |
 *     |  关闭 (s10):      request_id 握手                                 |
 *     |  计划门控 (s10):  提交 -> 批准/拒绝                               |
 *     +------------------------------------------------------------------+
 *
 *     REPL 命令：/compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 工作目录和客户端初始化
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;

// 目录配置
const TEAM_DIR = path.join(WORKDIR, ".team");           // 团队协作目录
const INBOX_DIR = path.join(TEAM_DIR, "inbox");        // 消息收件箱
const TASKS_DIR = path.join(WORKDIR, ".tasks");        // 任务存储目录
const SKILLS_DIR = path.join(WORKDIR, "skills");       // 技能文件目录
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts"); // 对话记录目录

// 配置常量
const TOKEN_THRESHOLD = 100000;  // Token 阈值：触发压缩的上限
const POLL_INTERVAL = 5;         // 轮询间隔（秒）：检查新消息的频率
const IDLE_TIMEOUT = 60;         // 空闲超时（秒）：自动认领任务前的等待时间

// 有效的消息类型集合（用于团队通信验证）
const VALID_MSG_TYPES = new Set([
  "message",                    // 普通消息
  "broadcast",                  // 广播消息
  "shutdown_request",           // 关闭请求
  "shutdown_response",          // 关闭响应
  "plan_approval_response",     // 计划批准响应
]);

// === 基础工具部分 ===

/**
 * 安全路径检查：防止路径遍历攻击
 * @param p - 相对路径
 * @returns 解析后的绝对路径
 * @throws 如果路径试图逃逸工作目录
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/**
 * 执行 bash 命令
 * @param command - 要执行的 shell 命令
 * @returns 命令输出或错误信息
 */
function runBash(command: string): string {
  // 安全检查：阻止危险命令
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,        // 120秒超时
      maxBuffer: 50000 * 1024, // 50MB 缓冲
    });
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (error: any) {
    if (error.killed) {
      return "Error: Timeout (120s)";
    }
    const out = (error.stdout || "") + (error.stderr || "");
    return out.slice(0, 50000);
  }
}

/**
 * 读取文件内容
 * @param filePath - 文件路径
 * @param limit - 可选：限制读取的行数
 * @returns 文件内容或错误信息
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(filePath), "utf-8");
    let lines = content.split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit);
      lines.push(`... (${content.split("\n").length - limit} more)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 写入文件
 * @param filePath - 文件路径
 * @param content - 要写入的内容
 * @returns 成功消息或错误信息
 */
function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换指定文本
 * @param filePath - 文件路径
 * @param oldText - 要替换的旧文本
 * @param newText - 新文本
 * @returns 成功消息或错误信息
 */
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    let content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    content = content.replace(oldText, newText);
    fs.writeFileSync(fp, content);
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// === Todo 管理部分（s03）===

/**
 * TodoItem 接口：待办事项数据结构
 */
interface TodoItem {
  content: string;      // 待办事项内容
  status: string;       // 状态：pending | in_progress | completed
  activeForm: string;   // 活动形式（描述当前正在做什么）
}

/**
 * TodoManager: 待办事项管理器
 *
 * 管理任务列表，确保：
 * - 最多 20 个待办事项
 * - 同时只能有一个 in_progress 状态的任务
 * - 每个任务必须有 activeForm（描述执行方式）
 */
class TodoManager {
  private items: TodoItem[] = [];

  /**
   * 更新待办事项列表
   * @param items - 新的待办事项数组
   * @returns 渲染后的待办事项列表字符串
   * @throws 如果验证失败（如超过 20 个、多个 in_progress 等）
   */
  update(items: TodoItem[]): string {
    const validated: TodoItem[] = [];
    let inProgress = 0;

    // 验证每个待办事项
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = (item.content || "").trim();
      const status = (item.status || "pending").toLowerCase();
      const activeForm = (item.activeForm || "").trim();

      // 验证必需字段
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);

      if (status === "in_progress") inProgress++;
      validated.push({ content, status, activeForm });
    }

    // 验证约束条件
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgress > 1) throw new Error("Only one in_progress allowed");

    this.items = validated;
    return this.render();
  }

  /**
   * 渲染待办事项列表为可读字符串
   * @returns 格式化的待办事项列表
   */
  render(): string {
    if (this.items.length === 0) return "No todos.";

    const lines: string[] = [];
    for (const item of this.items) {
      // 根据状态选择标记符号
      const marker = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[item.status] || "[?]";
      // 如果是进行中的任务，显示 activeForm
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${marker} ${item.content}${suffix}`);
    }

    // 添加完成进度统计
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  /**
   * 检查是否有未完成的待办事项
   * @returns 是否有未完成的任务
   */
  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// 全局 Todo 管理器实例
const TODO = new TodoManager();
