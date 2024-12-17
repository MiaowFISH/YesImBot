import { Context, Random } from "koishi";
import JSON5 from "json5";

import { Memory } from "./memory/memory";
import { Config } from "./config";
import { escapeUnicodeCharacters } from "./utils/string";
import { EmojiManager } from "./managers/emojiManager";
import { BaseAdapter, Usage } from "./adapters/base";
import { EmbeddingsBase } from "./embeddings/base";
import { AdapterSwitcher } from "./adapters";
import { getEmbedding } from "./utils/factory";
import { Message, SystemMessage } from "./adapters/creators/component";
import { ResponseVerifier } from "./utils/verifier";
import { SendQueue } from "./services/sendQueue";

export interface SuccessResponse {
  status: "success";
  finalReply: string;
  replyTo: string;
  quote: string;
  nextTriggerCount: number;
  logic: string;
  functions: Array<Function>;
  usage: Usage;
  adapterIndex: number;
}

export interface SkipResponse {
  status: "skip";
  nextTriggerCount: number;
  logic: string;
  functions: Array<Function>;
  usage: Usage;
  adapterIndex: number;
}

export interface FailedResponse {
  status: "fail";
  content: string;
  reason: string;
  usage: Usage;
  adapterIndex: number;
}

export class Bot {
  private memory: Memory;
  private memorySize: number;

  private summarySize: number; // 上下文达到多少时进行总结
  private contextSize: number; // 以对话形式给出的上下文长度
  private retainedContextSize: number; // 进行总结时保留的上下文长度，用于保持记忆连贯性

  private minTriggerCount: number;
  private maxTriggerCount: number;
  private allowErrorFormat: boolean;

  private history: Message[] = [];
  private prompt: string; // 系统提示词
  private tools: { [key: string]: (...args: any[]) => any };
  private messageQueue: SendQueue;

  private emojiManager: EmojiManager;
  private embedder: EmbeddingsBase;
  readonly verifier: ResponseVerifier;

  private adapterSwitcher: AdapterSwitcher;

  constructor(private ctx: Context, private config: Config) {
    this.minTriggerCount = config.MemorySlot.MinTriggerCount;
    this.maxTriggerCount = config.MemorySlot.MaxTriggerCount;
    this.allowErrorFormat = config.Settings.AllowErrorFormat;
    this.adapterSwitcher = new AdapterSwitcher(
      config.API.APIList,
      config.Parameters
    );
    if (config.Embedding.Enabled) {
      this.emojiManager = new EmojiManager(config.Embedding);
      this.embedder = getEmbedding(config.Embedding)
    };
    if (config.Verifier.Enabled) this.verifier = new ResponseVerifier(config);

    this.messageQueue = new SendQueue(ctx, config);

    this.tools = {
      insertArchivalMemory: this.insertArchivalMemory,
      searchArchivalMemory: this.searchArchivalMemory,
      appendCoreMemory: this.appendCoreMemory,
      modifyCoreMemory: this.modifyCoreMemory,
      searchConversation: this.searchConversation,
      searchConversationWithDate: this.searchConversationWithDate,
    }
  }

  updateConfig(config: Config) {
    this.config = config;
    this.adapterSwitcher.updateConfig(config.API.APIList, config.Parameters);
  }

  setSystemPrompt(content: string) {
    this.prompt = content;
  }

  setChatHistory(chatHistory: string) {
    this.history = [];
    for (const line of chatHistory.split("\n")) {
      this.history.push({ role: "user", content: line });
    }
  }

