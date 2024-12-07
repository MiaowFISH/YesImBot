import { Context, createMatch, Session } from "koishi";
import { defineAccessor } from "@satorijs/core";

import { Config } from "../config";
import { QueueManager } from "../managers/queueManager";
import { ChatMessage, createMessage } from "../models/ChatMessage";
import { foldText } from "../utils/string";
import { isChannelAllowed, ProcessingLock } from "../utils/toolkit";

export enum MarkType {
  Command = "指令消息",
  LogicRedirect = "逻辑重定向",
  LLM = "和LLM交互的消息",
  Added = "已被添加",
  Unknown = "未标记"
}

export interface SendQueue {
  getQueue(channelId: string): Promise<ChatMessage[]>;
  clearBySenderId(senderId: string): Promise<boolean>;
  clearChannel(channelId: string): Promise<boolean>;
  clearAll(): Promise<boolean>;
  clearPrivateAll(): Promise<boolean>;
}
export class SendQueue {
  private slotContains: Set<string>[] = [];
  private slotSize: number;
  private queueManager: QueueManager;
  private triggerCount: Map<string, number> = new Map();
  private mark = new Map<string, MarkType>();
  readonly processingLock = new ProcessingLock();

  constructor(private ctx: Context, private config: Config) {
    for (let slotContain of config.MemorySlot.SlotContains) {
      this.slotContains.push(
        new Set(slotContain.split(",").map((slot) => slot.trim()))
      );
    }
    this.slotSize = config.MemorySlot.SlotSize;
    this.queueManager = new QueueManager(ctx);
  }
  async checkQueueSize(channelId: string): Promise<boolean> {
    return (
      (await this.queueManager.getQueue(channelId, this.slotSize)).length >
      this.slotSize
    );
  }

  async checkMixedQueueSize(channelId: string): Promise<boolean> {
    for (let slotContain of this.slotContains) {
      if (slotContain.has(channelId)) {
        return (
          (await this.queueManager.getMixedQueue(slotContain, this.slotSize))
            .length > this.slotSize
        );
      }
    }
    return false;
  }

  async getMixedQueue(channelId: string): Promise<ChatMessage[]> {
    await this.processingLock.waitForProcess(channelId);
    for (let slotContain of this.slotContains) {
      if (slotContain.has(channelId)) {
        return await this.queueManager.getMixedQueue(
          slotContain,
          this.slotSize
        );
      }
    }
    return [];
  }

  // 向数据库中添加一条消息
  // TODO: 删除过期消息并进行总结
  // TODO: 防提示词注入
  async addMessage(message: ChatMessage) {
    if (!isChannelAllowed(this.config.MemorySlot.SlotContains, message.channelId)) return;
    const markType = this.getMark(message.messageId) || MarkType.Unknown;
    //@ts-ignore
    if (markType === MarkType.Unknown || this.config.Settings.SelfReport.includes(markType)) {
      // 调用 Bot 指令的消息不知道怎么清除
      if (message.content.includes("清除记忆")) return;
      this.setMark(message.messageId, MarkType.Added);
      await this.queueManager.enqueue(message);
      logger.info(`New message received, guildId = ${message.channelId}, content = ${foldText(message.content, 1000)}`);
    }
    this.processingLock.end(message.channelId);
  }

  getMark(messageId: string): MarkType {
    return this.mark.get(messageId);
  }

  setMark(messageId: string, mark: MarkType) {
    this.mark.set(messageId, mark);
  }

  setTriggerCount(channelId: string, nextTriggerCount: number) {
    this.triggerCount.set(channelId, nextTriggerCount);
    console.log(`距离下次回复还剩 ${nextTriggerCount} 次`)
  }

  // 如果没有触发，将触发次数-1
  // 关于 triggerCount 的含义:
  // prompt 中有写到 `那么你可能会想要把这个值设为1，表示再收到一条消息你就会立马发言一次。`
  // 所以为 1 时就应该返回 true，而这个值不应该是 0
  checkTriggerCount(channelId: string): boolean {
    let triggerCount =
      this.triggerCount.get(channelId) ??
      this.config.MemorySlot.FirstTriggerCount;
    if (triggerCount > 1) {
      this.triggerCount.set(channelId, --triggerCount);
      logger.info(`距离下次回复还剩 ${triggerCount} 次`);
      return false;
    }
    return true;
  }
}

defineAccessor(SendQueue.prototype, "getQueue", ["queueManager", "getQueue"])
defineAccessor(SendQueue.prototype, "clearBySenderId", ["queueManager", "clearBySenderId"])
defineAccessor(SendQueue.prototype, "clearChannel", ["queueManager", "clearChannel"])
defineAccessor(SendQueue.prototype, "clearAll", ["queueManager", "clearAll"])
defineAccessor(SendQueue.prototype, "clearPrivateAll", ["queueManager", "clearPrivateAll"])
//defineAccessor(SendQueue.prototype, "addMessage", ["queueManager", "enqueue"])