  async generateResponse(messages: Message[], debug = false): Promise< SuccessResponse | SkipResponse | FailedResponse> {
    let { current, adapter } = this.adapterSwitcher.getAdapter();

    if (!adapter) {
      throw new Error("没有可用的适配器");
    }

    this.history.push(...messages);

    const response = await adapter.chat([SystemMessage(this.prompt), ...this.history], debug);
    let content = response.message.content;

    if (typeof content !== "string") {
      content = JSON5.stringify(content, null, 2);
    }

    // TODO: 在这里指定 LLM 的回复格式，动态构建提示词

    let status: string = "success";
    let finalResponse: string = "";
    let finalLogic: string = "";
    let replyTo: string = "";
    let nextTriggerCount: number = Random.int(this.minTriggerCount, this.maxTriggerCount + 1); // 双闭区间
    let functions: Function[] = [];
    let reason: string;

    // 提取JSON部分
    const jsonMatch = content.match(/{.*}/s);
    let LLMResponse: any = {};

    if (jsonMatch) {
      try {
        LLMResponse = JSON5.parse(escapeUnicodeCharacters(jsonMatch[0]));
      } catch (e) {
        status = "fail";
        reason = `JSON 解析失败: ${e.message}`;
        if (debug) logger.warn(reason);
        return {
          status: "fail",
          content,
          usage: response.usage,
          reason,
          adapterIndex: current,
        };
      }
    } else {
      status = "fail"; // 没有找到 JSON
      reason = `没有找到 JSON: ${content}`;
      if (debug) logger.warn(reason);
      return {
        status: "fail",
        content,
        usage: response.usage,
        reason,
        adapterIndex: current,
      };
    }

    // 规范化 nextTriggerCount，确保在设置的范围内
    const nextTriggerCountbyLLM = Math.max(
      this.minTriggerCount,
      Math.min(LLMResponse.nextReplyIn ?? this.minTriggerCount, this.maxTriggerCount)
    );
    nextTriggerCount = Number(nextTriggerCountbyLLM) || nextTriggerCount;
    finalLogic = LLMResponse.logic || "";

    if (LLMResponse.functions && Array.isArray(LLMResponse.functions)) {
      functions = LLMResponse.functions;
    } else {
      functions = [];
    }

    // 检查 status 字段
    if (LLMResponse.status === "success") {
      status = LLMResponse.status;
    } else if (LLMResponse.status === "skip") {
      status = "skip";
      return {
        status: "skip",
        nextTriggerCount,
        logic: finalLogic,
        usage: response.usage,
        functions: LLMResponse.functions,
        adapterIndex: current,
      };
    } else if (LLMResponse.status === "function") {
      status = "function";
      let funcReturns: Message[] = [];
      for (const func of LLMResponse.functions) {
        const { name, params } = func;
        let returnValue = await this.callFunction(name, params);
        funcReturns.push({
          role: "assistant",
          content: JSON.stringify({
            status: "OK",
            name: name,
            result: returnValue,
            time: Date.now(),
          }),
        });
      }
      // 递归调用
      return await this.generateResponse(funcReturns, debug);
    } else {
      status = "fail";
      reason = `status 不是一个有效值: ${content}`;
      if (debug) logger.warn(reason);
      return {
        status: "fail",
        content,
        usage: response.usage,
        reason,
        adapterIndex: current,
      };
    }

    // 构建 finalResponse
    if (!this.allowErrorFormat) {
      if (LLMResponse.finalReply || LLMResponse.reply) {
        finalResponse += LLMResponse.finalReply || LLMResponse.reply || "";
      } else {
        status = "fail";
        reason = `回复格式错误: ${content}`;
        if (debug) logger.warn(reason);
        return {
          status: "fail",
          content,
          usage: response.usage,
          reason,
          adapterIndex: current,
        };
      }
    } else {
      finalResponse += LLMResponse.finalReply || LLMResponse.reply || "";
      // 兼容弱智模型的错误回复
      const possibleResponse = [
        LLMResponse.msg,
        LLMResponse.text,
        LLMResponse.message,
        LLMResponse.answer,
      ];
      for (const resp of possibleResponse) {
        if (resp) {
          finalResponse += resp || "";
          break;
        }
      }
    }

    // 提取其他字段
    replyTo = LLMResponse.replyTo || "";
    // 如果 replyTo 不是私聊会话，只保留数字部分
    if (replyTo && !replyTo.startsWith("private:")) {
      const numericMatch = replyTo.match(/\d+/);
      if (numericMatch) {
        replyTo = numericMatch[0].replace(/\s/g, "");
      }
    }

    // 反转义 <face> 消息
    const faceRegex = /\[表情[:：]\s*([^\]]+)\]/g;
    const matches = Array.from(finalResponse.matchAll(faceRegex));

    const replacements = await Promise.all(
      matches.map(async (match) => {
        const name = match[1];
        let id = await this.emojiManager.getIdByName(name);
        if (!id) {
          id = (await this.emojiManager.getIdByName(await this.emojiManager.getNameByTextSimilarity(name))) || "500";
        }
        return {
          match: match[0],
          replacement: `<face id="${id}" name="${(await this.emojiManager.getNameById(id)) || undefined}"></face>`,
        };
      })
    );

    replacements.forEach(({ match, replacement }) => {
      finalResponse = finalResponse.replace(match, replacement);
    });
    return {
      status: "success",
      finalReply: finalResponse,
      replyTo,
      quote: LLMResponse.quote || "",
      nextTriggerCount,
      logic: finalLogic,
      functions,
      usage: response.usage,
      adapterIndex: current,
    };
  }

  async summarize(channelId, userId, content) {}

  async callFunction(name: string, params: { [key: string]: any }): Promise<any> {
    const args = Object.values(params);
    //getFunction
    //bind args
    //call
    //add function return to history
  }

  // database
  // type: core / recall / archival
  //
  // ### Memory [last modified: ${DataModified}]
  // ${RecallMemorySize} previous messages between you and the user are stored in recall memory (use functions to access them)
  // ${ArchivalMemorySize} total memories you created are stored in archival memory (use functions to access them)

  // Core memory shown below (limited in size, additional information stored in archival / recall memory):
  // <persona characters="${Used}/${Total}">
  // </persona>
  // <human characters="${Used}/${Total}">
  //   <${UserName}>
  //   </${UserName}>
  //   <${UserName}>
  //   </${UserName}>
  // </human>

  async getCoreMemory(channelId, userId) {
    return `### Memory [last modified: 2024-12-16 12:48:37 PM 中国标准时间+0800]
4 previous messages between you and the user are stored in recall memory (use functions to access them)
0 total memories you created are stored in archival memory (use functions to access them)

Core memory shown below (limited in size, additional information stored in archival / recall memory):
<persona characters="1017/5000">
I am a personal assistant who answers a user's questions using Google web searches.
When a user asks me a question and the answer is not in my context, I will use a tool called google_search which will search the web and return relevant summaries and the link they correspond to.
It is my job to construct the best query to input into google_search based on the user's question, and to aggregate the response of google_search construct a final answer that also references the original links the information was pulled from.

Here is an example:
<example_question>
Who founded OpenAI?
</example_question>
<example_response>
OpenAI was founded by Ilya Sutskever, Greg Brockman, Trevor Blackwell, Vicki Cheung, Andrej Karpathy, Durk Kingma, Jessica Livingston, John Schulman, Pamela Vagata, and Wojciech Zaremba, with Sam Altman and Elon Musk serving as the initial Board of Directors members. ([Britannica](https://www.britannica.com/topic/OpenAI), [Wikipedia](https://en.wikipedia.org/wiki/OpenAI))
</example_response>
</persona>
<human characters="276/5000">
This is my section of core memory devoted to information about the human.
I don't yet know anything about them.
What's their name? Where are they from? What do they do? Who are they?
I should update this memory over time as I interact with the human and learn more about them.
</human>`
  }

  /**
   * Add to archival memory. Make sure to phrase the memory contents such that it can be easily queried later.
   * @param content Content to write to the memory. All unicode (including emojis) are supported.
   * @returns void
   */
  insertArchivalMemory(content: string): void {}

  /**
   * Search archival memory using semantic (embedding-based) search.
   * @param query String to search for.
   * @param page Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).
   * @param start Starting index for the search results. Defaults to 0.
   * @returns String[]
   */
  searchArchivalMemory(
    query: string,
    page: number = 0,
    start: number = 0
  ): string[] {
    return [];
  }

  /**
   * Append to the contents of core memory.
   * @param label Section of the memory to be edited (persona or human).
   *
   * @param content Content to write to the memory. All unicode (including emojis) are supported.
   * @returns void
   */
  appendCoreMemory(label: string, content: string): void {}

  /**
   * Replace the contents of core memory. To delete memories, use an empty string for newContent.
   * @param label
   * @param oldContent
   * @param newContent
   */
  modifyCoreMemory(label: string, oldContent: string, newContent: string): void {}

  /**
   * Search prior conversation history using case-insensitive string matching.
   * @param query String to search for.
   * @param userId  User ID to search for.
   * @param page Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).
   */
  searchConversation(
    query: string,
    userId?: string,
    page: number = 0
  ): string[] {
    return [];
  }

  /**
   * Search prior conversation history using a date range.
   * @param start The start of the date range to search, in the format 'YYYY-MM-DD'.
   * @param end The end of the date range to search, in the format 'YYYY-MM-DD'.
   * @param page Allows you to page through results. Only use on a follow-up query. Defaults to 0 (first page).
   */
  searchConversationWithDate(query: string, start: string, end: string, page: number) {}
}
